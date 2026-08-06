import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { JobApplicationDraft, JobPageSnapshot, JobQuestion, JobSource } from "./types.ts";

export interface BrowserFillResult {
  url: string;
  filled: string[];
  skipped: string[];
  screenshotPath?: string;
}

export interface BrowserSubmitResult {
  url: string;
  submittedAt: string;
  confirmationText: string;
}

export interface JobBrowser {
  inspect(url: string): Promise<JobPageSnapshot>;
  fill(url: string, draft: JobApplicationDraft): Promise<BrowserFillResult>;
  submit(url: string, draft: JobApplicationDraft): Promise<BrowserSubmitResult>;
}

function sourceFromUrl(url: string): JobSource {
  const host = new URL(url).hostname.toLowerCase();
  if (host.includes("linkedin.")) return "linkedin";
  if (host === "twitter.com" || host.endsWith(".twitter.com") || host === "x.com" || host.endsWith(".x.com")) return "twitter";
  return "generic";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Attaches the tailored resume PDF to visible file inputs (resume/cv-labelled first, else the only file input). */
async function attachResume(page: Page, draft: JobApplicationDraft): Promise<boolean> {
  if (!draft.resumePdfPath) return false;
  const inputs = page.locator('input[type="file"]');
  const count = await inputs.count();
  if (count === 0) return false;
  for (let index = 0; index < count; index += 1) {
    const input = inputs.nth(index);
    const descriptor = [
      await input.getAttribute("name").catch(() => ""),
      await input.getAttribute("id").catch(() => ""),
      await input.getAttribute("aria-label").catch(() => ""),
    ].join(" ").toLowerCase();
    if (/resume|cv|curriculum/.test(descriptor) || count === 1) {
      await input.setInputFiles(draft.resumePdfPath);
      return true;
    }
  }
  return false;
}

async function visibleText(page: Page, selectors: string[]): Promise<string> {
  const values = await page.locator(selectors.join(",")).allTextContents().catch(() => []);
  return values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean).sort((a, b) => b.length - a.length)[0] || "";
}

async function extractSnapshot(page: Page): Promise<JobPageSnapshot> {
  const url = page.url();
  const title = (await page.locator("h1").first().textContent().catch(() => ""))?.trim()
    || (await page.locator('meta[property="og:title"]').getAttribute("content").catch(() => ""))?.trim()
    || await page.title();
  const company = (await visibleText(page, ["[class*='company' i]", "[data-testid*='company' i]"]))
    .slice(0, 240);
  const description = (await visibleText(page, ["main article", "article", "[role='main']", "main", "body"]))
    .slice(0, 60_000);
  const questions = await page.locator("label").evaluateAll((labels) => labels.map((node, index) => {
    const label = node as HTMLLabelElement;
    const text = (label.textContent || "").replace(/\s+/g, " ").trim();
    const control = label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector("input, textarea, select");
    if (!text || !control) return null;
    const element = control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const kind = element.tagName === "TEXTAREA" ? "textarea" : element.tagName === "SELECT" ? ((element as HTMLSelectElement).multiple ? "multi" : "single") : element.type === "checkbox" ? "boolean" : "text";
    const options = element.tagName === "SELECT" ? Array.from((element as HTMLSelectElement).options).map((option) => option.textContent?.trim() || "").filter(Boolean) : undefined;
    return { id: element.id || element.name || `question-${index + 1}`, label: text, required: element.required, kind, ...(options?.length ? { options } : {}) };
  }).filter((item): item is JobQuestion => item !== null));
  return {
    url,
    title: title || "Untitled job",
    company: company || "Unknown company",
    description,
    questions,
    capturedAt: new Date().toISOString(),
  };
}

export class PlaywrightJobBrowser implements JobBrowser {
  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
  ) {}

  private async context(): Promise<BrowserContext> {
    await fs.mkdir(this.config.browserProfileDir, { recursive: true, mode: 0o700 });
    return chromium.launchPersistentContext(this.config.browserProfileDir, {
      headless: this.config.browserHeadless,
      viewport: { width: 1440, height: 1000 },
    });
  }

  async inspect(url: string): Promise<JobPageSnapshot> {
    const context = await this.context();
    try {
      const page = context.pages()[0] || await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const snapshot = await extractSnapshot(page);
      await this.activity.record("job.discovered", `Inspected ${snapshot.title}`, { url: snapshot.url, source: sourceFromUrl(url), descriptionHash: hash(snapshot.description), questions: snapshot.questions.length });
      return snapshot;
    } finally { await context.close(); }
  }

  async fill(url: string, draft: JobApplicationDraft): Promise<BrowserFillResult> {
    const context = await this.context();
    try {
      const page = context.pages()[0] || await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const filled: string[] = [];
      const skipped: string[] = [];
      for (const question of draft.posting.questions) {
        const answer = draft.answers[question.id] || draft.answers[question.label];
        if (!answer) { skipped.push(question.label); continue; }
        const control = page.getByLabel(question.label, { exact: false }).first();
        if (await control.count() === 0) { skipped.push(question.label); continue; }
        if (question.kind === "boolean") await control.setChecked(/^yes|true|y$/i.test(answer));
        else if (question.kind === "single" || question.kind === "multi") await control.selectOption({ label: answer });
        else await control.fill(answer);
        filled.push(question.label);
      }
      if (await attachResume(page, draft)) filled.push("resume upload");
      const screenshotPath = path.join(this.config.dataDir, "job-browser", `${draft.id}-filled.png`);
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true, mode: 0o700 });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await this.activity.record("job.filled", `Filled ${filled.length} application fields`, { applicationId: draft.id, skipped: skipped.length });
      return { url: page.url(), filled, skipped, screenshotPath };
    } finally { await context.close(); }
  }

  async submit(url: string, draft: JobApplicationDraft): Promise<BrowserSubmitResult> {
    const context = await this.context();
    try {
      const page = context.pages()[0] || await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      for (const question of draft.posting.questions) {
        const answer = draft.answers[question.id] || draft.answers[question.label];
        if (!answer) continue;
        const control = page.getByLabel(question.label, { exact: false }).first();
        if (await control.count() === 0) continue;
        if (question.kind === "boolean") await control.setChecked(/^yes|true|y$/i.test(answer));
        else if (question.kind === "single" || question.kind === "multi") await control.selectOption({ label: answer });
        else await control.fill(answer);
      }
      await attachResume(page, draft);
      const submit = page.getByRole("button", { name: /^(submit application|apply now|submit|send application)$/i }).first();
      if (await submit.count() !== 1) throw new Error("Could not identify exactly one final application button; no submission was made");
      await submit.click();
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
      const confirmationText = (await page.locator("body").innerText()).slice(0, 2_000);
      const submittedAt = new Date().toISOString();
      await this.activity.record("job.submitted", `Submitted application for ${draft.posting.title}`, { applicationId: draft.id, url: page.url() });
      return { url: page.url(), submittedAt, confirmationText };
    } finally { await context.close(); }
  }
}
