#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { HenryRuntime } from "./runtime.ts";
import { startDashboard } from "./dashboard/server.ts";
import { writeCronFile, writeLaunchdPlist } from "./scheduler/install.ts";
import { parseAt, parseIn, type ReminderKind } from "./reminders/service.ts";
import { startReminderTicker, type ReminderTickerHandle } from "./reminders/ticker.ts";
import { sendTelegram } from "./notify/telegram.ts";
import { createInputQueue } from "./repl/input-queue.ts";
import { trackerSummary } from "./mailwatch/tracker.ts";

const args = process.argv.slice(2);

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function restAfter(command: string): string[] {
  const index = args.indexOf(command);
  return index < 0 ? [] : args.slice(index + 1).filter((item, itemIndex, values) => {
    const previous = values[itemIndex - 1];
    return previous !== "--repo" && previous !== "--cwd" && previous !== "--provider";
  });
}

function print(value: unknown): void {
  if (typeof value === "string") console.log(value); else console.log(JSON.stringify(value, null, 2));
}

const REPL_HELP = ":status  :dashboard  :memory <query>  :provider [codex|claude]  :quit";

/**
 * Dad's rule: the dashboard comes up with every interactive Henry, not just `henry dashboard`.
 * It must never take the REPL down with it. `startDashboard` throws synchronously on a bad
 * remote-host config, and `server.listen` emits EADDRINUSE asynchronously when a second Henry
 * (or the scheduler daemon) already holds the port — with no handler that's an uncaught
 * exception. Both degrade to one printed line here. `HENRY_NO_DASHBOARD=1` opts out entirely.
 */
