// Extended portfolio acceptance checks (spec-v2). Run: cd ~/dev/henry && node scripts/portfolio-verify.mjs
import { chromium } from "playwright";

const PAGE = "file:///Users/luvishgulati/dev/portfolio/index.html";
const results = [];
const ok = (n, v, extra = "") => results.push([n, !!v, extra]);
const browser = await chromium.launch();

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  const p = await ctx.newPage();
  p.__errors = [];
  p.on("pageerror", (e) => p.__errors.push(String(e)));
  p.on("console", (m) => m.type() === "error" && p.__errors.push(m.text()));
  await p.goto(PAGE, { waitUntil: "load" });
  return p;
}

/* ---- 1. both themes: zero console errors ---- */
for (const scheme of ["dark", "light"]) {
  const p = await newPage({ colorScheme: scheme });
  await p.waitForTimeout(800);
  await p.click("#tt");
  await p.waitForTimeout(400);
  await p.click("#tt");
  await p.waitForTimeout(400);
  ok(`zero console errors (${scheme} + toggled)`, p.__errors.length === 0, p.__errors.join(" | "));
  await p.context().close();
}

/* ---- 2. typing loop cycles 3 phrases cleanly ---- */
{
  const p = await newPage();
  const seen = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 22000 && seen.size < 3) {
    const t = await p.$eval("#typed", (e) => e.textContent);
    if (["I ship products.", "I build AI agents.", "I turn PRDs into repos."].includes(t)) seen.add(t);
    await p.waitForTimeout(120);
  }
  ok("typing loop cycles all 3 phrases", seen.size === 3, [...seen].join(" / "));
  ok("typing produces no errors", p.__errors.length === 0, p.__errors.join(" | "));
  await p.context().close();
}

/* ---- 3. count-ups fire once and land on true values ---- */
{
  const p = await newPage();
  await p.evaluate(() => document.querySelector(".stats").scrollIntoView());
  await p.waitForTimeout(2000);
  const vals = await p.$$eval("[data-count]", (els) => els.map((e) => [e.textContent, e.getAttribute("data-count"), e.dataset.done]));
  ok("count-ups reach target values", vals.every(([txt, tgt]) => txt === tgt), JSON.stringify(vals));
  ok("count-ups marked done (fire once)", vals.every(([, , d]) => d === "1"));
  // rescroll: values must not reset/re-animate
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await p.waitForTimeout(400);
  await p.evaluate(() => document.querySelector(".stats").scrollIntoView());
  await p.waitForTimeout(500);
  const again = await p.$$eval("[data-count]", (els) => els.map((e) => e.textContent));
  ok("count-ups stable on re-scroll", again.every((t, i) => t === vals[i][1]));
  await p.context().close();
}

/* ---- 4. marquee runs and pauses on hover ---- */
{
  const p = await newPage();
  await p.evaluate(() => document.querySelector(".marquee").scrollIntoView());
  await p.waitForTimeout(600);
  const running = await p.$eval(".mq-track", (e) => getComputedStyle(e).animationPlayState);
  await p.hover(".marquee");
  await p.waitForTimeout(300);
  const paused = await p.$eval(".mq-track", (e) => getComputedStyle(e).animationPlayState);
  ok("marquee animating by default", running === "running", running);
  ok("marquee pauses on hover", paused === "paused", paused);
  const dup = await p.$eval("#mq", (e) => e.children.length);
  ok("marquee track duplicated for seamless loop", dup === 2, `children=${dup}`);
  await p.context().close();
}

/* ---- 5. accordions + case expanders keyboard-operable ---- */
{
  const p = await newPage();
  const acc = await p.$(".acc-h");
  await acc.focus();
  await p.keyboard.press("Enter");
  await p.waitForTimeout(200);
  const openedEnter = await p.$eval(".acc-h", (e) => e.getAttribute("aria-expanded"));
  const panelVisible = await p.$eval("#d1", (e) => !e.hasAttribute("hidden"));
  await p.keyboard.press("Space");
  await p.waitForTimeout(200);
  const closedSpace = await p.$eval(".acc-h", (e) => e.getAttribute("aria-expanded"));
  ok("accordion opens with Enter (aria-expanded=true)", openedEnter === "true" && panelVisible);
  ok("accordion closes with Space", closedSpace === "false");

  const more = await p.$(".more");
  await more.focus();
  await p.keyboard.press("Enter");
  await p.waitForTimeout(200);
  const caseOpen = await p.$eval(".more", (e) => e.getAttribute("aria-expanded"));
  ok("case-study expander keyboard-operable", caseOpen === "true");

  // tabs: arrow keys + panel swap
  await p.click("#tb-2");
  await p.waitForTimeout(200);
  const archVisible = await p.$eval("#tp-2", (e) => !e.hasAttribute("hidden"));
  const decHidden = await p.$eval("#tp-1", (e) => e.hasAttribute("hidden"));
  await p.focus("#tb-2");
  await p.keyboard.press("ArrowRight");
  await p.waitForTimeout(200);
  const third = await p.$eval("#tb-3", (e) => e.getAttribute("aria-selected"));
  ok("architecture tab reveals diagram", archVisible && decHidden);
  ok("tabs support arrow-key navigation", third === "true");
  ok("no errors during interaction", p.__errors.length === 0, p.__errors.join(" | "));
  await p.context().close();
}

