import fs from "node:fs/promises";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { google, type gmail_v1 } from "googleapis";
import type { LavuConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { ApprovalStore } from "../approval/store.ts";
import type { ApprovalItem } from "../types.ts";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"];

export interface InboxMessage {
  id: string;
  threadId?: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
}

function header(message: gmail_v1.Schema$Message, name: string): string {
  return message.payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function decodeBody(value?: string | null): string {
  if (!value) return "";
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function textPart(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeBody(payload.body.data);
  for (const part of payload.parts || []) {
    const found = textPart(part);
    if (found) return found;
  }
  return payload.body?.data ? decodeBody(payload.body.data) : "";
}

function asBase64Url(value: string): string {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export class GmailService {
  private client?: gmail_v1.Gmail;

  constructor(
    private readonly config: LavuConfig,
    private readonly activity: ActivityLog,
    private readonly approvals: ApprovalStore,
  ) {}

  private async oauth(): Promise<import("googleapis").Auth.OAuth2Client> {
    let raw: string;
    try { raw = await fs.readFile(this.config.gmailCredentialsPath, "utf8"); }
    catch { throw new Error(`Gmail credentials missing at ${this.config.gmailCredentialsPath}. Run: lavu gmail auth`); }
    const credentials = JSON.parse(raw) as Record<string, Record<string, string>>;
    const config = credentials.installed || credentials.web || credentials;
    const client = new google.auth.OAuth2(config.client_id, config.client_secret, this.config.gmailRedirectUri);
    try { await fs.access(this.config.gmailTokenPath); client.setCredentials(JSON.parse(await fs.readFile(this.config.gmailTokenPath, "utf8"))); }
    catch { throw new Error(`Gmail is not connected. Run: lavu gmail auth`); }
    return client;
  }

  private async api(): Promise<gmail_v1.Gmail> {
    if (this.client) return this.client;
    this.client = google.gmail({ version: "v1", auth: await this.oauth() });
    return this.client;
  }

  async authorize(): Promise<void> {
    let raw: string;
    try { raw = await fs.readFile(this.config.gmailCredentialsPath, "utf8"); }
    catch { throw new Error(`Put your Google OAuth desktop credentials at ${this.config.gmailCredentialsPath} first.`); }
    const credentials = JSON.parse(raw) as Record<string, Record<string, string>>;
    const config = credentials.installed || credentials.web || credentials;
    const client = new google.auth.OAuth2(config.client_id, config.client_secret, this.config.gmailRedirectUri);
    const url = client.generateAuthUrl({ access_type: "offline", scope: SCOPES, prompt: "consent" });
    console.log(`\nOpen this Gmail authorization URL:\n\n${url}\n`);
    if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    const redirect = new URL(this.config.gmailRedirectUri);
    await new Promise<void>((resolve, reject) => {
      const server = http.createServer(async (request, response) => {
        try {
          const incoming = new URL(request.url || "/", `${redirect.protocol}//${redirect.host}`);
          const code = incoming.searchParams.get("code");
          const error = incoming.searchParams.get("error");
          if (error) throw new Error(error);
          if (!code) { response.writeHead(400); response.end("Waiting for OAuth callback"); return; }
          const token = await client.getToken(code);
          await fs.mkdir(path.dirname(this.config.gmailTokenPath), { recursive: true });
          await fs.writeFile(this.config.gmailTokenPath, JSON.stringify(token.tokens, null, 2), "utf8");
          response.end("Lavu is connected to Gmail. You can close this tab.");
          server.close(); resolve();
        } catch (callbackError) { response.writeHead(500); response.end(String(callbackError)); server.close(); reject(callbackError); }
      });
      server.listen(Number(redirect.port || 80), redirect.hostname);
      setTimeout(() => { server.close(); reject(new Error("Gmail authorization timed out after 5 minutes")); }, 300_000).unref();
    });
  }

  async inbox(limit = 10): Promise<InboxMessage[]> {
    const gmail = await this.api();
    const listed = await gmail.users.messages.list({ userId: "me", q: "in:inbox", maxResults: Math.min(Math.max(limit, 1), 50) });
    const messages: InboxMessage[] = [];
    for (const item of listed.data.messages || []) {
      if (!item.id) continue;
      const full = await gmail.users.messages.get({ userId: "me", id: item.id, format: "full" });
      const message = full.data;
      messages.push({
        id: message.id || item.id, threadId: message.threadId || undefined,
        from: header(message, "From"), to: header(message, "To"), subject: header(message, "Subject"),
        date: header(message, "Date"), snippet: message.snippet || "", body: textPart(message.payload),
      });
    }
    await this.activity.record("gmail.read", `Read ${messages.length} Gmail messages`, { limit });
    return messages;
  }

  async queueEmail(input: { to: string; subject: string; body: string; threadId?: string }): Promise<ApprovalItem> {
    const item = await this.approvals.create({
      kind: "gmail.send", title: `Email ${input.to}: ${input.subject}`, recipient: input.to,
      subject: input.subject, body: input.body, payload: { to: input.to, subject: input.subject, body: input.body, threadId: input.threadId },
    });
    await this.activity.record("approval.created", `Queued Gmail message for approval`, { approvalId: item.id, to: input.to, subject: input.subject });
    return item;
  }

  async sendApproved(item: ApprovalItem): Promise<string> {
    if (item.kind !== "gmail.send") throw new Error(`Not a Gmail approval: ${item.id}`);
    if (item.status !== "approved") throw new Error(`Approval ${item.id} must be approved before sending`);
    const gmail = await this.api();
    const payload = item.payload as { to: string; subject: string; body: string; threadId?: string };
    const raw = [`To: ${payload.to}`, `Subject: ${payload.subject}`, "Content-Type: text/plain; charset=utf-8", "", payload.body].join("\r\n");
    const sent = await gmail.users.messages.send({ userId: "me", requestBody: { raw: asBase64Url(raw), ...(payload.threadId ? { threadId: payload.threadId } : {}) } });
    const id = sent.data.id || "sent";
    await this.activity.record("approval.executed", `Sent Gmail message ${id}`, { approvalId: item.id, messageId: id });
    return id;
  }
}
