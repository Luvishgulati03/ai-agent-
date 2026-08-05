import fs from "node:fs/promises";
import path from "node:path";
import type { LavuConfig } from "../config.ts";
import type { WorkflowDefinition } from "../types.ts";

export async function writeCronFile(config: LavuConfig, definitions: WorkflowDefinition[]): Promise<string> {
  const enabled = definitions.filter((definition) => definition.enabled);
  const lines = enabled.map((definition) => `${definition.cron} cd ${shellQuote(config.rootDir)} && npm run --silent schedule -- run ${shellQuote(definition.id)} >> ${shellQuote(path.join(config.dataDir, "scheduler.log"))} 2>&1`);
  const filePath = path.join(config.dataDir, "lavu.cron");
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

export async function writeLaunchdPlist(config: LavuConfig, definitions: WorkflowDefinition[]): Promise<string> {
  const enabled = definitions.filter((definition) => definition.enabled);
  const children = enabled.map((definition) => `<dict><key>Label</key><string>com.lavu.${definition.id}</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>-lc</string><string>cd ${xmlQuote(config.rootDir)} &amp;&amp; npm run --silent schedule -- run ${xmlQuote(definition.id)} &gt;&gt; ${xmlQuote(path.join(config.dataDir, "scheduler.log"))} 2&gt;&amp;1</string></array><key>StartCalendarInterval</key><dict><key>Minute</key><integer>0</integer></dict><key>RunAtLoad</key><false/></dict>`).join("\n");
  const filePath = path.join(config.dataDir, "lavu.launchd.plist");
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(filePath, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><array>${children}</array></plist>\n`, "utf8");
  return filePath;
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function xmlQuote(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
