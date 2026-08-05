import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ApprovalItem } from "../types.ts";

export class ApprovalStore {
  private items: ApprovalItem[] = [];
  private loaded = false;
  private mutationChain = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.filePath), 0o700).catch(() => undefined);
    try { this.items = JSON.parse(await fs.readFile(this.filePath, "utf8")) as ApprovalItem[]; }
    catch { this.items = []; }
    await fs.chmod(this.filePath, 0o600).catch(() => undefined);
    this.loaded = true;
  }

  private async ensure(): Promise<void> { if (!this.loaded) await this.init(); }

  private async save(): Promise<void> {
    await fs.writeFile(this.filePath, `${JSON.stringify(this.items, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(this.filePath, 0o600).catch(() => undefined);
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  async create(input: Omit<ApprovalItem, "id" | "createdAt" | "updatedAt" | "status">): Promise<ApprovalItem> {
    return this.mutate(async () => {
      await this.ensure();
      const now = new Date().toISOString();
      const item: ApprovalItem = { ...input, id: randomUUID(), createdAt: now, updatedAt: now, status: "pending" };
      this.items.push(item);
      await this.save();
      return item;
    });
  }

  async list(status?: ApprovalItem["status"]): Promise<ApprovalItem[]> {
    await this.ensure();
    return this.items.filter((item) => !status || item.status === status).slice().reverse();
  }

  async get(id: string): Promise<ApprovalItem | undefined> {
    await this.ensure();
    return this.items.find((item) => item.id === id);
  }

  async setStatus(id: string, status: ApprovalItem["status"], result?: string): Promise<ApprovalItem> {
    return this.mutate(async () => {
      await this.ensure();
      const item = this.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`Approval item not found: ${id}`);
      const allowed = item.status === "pending" ? ["approved", "rejected"] : item.status === "approved" ? ["executing", "rejected"] : item.status === "executing" ? ["executed", "failed"] : [];
      if (!allowed.includes(status)) throw new Error(`Invalid approval transition: ${item.status} -> ${status}`);
      item.status = status;
      item.updatedAt = new Date().toISOString();
      if (result !== undefined) item.result = result;
      await this.save();
      return item;
    });
  }

  /** Atomically claim an explicitly approved action for execution. */
  async claimForExecution(id: string): Promise<ApprovalItem> {
    return this.mutate(async () => {
      await this.ensure();
      const item = this.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`Approval item not found: ${id}`);
      if (item.status !== "approved") {
        throw new Error(
          `Approval ${id} is ${item.status}; explicit Dad approval is required before execution`,
        );
      }
      item.status = "executing";
      item.updatedAt = new Date().toISOString();
      await this.save();
      return item;
    });
  }
}