function startDashboardBeside(runtime: HenryRuntime): void {
  if (process.env.HENRY_NO_DASHBOARD === "1") return;
  const url = `http://${runtime.config.host}:${runtime.config.port}`;
  try {
    const server = startDashboard(runtime);
    server.on("listening", () => console.log(`Henry dashboard: ${url}`));
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") console.log(`Henry dashboard: ${url} (already running — reusing it)`);
      else console.log(`Henry dashboard unavailable: ${error.message}`);
    });
  } catch (error) {
    console.log(`Henry dashboard unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Friday-style buffer-and-drain REPL: while an agent turn is in flight (queue.busy), new
 * lines are buffered instead of racing it. Only `:help`/`:dashboard` are "trivially safe"
 * enough to answer instantly even while busy — everything else (including `:status`/
 * `:memory`/`:provider`) buffers as raw text and, on drain, is sent to the agent as one
 * combined turn (the pure buffering logic lives in `src/repl/input-queue.ts`, testable
 * without readline).
 */
async function repl(runtime: HenryRuntime, reminderTicker?: ReminderTickerHandle, setRedraw?: (fn: () => void) => void): Promise<void> {
  const rl = readline.createInterface({ input, output, prompt: "henry> " });
  // Reminders fired by the in-process ticker print here, above the prompt.
  let rlClosed = false;
  rl.once("close", () => { rlClosed = true; });
  const safePrompt = (preserve = false): void => { if (!rlClosed) rl.prompt(preserve); };
  setRedraw?.(() => safePrompt(true));
  console.log("Henry is ready, Dad. Type :help for commands or ask normally.\n");

  const queue = createInputQueue();
  let quitting = false;

  async function runAgentTurn(value: string, label?: string): Promise<void> {
    // Streaming display (latency plan #1/#6): print provider text as it
    // arrives; the spinner shows elapsed seconds until the first token lands.
    const started = Date.now();
    let streamedChars = 0;
    // The spinner's \r-rewrite and readline's echo fight over the same terminal
    // line — typing mid-think LOOKED dead (input visually erased every second)
    // even though the queue captured it. Truce: on the user's first keypress the
    // spinner goes silent for the rest of the run and the line is handed back as
    // a preserved `henry> ` prompt, so queueing is visible while Henry thinks.
    let userTyping = false;
    const onKeypress = (_ch: unknown, key: { name?: string } | undefined): void => {
      if (userTyping || key?.name === "return" || key?.name === "enter") return;
      userTyping = true;
      setImmediate(() => { process.stdout.write("\r" + " ".repeat(28) + "\r"); safePrompt(true); });
    };
    input.on("keypress", onKeypress);
    const spinner = setInterval(() => {
      if (streamedChars === 0 && !userTyping) process.stdout.write(`\rhenry is thinking… ${Math.round((Date.now() - started) / 1000)}s `);
    }, 1000);
    process.stdout.write("henry is thinking… ");
    try {
      const result = await runtime.agent.run(value, { surface: "repl",
        onEvent: (event) => {
          const text = event.parsed && typeof (event.parsed as Record<string, unknown>).text === "string"
            ? String((event.parsed as Record<string, unknown>).text)
            : undefined;
          if (!text?.trim()) return;
          if (streamedChars === 0) {
            // If the user owns the line, keep their draft intact above and stream below.
            process.stdout.write(userTyping ? "\n" : "\r" + " ".repeat(28) + "\r");
            if (label) console.log(label);
          }
          process.stdout.write(text.endsWith("\n") ? text : text + "\n");
          streamedChars += text.length;
        },
      });
      if (streamedChars === 0) {
        process.stdout.write("\r" + " ".repeat(28) + "\r");
        if (label) console.log(label);
        print(result.response);
      } else if (result.response.length > streamedChars + 80) {
        // The final joined response contained more than what streamed — print the remainder context safely.
        console.log();
      }
    } catch (error) {
      console.log();
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      clearInterval(spinner);
      input.removeListener("keypress", onKeypress);
    }
  }

  // Ends the current run; if lines queued up while it was thinking, drains them into ONE
  // combined follow-up turn (recursing until the queue is empty), then prompts or exits.
  async function afterRun(): Promise<void> {
    const drained = queue.finish();
    if (drained) {
      const label = drained.count > 1 ? `(answering ${drained.count} queued messages)` : undefined;
      queue.start();
      await runAgentTurn(drained.combined, label);
      await afterRun();
      return;
    }
    if (quitting) { rl.close(); return; }
    safePrompt();
  }

  safePrompt();
  rl.on("line", (line) => {
    const value = line.trim();
    if (quitting) return; // ignore stray input after :quit was requested
    if (!value) { safePrompt(queue.busy); return; }

    if (queue.busy) {
      if (value === ":help") { console.log(REPL_HELP); safePrompt(true); return; }
      if (value === ":queue") {
        console.log(queue.length ? queue.pending().map((l, i) => `\x1b[2m ${i + 1}. ${l}\x1b[0m`).join("\n") : "\x1b[2mqueue empty\x1b[0m");
        safePrompt(true);
        return;
      }
      if (value === ":dashboard") { console.log(`Dashboard: http://${runtime.config.host}:${runtime.config.port}`); safePrompt(true); return; }
      if (value === ":quit" || value === ":exit") {
        quitting = true;
        console.log("finishing current reply, then exiting…");
        return;
      }
      const count = queue.push(value);
      console.log(`\x1b[2m⏳ queued (${count}) — henry is still thinking\x1b[0m`);
      safePrompt(true);
      return;
    }

    if (value === ":quit" || value === ":exit") { rl.close(); return; }
    void (async () => {
      try {
        if (value === ":help") { console.log(REPL_HELP); safePrompt(); return; }
        if (value === ":dashboard") { console.log(`Dashboard: http://${runtime.config.host}:${runtime.config.port}`); safePrompt(); return; }
        if (value === ":status") { print(await runtime.status()); safePrompt(); return; }
        if (value.startsWith(":memory ")) { print(await runtime.memory.recall(value.slice(8))); safePrompt(); return; }
        if (value === ":provider") { console.log(`Primary provider: ${runtime.config.provider}`); safePrompt(); return; }
        if (value.startsWith(":provider ")) { console.log(`Primary provider set to ${await runtime.setProvider(value.slice(10).trim() as "codex" | "claude")}`); safePrompt(); return; }
        queue.start();
        await runAgentTurn(value);
        await afterRun();
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        safePrompt();
      }
    })();
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      reminderTicker?.stop(); // never let the poll interval keep the process alive after the REPL exits
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const command = args[0] || "repl";
  const runtime = await HenryRuntime.create();
  let keepAlive = false;
  try {
    if (command === "ask") {
      const prompt = args.slice(1).filter((item) => !item.startsWith("--")).join(" ");
      if (!prompt) throw new Error("Usage: henry ask <prompt>");
      print((await runtime.agent.run(prompt, { surface: "repl", provider: option("--provider") as "codex" | "claude" | undefined })).response);
    } else if (command === "jd") {
      // JD → tailored resume PDF (formatting locked) + cover letter, one folder.
      const filePath = option("--file");
      let jdText = filePath ? await fs.readFile(filePath, "utf8") : args.slice(1).filter((a) => !a.startsWith("--") && a !== filePath).join(" ");
      if (jdText.trim().length < 80) {
        console.log("Paste the job description below, then a line containing only END:");
        jdText = await new Promise<string>((resolve) => {
          const rl = readline.createInterface({ input });
          const buffer: string[] = [];
          rl.on("line", (line) => { if (line.trim() === "END") rl.close(); else buffer.push(line); });
          rl.on("close", () => resolve(buffer.join("\n")));
        });
      }
      console.log("tailoring resume + writing cover letter… (this takes a minute or two)");
      const out = await runtime.tailor.run(jdText);
      console.log(`\n${out.role} at ${out.company}`);
      for (const change of out.changes) console.log(`  · ${change}`);
      console.log(`\nresume: ${out.resumePdf}\ncover:  ${out.coverPdf}`);
      const { spawn } = await import("node:child_process");
      spawn("open", [out.dir], { stdio: "ignore" }).once("error", () => {});
    } else if (command === "repl") {
      keepAlive = true;
      startDashboardBeside(runtime);
      let redrawPrompt: () => void = () => {};
      const ticker = startReminderTicker(runtime.reminders, runtime.activity, {
        role: "repl",
        // Terminal delivery PLUS system banner + telegram: prints in the REPL above
        // the prompt, and also fires the composed operator notifier.
        notify: async (message, title) => {
          process.stdout.write(`\n\u{1F514} ${message}\n`);
          redrawPrompt();
          void runtime.notifyOperator(message, title).catch(() => undefined);
        },
        promptRunner: (prompt) => runtime.agent.run(prompt).then((result) => result.response),
        executeApproval: (approvalId) => runtime.executeApproval(approvalId),
      });
      await repl(runtime, ticker, (fn) => { redrawPrompt = fn; });
    } else if (command === "dashboard") {
      startDashboard(runtime); keepAlive = true;
      startReminderTicker(runtime.reminders, runtime.activity, {
        role: "dashboard",
        notify: runtime.notifyOperator,
        promptRunner: (prompt) => runtime.agent.run(prompt).then((result) => result.response),
        executeApproval: (approvalId) => runtime.executeApproval(approvalId),
      });
      console.log(`Henry dashboard: http://${runtime.config.host}:${runtime.config.port}`);
    } else if (command === "status") {
      print(await runtime.status());
    } else if (command === "memory") {
      const sub = args[1] || "search";
      if (sub === "search") print(await runtime.memory.recall(args.slice(2).join(" ")));
      else if (sub === "remember") print(await runtime.memory.remember(args.slice(2).join(" ")));
      else if (sub === "index") print(await runtime.memory.index(args.includes("--fresh")));
      else if (sub === "graph") print(runtime.memory.graph());
      else if (sub === "dream") print(await runtime.memory.dream());
      else throw new Error("Usage: henry memory search|remember|index|graph|dream");
    } else if (command === "code" || command === "task") {
      const task = restAfter(command).filter((item) => !item.startsWith("--")).join(" ");
      if (!task) throw new Error("Usage: henry code <task> [--cwd /path/to/repository]");
      print((await runtime.task(task, option("--cwd"))).response);
    } else if (command === "provider") {
      const target = args[1];
      if (!target) print({ provider: runtime.config.provider });
      else print({ provider: await runtime.setProvider(target as "codex" | "claude") });
    } else if (command === "jobs") {
      const sub = args[1] || "list";
      if (sub === "inspect") {
        if (!args[2]) throw new Error("Usage: henry jobs inspect <url>");
        print(await runtime.jobs.inspect(args[2]));
      } else if (sub === "prepare") {
        if (!args[2]) throw new Error("Usage: henry jobs prepare <url>");
        const draft = await runtime.jobs.prepare(args[2]);
        print({
          applicationId: draft.id, status: draft.status, approvalId: draft.approvalId,
          resumePdf: draft.resumePdfPath, missingFacts: draft.missingFacts,
          next: `Review it, then: henry approve approve ${draft.approvalId} && henry approve send ${draft.approvalId}`,
        });
      } else if (sub === "list") {
        print({ summary: await runtime.jobs.store.summary(), applications: (await runtime.jobs.store.list()).map((item) => ({ id: item.id, title: item.posting.title, company: item.posting.company, status: item.status, approvalId: item.approvalId })) });
      } else if (sub === "fill") {
        if (!args[2]) throw new Error("Usage: henry jobs fill <application-id>");
        print(await runtime.jobs.fill(args[2]));
      } else throw new Error("Usage: henry jobs inspect <url>|prepare <url>|list|fill <application-id>  (submission goes through henry approve)");
    } else if (command === "cover") {
      const sub = args[1];
      if (sub === "import") {
        if (!args[2]) throw new Error("Usage: henry cover import <path-to-resume.docx|.md|.txt>");
        print({ resumePath: await runtime.cover.importResume(args[2]) });
      } else {
        const input = args.slice(1).filter((item) => !item.startsWith("--")).join(" ");
        if (!input) throw new Error("Usage: henry cover <job-url | jd-file | jd-text>  (or: henry cover import <resume-file>)");
        print(await runtime.cover.generate(input));
      }
    } else if (command === "resume") {
      const sub = args[1];
      if (sub === "edit") {
        const instructions = args.slice(2).filter((item) => !item.startsWith("--")).join(" ");
        if (!instructions) throw new Error("Usage: henry resume edit <instructions...>");
        print(await runtime.resumeEditor.edit(instructions));
      } else if (sub === "promote") {
        if (!args[2]) throw new Error("Usage: henry resume promote <markdown-path>");
        print({ resumePath: await runtime.resumeEditor.promote(args[2]) });
      } else if (sub === "show") {
        const text = await fs.readFile(runtime.config.resumeSourcePath, "utf8").catch(() => "");
        print({ resumePath: runtime.config.resumeSourcePath, preview: text.split(/\r?\n/).slice(0, 10).join("\n") });
      } else throw new Error("Usage: henry resume edit <instructions...>|promote <markdown-path>|show");
    } else if (command === "meetings") {
      const sub = args[1];
      if (sub === "shadow") {
        if (!args[2]) throw new Error("Usage: henry meetings shadow <audio-file> [--title t]");
        print(await runtime.meetings.process(args[2], option("--title")));
      } else throw new Error("Usage: henry meetings shadow <audio-file> [--title t]");
    } else if (command === "screenshots") {
      const sub = args[1] || "backlog";
      if (sub === "backlog") print(await runtime.screenshots.sortBacklog(Number(option("--limit")) || 20));
      else if (sub === "sort") { if (!args[2]) throw new Error("Usage: henry screenshots sort <image-path>"); print(await runtime.screenshots.sortOne(args[2])); }
      else if (sub === "watch") { const close = await runtime.screenshots.watch(); keepAlive = true; console.log("Watching for screenshots. Ctrl+C to stop."); process.once("SIGINT", () => { close(); process.exit(0); }); }
      else throw new Error("Usage: henry screenshots backlog|sort <path>|watch");
    } else if (command === "knowledge") {
      const { KnowledgeBase } = await import("./knowledge/store.ts");
      const kb = new KnowledgeBase(runtime.config);
      try {
        const sub = args[1] || "stats";
        if (sub === "export") {
          const { exportOrgKnowledge } = await import("./knowledge/adapters/org-mongo.ts");
          print(await exportOrgKnowledge(path.join(runtime.config.knowledgeDir, "raw")));
        } else if (sub === "index") {
          const { KnowledgeIngestor } = await import("./knowledge/ingest.ts");
          print(await new KnowledgeIngestor(runtime.config, runtime.activity, kb, runtime.agent.providerRunner).ingestRaw({ limit: Number(option("--limit")) || undefined }));
        } else if (sub === "distill") {
          const { KnowledgeIngestor } = await import("./knowledge/ingest.ts");
          print(await new KnowledgeIngestor(runtime.config, runtime.activity, kb, runtime.agent.providerRunner).ingestCards({ limit: Number(option("--limit")) || 3 }));
        } else if (sub === "add") {
          const target = args[2];
          if (!target) throw new Error("Usage: henry knowledge add <path> [--domain gtm|growth-strategy|product-management|software-development|community|sales|careers|general] [--name <batch-name>] [--distill]");
          const { importKnowledge } = await import("./knowledge/importer.ts");
          const { KNOWLEDGE_DOMAINS } = await import("./knowledge/store.ts");
          const domainArg = option("--domain");
          if (domainArg && !KNOWLEDGE_DOMAINS.includes(domainArg as (typeof KNOWLEDGE_DOMAINS)[number])) {
            throw new Error(`Unknown domain "${domainArg}". Choose one of: ${KNOWLEDGE_DOMAINS.join(", ")}`);
          }
          const distill = args.includes("--distill");
          const report = await importKnowledge(runtime.config, kb, [target], {
            domain: domainArg as (typeof KNOWLEDGE_DOMAINS)[number] | undefined,
            sourceName: option("--name"),
            distill,
            runner: distill ? runtime.agent.providerRunner : undefined,
          });
          print(report);
          console.log(distill
            ? "\n--distill spent provider calls to generate strategy cards."
            : "\nRaw indexing above used local embeddings only (free). Pass --distill to also generate strategy cards — that spends provider calls.");
        } else if (sub === "search") {
          const query = args.slice(2).filter((item) => !item.startsWith("--") && item !== option("--domain")).join(" ");
          if (!query) throw new Error("Usage: henry knowledge search <query> [--domain gtm]");
          print((await kb.recall(query, { domain: option("--domain") })).map((r) => ({ score: r.score, source: r.source, content: r.content.slice(0, 200) })));
        } else if (sub === "context") {
          print(await kb.context(args.slice(2).join(" "), { domain: option("--domain") }));
        } else if (sub === "eval") {
          const { runKnowledgeEval, formatEvalReport } = await import("./metrics/eval.ts");
          const report = await runKnowledgeEval(runtime.config, kb);
          console.log(formatEvalReport(report));
          console.log(`\nWrote ${path.join(path.dirname(runtime.config.evalPath), "last-run.json")}`);
        } else if (sub === "stats") {
          print(kb.stats());
        } else throw new Error("Usage: henry knowledge export|index|distill|add|search|context|eval|stats");
      } finally { kb.close(); }
    } else if (command === "dispatch") {
      const role = args[1] || "architect";
      const task = args.slice(2).filter((item) => item !== "--edit").join(" ");
      if (!task) throw new Error("Usage: henry dispatch <role> <task>");
      print((await runtime.luna.dispatch(role, task, { allowEdits: args.includes("--edit") })).response);
    } else if (command === "gmail") {
      const sub = args[1] || "inbox";
      if (sub === "auth") { await runtime.gmail.authorize(); console.log("Gmail connected."); }
      else if (sub === "inbox") print(await runtime.gmail.inbox(Number(option("--limit") || 10)));
      else if (sub === "send" || sub === "draft" || sub === "reply") {
        const to = option("--to"); const subject = option("--subject"); const body = option("--body") || args.slice(2).filter((item) => !item.startsWith("--") && item !== to && item !== subject).join(" ");
        if (!to || !subject || !body) throw new Error("Usage: henry gmail draft --to email --subject subject --body body");
        const item = await runtime.gmail.queueEmail({ to, subject, body, threadId: option("--thread-id") });
        print({ message: "Saved locally and queued for Dad's approval", approvalId: item.id, dashboard: `http://${runtime.config.host}:${runtime.config.port}` });
      } else if (sub === "draftreplies") {
        const limit = Number(option("--limit")) || 5;
        const result = await runtime.draftReplies.draftReplies(limit);
        print({
          drafted: result.drafted,
          skipped: result.skipped,
          localPath: result.localPath,
          message: result.drafted.length ? `Drafted ${result.drafted.length} replies — review in Gmail drafts` : "No replies needed",
        });
      } else throw new Error("Usage: henry gmail auth|inbox|draft|reply|draftreplies");
    } else if (command === "review") {
      const target = args[1];
      if (!target) throw new Error("Usage: henry review <pr-number-or-url> [--cwd path] [--repo owner/name]");
      const cwd = option("--cwd") || (option("--repo")?.startsWith("/") ? option("--repo") : runtime.config.rootDir) || runtime.config.rootDir;
      const repo = option("--repo")?.startsWith("/") ? undefined : option("--repo");
      print(await runtime.reviewer.review(target, path.resolve(cwd), repo));
    } else if (command === "approve") {
      const sub = args[1] || "list";
      if (sub === "list") print(await runtime.approvals.list());
      else if (sub === "approve") { if (!args[2]) throw new Error("Usage: henry approve approve <id>"); await runtime.approve(args[2]); console.log(`Approved ${args[2]}`); }
      else if (sub === "send" || sub === "execute") {
        if (!args[2]) throw new Error("Usage: henry approve send <id>");
        const item = await runtime.approvals.get(args[2]);
        if (!item) throw new Error("Approval not found");
        if (item.status !== "approved") {
          throw new Error(
            `Sending is blocked: approval ${args[2]} is ${item.status}. Run 'henry approve approve ${args[2]}' first; sending never approves implicitly.`,
          );
        }
        print(await runtime.executeApproval(args[2]));
      }
      else throw new Error("Usage: henry approve list|approve|send <id>");
    } else if (command === "schedule") {
      const sub = args[1] || "list";
      if (sub === "list") print(await runtime.scheduler.definitions());
      else if (sub === "run") { const id = args[2]; const definition = (await runtime.scheduler.definitions()).find((item) => item.id === id); if (!definition) throw new Error(`Workflow not found: ${id}`); print(await runtime.scheduler.run(definition)); }
      else if (sub === "daemon") {
        // One daemon serves both engines: legacy JSON kinds and markdown workflows.
        await runtime.scheduler.start();
        const armed = await runtime.workflowEngine.start();
        keepAlive = true;
        console.log(`Henry scheduler is running (${armed.length} markdown workflow schedules armed). Press Ctrl+C to stop.`);
      }
      else if (sub === "install") { const definitions = await runtime.scheduler.definitions(); print({ cron: await writeCronFile(runtime.config, definitions), launchd: await writeLaunchdPlist(runtime.config, definitions), note: "Review the generated files before installing them into your user scheduler." }); }
      else throw new Error("Usage: henry schedule list|run <id>|daemon|install");
    } else if (command === "workflow") {
      const sub = args[1] || "list";
      if (sub === "list") {
        const workflows = await runtime.workflowEngine.load();
        print(workflows.map((workflow) => ({
          name: workflow.name,
          enabled: workflow.enabled,
          description: workflow.description,
          triggers: workflow.triggers.map((trigger) => trigger.type === "schedule" ? `schedule ${trigger.cron}${trigger.timezone ? ` ${trigger.timezone}` : ""}` : `command ${trigger.command}`),
          output: workflow.outputs.find((output) => output.type === "docs")?.path,
        })));
        const problems = runtime.workflowEngine.registry.problems();
        if (Object.keys(problems).length) print({ invalid: problems });
      } else if (sub === "show") {
        if (!args[2]) throw new Error("Usage: henry workflow show <name>");
        await runtime.workflowEngine.load();
        const workflow = runtime.workflowEngine.get(args[2]);
        if (!workflow) throw new Error(`Workflow not found: ${args[2]}`);
        print(workflow);
      } else if (sub === "run") {
        if (!args[2]) throw new Error("Usage: henry workflow run <name>");
        print(await runtime.workflowEngine.run(args[2], "cli"));
      } else if (sub === "logs") {
        if (!args[2]) throw new Error("Usage: henry workflow logs <name>");
        const artifacts = await runtime.workflowEngine.artifacts(args[2]);
        print({ workflow: args[2], runs: artifacts });
        if (artifacts[0]) { console.log(`\n--- ${artifacts[0]} ---\n`); console.log(await fs.readFile(artifacts[0], "utf8")); }
      } else if (sub === "daemon") {
        const armed = await runtime.workflowEngine.start();
        keepAlive = true;
        print({ armed });
        console.log("Henry workflow engine is running. Press Ctrl+C to stop.");
      } else throw new Error("Usage: henry workflow list|show <name>|run <name>|logs <name>|daemon");
    } else if (command === "goal") {
      const description = args.slice(1).filter((item) => !item.startsWith("--")).join(" ");
      if (!description) throw new Error("Usage: henry goal <description...>");
      const { filePath, raw } = await runtime.goals.intake(description);
      console.log(raw);
      console.log(`\nSaved plan: ${filePath}`);
      console.log("Dad reviews this plan, then uses `henry code`/`henry dispatch` (or asks Henry to proceed) — nothing here was auto-executed.");
    } else if (command === "remind") {
      const sub = args[1];
      if (sub === "list") {
        print((await runtime.reminders.list()).map((item) => ({
          id: item.id, text: item.text, kind: item.kind, dueAt: item.dueAt, cron: item.cron,
          randomDaily: item.randomDaily, nextFireAt: item.nextFireAt, approvalId: item.approvalId, status: item.status,
        })));
      } else if (sub === "cancel") {
        if (!args[2]) throw new Error("Usage: henry remind cancel <id>");
        print(await runtime.reminders.cancel(args[2]));
      } else {
        const executeApprovalId = option("--execute-approval");
        const at = option("--at");
        const inValue = option("--in");
        const every = option("--every");
        const randomDailyValue = option("--random-daily");
        if (executeApprovalId) {
          if (every) throw new Error("henry remind --execute-approval does not support --every — a scheduled send is one-shot, never recurring.");
          if (!at && !inValue) throw new Error('Usage: henry remind --execute-approval <approvalId> --at "YYYY-MM-DD HH:mm" | --in "2h"');
          const dueAt = at ? parseAt(at) : parseIn(inValue!);
          const reminder = await runtime.reminders.createApprovalExecute(executeApprovalId, dueAt, option("--title"));
          print({ id: reminder.id, text: reminder.text, kind: reminder.kind, approvalId: reminder.approvalId, dueAt: reminder.dueAt, status: reminder.status });
        } else {
          const promptText = option("--prompt");
          const text = promptText || (sub && !sub.startsWith("--") ? sub : undefined);
          const kind: ReminderKind = promptText ? "prompt" : "message";
          const usage = 'Usage: henry remind "<text>" --at "YYYY-MM-DD HH:mm" | --in "2h" | --every "<cron>" | --random-daily 5  (or: henry remind --prompt "<instruction>" --at|--in|--every|--random-daily ...)';
          if (!text || (!at && !inValue && !every && !randomDailyValue)) throw new Error(usage);
          if (randomDailyValue && (at || inValue || every)) throw new Error("--random-daily cannot be combined with --at, --in, or --every");
          const randomCount = randomDailyValue ? Number(randomDailyValue) : undefined;
          if (randomDailyValue && (randomCount === undefined || !Number.isInteger(randomCount) || randomCount < 1)) throw new Error("--random-daily requires a positive integer count");
          const reminder = randomDailyValue
            ? await runtime.reminders.createRandomDaily(text, randomCount, kind)
            : every
              ? await runtime.reminders.createRecurring(text, every, kind)
              : await runtime.reminders.create(text, at ? parseAt(at) : parseIn(inValue!), kind);
          print({ id: reminder.id, text: reminder.text, kind: reminder.kind, dueAt: reminder.dueAt, cron: reminder.cron, nextFireAt: reminder.nextFireAt, status: reminder.status });
        }
      }
    } else if (command === "telegram") {
      const sub = args[1] || "test";
      if (sub === "test") {
        const ok = await sendTelegram(runtime.config, "Henry → Telegram is live 🎉");
        console.log(ok ? "ok — check your Telegram chat" : "fail — check HENRY_TELEGRAM_BOT_TOKEN / HENRY_TELEGRAM_CHAT_ID in .env, then see docs/modules/telegram.md");
      } else throw new Error("Usage: henry telegram test");
    } else if (command === "mailwatch") {
      const sub = args[1] || "check";
      if (sub === "check") print(await runtime.mailwatch.check());
      else if (sub === "status") print(await runtime.mailwatch.status());
      else if (sub === "tracker") {
        const summary = await trackerSummary(runtime.config);
        console.log(`Job tracker: ${summary.markdownPath} (${summary.total} application${summary.total === 1 ? "" : "s"})`);
        print(summary);
      } else if (sub === "backfill") {
        const days = Number(option("--days")) || 30;
        print(await runtime.mailwatch.backfill(days));
      } else throw new Error("Usage: henry mailwatch check|status|tracker|backfill --days <n>");
    } else if (command === "linkedin") {
      const topic = args.slice(1).filter((item) => !item.startsWith("--")).join(" ");
      if (!topic) throw new Error("Usage: henry linkedin <topic...>");
      const result = await runtime.linkedin.draft(topic);
      console.log(result.draft);
      console.log(`\nDraft saved — review and post manually: ${result.markdownPath}`);
    } else if (command === "launch") {
      const sub = args[1];
      if (sub === "intake") {
        const input = args.slice(2).filter((item) => !item.startsWith("--")).join(" ");
        if (!input) throw new Error('Usage: henry launch intake "<product brief or repo path>"');
        const result = await runtime.launch.intake(input);
        console.log(result.markdown);
        console.log(`\nSaved: ${result.filePath}`);
        console.log(`Dad: fill in each ANSWER: line above, save the file, then run: henry launch run ${result.slug}`);
      } else if (sub === "run") {
        if (!args[2]) throw new Error("Usage: henry launch run <slug>");
        const result = await runtime.launch.run(args[2]);
        console.log(result.dossier);
        console.log(`\nSaved: ${result.filePath}`);
      } else if (sub === "list") {
        print(await runtime.launch.list());
      } else throw new Error('Usage: henry launch intake "<brief|path>" | run <slug> | list');
    } else throw new Error("Commands: ask, repl, dashboard, status, code, provider, jobs, cover, resume, memory, dispatch, gmail, review, approve, schedule, workflow, goal, remind, telegram, mailwatch, linkedin, launch");
  } finally {
    if (!keepAlive) runtime.close();
  }
}

main().catch((error) => { console.error(`henry: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
