import fs from "node:fs/promises";
import path from "node:path";
import type { HenryConfig } from "../config.ts";
import type { WorkflowDefinition } from "../types.ts";

export async function writeCronFile(config: HenryConfig, definitions: WorkflowDefinition[]): Promise<string> {
  const enabled = definitions.filter((definition) => definition.enabled);
  const lines = enabled.map((definition) => `${definition.cron} cd ${shellQuote(config.rootDir)} && npm run --silent schedule -- run ${shellQuote(definition.id)} >> ${shellQuote(path.join(config.dataDir, "scheduler.log"))} 2>&1`);
  const filePath = path.join(config.dataDir, "henry.cron");
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

export async function writeLaunchdPlist(config: HenryConfig, definitions: WorkflowDefinition[]): Promise<string> {
  const enabled = definitions.filter((definition) => definition.enabled);
  const filePath = path.join(config.dataDir, "henry.launchd.plist");
  await fs.mkdir(config.dataDir, { recursive: true });
  // launchd starts one long-lived scheduler process. Croner inside Henry owns
  // the individual expressions, so workflow IDs never enter a shell command.
  const args = ["/usr/bin/env", "npm", "run", "--silent", "schedule", "--", "daemon"];
  const argumentsXml = args.map((arg) => `<string>${xmlQuote(arg)}</string>`).join("");
  const label = `com.henry.scheduler-${enabled.length}`;
  await fs.writeFile(filePath, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xmlQuote(label)}</string><key>ProgramArguments</key><array>${argumentsXml}</array><key>WorkingDirectory</key><string>${xmlQuote(config.rootDir)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xmlQuote(path.join(config.dataDir, "scheduler.log"))}</string><key>StandardErrorPath</key><string>${xmlQuote(path.join(config.dataDir, "scheduler.log"))}</string></dict></plist>\n`, "utf8");
  return filePath;
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function xmlQuote(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