/* ---- 6. reduced motion: static + complete ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto(PAGE, { waitUntil: "load" });
  await p.waitForTimeout(1200);
  const typed = await p.$eval("#typed", (e) => e.textContent);
  const hiddenLines = await p.$$eval(".t-line.hid", (e) => e.length);
  const revealed = await p.$$eval(".reveal", (els) => els.every((e) => getComputedStyle(e).opacity === "1"));
  const counts = await p.$$eval("[data-count]", (els) => els.every((e) => e.textContent === e.getAttribute("data-count")));
  const mqAnim = await p.$eval(".mq-track", (e) => getComputedStyle(e).animationName);
  const orbAnim = await p.$eval(".orb.a", (e) => getComputedStyle(e).animationName);
  ok("reduced-motion: typing static with full phrase", typed === "I ship products.", typed);
  ok("reduced-motion: terminal transcript complete", hiddenLines === 0, `hidden=${hiddenLines}`);
  ok("reduced-motion: all reveals visible", revealed);
  ok("reduced-motion: counts at final values", counts);
  ok("reduced-motion: marquee + orbs not animating", mqAnim === "none" && orbAnim === "none", `${mqAnim}/${orbAnim}`);
  ok("reduced-motion: zero errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

/* ---- 7. mobile 390: no horizontal scroll anywhere, incl. expanded state ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto(PAGE, { waitUntil: "load" });
  await p.waitForTimeout(900);
  const base = await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  await p.evaluate(() => {
    document.querySelectorAll(".acc-h, .more").forEach((b) => b.click());
  });
  await p.click("#tb-2");
  await p.waitForTimeout(400);
  const expanded = await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  const offenders = await p.evaluate(() => {
    const w = document.documentElement.clientWidth;
    return [...document.querySelectorAll("body *")]
      .filter((e) => e.getBoundingClientRect().right > w + 1)
      .slice(0, 6)
      .map((e) => e.className || e.tagName);
  });
  ok("mobile 390: no h-scroll (default)", base);
  ok("mobile 390: no h-scroll (all expanded + arch tab)", expanded, JSON.stringify(offenders));
  ok("mobile: zero errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

/* ---- 8. dossier links verbatim + meta intact ---- */
{
  const p = await newPage();
  const need = [
    "https://github.com/Luvishgulati03/ai-agent-",
    "https://github.com/Luvishgulati03/luvish-ai-twin-recruiters",
    "https://github.com/Luvishgulati03/risk-council-final-iterATION-",
    "https://github.com/Luvishgulati03/carbonnex-website",
    "https://github.com/Luvishgulati03/Compiler-Project",
    "https://github.com/Luvishgulati03",
    "https://www.linkedin.com/in/luvish-gulati-282a84184",
    "mailto:Gulatiluvish@gmail.com",
  ];
  const hrefs = await p.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
  const missing = need.filter((n) => !hrefs.includes(n));
  ok("all dossier links present verbatim", missing.length === 0, missing.join(", "));
  const meta = await p.evaluate(() => ({
    og: document.querySelector('meta[property="og:image"]')?.content,
    canonical: document.querySelector('link[rel="canonical"]')?.href,
    ld: !!document.querySelector('script[type="application/ld+json"]'),
    ldValid: (() => { try { JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent); return true; } catch { return false; } })(),
  }));
  ok("OG image → assets/og.png", meta.og === "https://luvishgulati03.github.io/assets/og.png", meta.og);
  ok("canonical present", meta.canonical === "https://luvishgulati03.github.io/", meta.canonical);
  ok("JSON-LD present and parses", meta.ld && meta.ldValid);
  await p.context().close();
}

await browser.close();
let failed = 0;
for (const [n, v, extra] of results) {
  if (!v) failed++;
  console.log(`${v ? "PASS" : "FAIL"}  ${n}${!v && extra ? "  →  " + extra : ""}`);
}
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
