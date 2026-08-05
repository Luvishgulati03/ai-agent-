#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { LavuRuntime } from "./runtime.ts";
import { startDashboard } from "./dashboard/server.ts";

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

async function repl(runtime: LavuRuntime): Promise<void> {
  const rl = readline.createInterface({ input, output, prompt: "lavu> " });
  console.log("Lavu is ready, Dad. Type :help for commands or ask normally.\n");
  rl.prompt();
  for await (const line of rl) {
    const value = line.trim();
    if (!value) { rl.prompt(); continue; }
    if (value === ":quit" || value === ":exit") break;
    if (value === ":help") { console.log(":status  :dashboard  :memory <query>  :quit"); rl.prompt(); continue; }
    try {
      if (value === ":status") print(await runtime.status());
      else if (value === ":dashboard") console.log(`Dashboard: http://${runtime.config.host}:${runtime.config.port}`);
      else if (value.startsWith(":memory ")) print(await runtime.memory.recall(value.slice(8)));
      else print((await runtime.agent.run(value)).response);
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
    rl.prompt();
  }
  rl.close();
}

async function main(): Promise<void> {
  const command = args[0] || "repl";
  const runtime = await LavuRuntime.create();
  let keepAlive = false;
  try {
    if (command === "ask") {
      const prompt = args.slice(1).filter((item) => !item.startsWith("--")).join(" ");
      if (!prompt) throw new Error("Usage: lavu ask <prompt>");
      print((await runtime.agent.run(prompt, { provider: option("--provider") as "codex" | "claude" | undefined })).response);
    } else if (command === "repl") {
      keepAlive = true; await repl(runtime);
    } else if (command === "dashboard") {
      startDashboard(runtime); keepAlive = true;
      console.log(`Lavu dashboard: http://${runtime.config.host}:${runtime.config.port}`);
    } else if (command === "status") {
      print(await runtime.status());
    } else if (command === "memory") {
      const sub = args[1] || "search";
      if (sub === "search") print(await runtime.memory.recall(args.slice(2).join(" ")));
      else if (sub === "remember") print(await runtime.memory.remember(args.slice(2).join(" ")));
      else if (sub === "index") print(await runtime.memory.index(args.includes("--fresh")));
      else if (sub === "graph") print(runtime.memory.graph());
      else if (sub === "dream") print(await runtime.memory.dream());
      else throw new Error("Usage: lavu memory search|remember|index|graph|dream");
    } else if (command === "dispatch") {
      const role = args[1] || "architect";
      const task = args.slice(2).filter((item) => item !== "--edit").join(" ");
      if (!task) throw new Error("Usage: lavu dispatch <role> <task>");
      print((await runtime.luna.dispatch(role, task, { allowEdits: args.includes("--edit") })).response);
    } else if (command === "gmail") {
      const sub = args[1] || "inbox";
      if (sub === "auth") { await runtime.gmail.authorize(); console.log("Gmail connected."); }
      else if (sub === "inbox") print(await runtime.gmail.inbox(Number(option("--limit") || 10)));
      else if (sub === "send" || sub === "draft") {
        const to = option("--to"); const subject = option("--subject"); const body = option("--body") || args.slice(2).filter((item) => !item.startsWith("--") && item !== to && item !== subject).join(" ");
        if (!to || !subject || !body) throw new Error("Usage: lavu gmail draft --to email --subject subject --body body");
        const item = await runtime.gmail.queueEmail({ to, subject, body });
        print({ message: "Saved locally and queued for Dad's approval", approvalId: item.id, dashboard: `http://${runtime.config.host}:${runtime.config.port}` });
      } else throw new Error("Usage: lavu gmail auth|inbox|draft");
    } else if (command === "review") {
      const target = args[1];
      if (!target) throw new Error("Usage: lavu review <pr-number-or-url> [--cwd path] [--repo owner/name]");
      const cwd = option("--cwd") || (option("--repo")?.startsWith("/") ? option("--repo") : runtime.config.rootDir) || runtime.config.rootDir;
      const repo = option("--repo")?.startsWith("/") ? undefined : option("--repo");
      print(await runtime.reviewer.review(target, path.resolve(cwd), repo));
    } else if (command === "approve") {
      const sub = args[1] || "list";
      if (sub === "list") print(await runtime.approvals.list());
      else if (sub === "approve") { if (!args[2]) throw new Error("Usage: lavu approve approve <id>"); await runtime.approve(args[2]); console.log(`Approved ${args[2]}`); }
      else if (sub === "send" || sub === "execute") { if (!args[2]) throw new Error("Usage: lavu approve send <id>"); const item = await runtime.approvals.get(args[2]); if (!item) throw new Error("Approval not found"); if (item.status === "pending") await runtime.approve(args[2]); print(await runtime.executeApproval(args[2])); }
      else throw new Error("Usage: lavu approve list|approve|send <id>");
    } else if (command === "schedule") {
      const sub = args[1] || "list";
      if (sub === "list") print(await runtime.scheduler.definitions());
      else if (sub === "run") { const id = args[2]; const definition = (await runtime.scheduler.definitions()).find((item) => item.id === id); if (!definition) throw new Error(`Workflow not found: ${id}`); print(await runtime.scheduler.run(definition)); }
      else if (sub === "daemon") { await runtime.scheduler.start(); keepAlive = true; console.log("Lavu scheduler is running. Press Ctrl+C to stop."); }
      else throw new Error("Usage: lavu schedule list|run <id>|daemon");
    } else throw new Error("Commands: ask, repl, dashboard, status, memory, dispatch, gmail, review, approve, schedule");
  } finally {
    if (!keepAlive) runtime.close();
  }
}

main().catch((error) => { console.error(`lavu: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
