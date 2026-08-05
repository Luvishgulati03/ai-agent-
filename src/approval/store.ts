import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ApprovalItem } from "../types.ts";

export class ApprovalStore {
  private items: ApprovalItem[] = [];
  private loaded = false;

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try { this.items = JSON.parse(await fs.readFile(this.filePath, "utf8")) as ApprovalItem[]; }
    catch { this.items = []; }
    this.loaded = true;
  }

  private async ensure(): Promise<void> { if (!this.loaded) await this.init(); }

  private async save(): Promise<void> {
    await fs.writeFile(this.filePath, `${JSON.stringify(this.items, null, 2)}\n`, "utf8");
  }

  async create(input: Omit<ApprovalItem, "id" | "createdAt" | "updatedAt" | "status">): Promise<ApprovalItem> {
    await this.ensure();
    const now = new Date().toISOString();
    const item: ApprovalItem = { ...input, id: randomUUID(), createdAt: now, updatedAt: now, status: "pending" };
    this.items.push(item);
    await this.save();
    return item;
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
    await this.ensure();
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`Approval item not found: ${id}`);
    item.status = status;
    item.updatedAt = new Date().toISOString();
    if (result !== undefined) item.result = result;
    await this.save();
    return item;
  }
}
