import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";

/**
 * Read-only export of the GrowthX Learn corpus from Mongo into knowledge/raw/.
 * Credentials are read from gx-backend's own .env at run time and never stored.
 * Member notes (private user data) are deliberately NOT exported.
 */

const GX_BACKEND = process.env.GX_BACKEND_DIR || "/Users/luvishgulati/Growth x repos BE FE and admin/gx-backend";

interface ExportCounts { chunks: number; transcripts: number; texts: number; modules: number }

function dedupConsecutiveLines(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) if (line.trim() && line.trim() !== out[out.length - 1]?.trim()) out.push(line);
  return out.join("\n");
}

function frontmatter(fields: Record<string, unknown>): string {
  return `---\n${Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\n`;
}

export async function exportGxKnowledge(rawDir: string): Promise<ExportCounts> {
  const env = dotenv.parse(await fs.readFile(path.join(GX_BACKEND, "apps/migrations/.env"), "utf8"));
  const uri = env.DB_STRING;
  if (!uri) throw new Error("DB_STRING not found in gx-backend apps/migrations/.env");
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { readPreference: "secondaryPreferred" });
  const counts: ExportCounts = { chunks: 0, transcripts: 0, texts: 0, modules: 0 };
  try {
    await client.connect();
    const db = client.db(env.DB_NAME || undefined);
    await fs.mkdir(path.join(rawDir, "transcripts"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(rawDir, "texts"), { recursive: true, mode: 0o700 });

    // 1. Module catalog (names, taxonomy, hierarchy) for attribution + domains.
    const modules = await db.collection("modules").find(
      { active: { $ne: false } },
      { projection: { name: 1, subtitle: 1, description: 1, type: 1, resource_type: 1, filters: 1, slug: 1, keywords: 1, ancestry: 1 } },
    ).toArray();
    const moduleById = new Map(modules.map((m) => [String(m._id), m]));
    await fs.writeFile(path.join(rawDir, "modules.json"), JSON.stringify(modules, null, 1), "utf8");
    counts.modules = modules.length;

    // 2. Cleaned learning chunks (best-quality corpus; excludes stored embeddings).
    const chunkCursor = db.collection("learningchunks").find({ active: { $ne: false } }, { projection: { embedding: 0 } });
    const chunkLines: string[] = [];
    const chunkedModuleIds = new Set<string>();
    for await (const chunk of chunkCursor) {
      chunkedModuleIds.add(String(chunk.module_id));
      chunkLines.push(JSON.stringify(chunk));
    }
    await fs.writeFile(path.join(rawDir, "chunks.jsonl"), chunkLines.join("\n") + "\n", "utf8");
    counts.chunks = chunkLines.length;

    // 3. Flat transcripts for video modules not covered by learningchunks —
    //    latest completed transcribe job only (older jobs are stale).
    for (const module of modules) {
      const id = String(module._id);
      if (module.type !== "video" || chunkedModuleIds.has(id)) continue;
      const job = await db.collection("awsmediajobs").find(
        { module_id: module._id, service: "TRANSCRIBE", status: "COMPLETED", transcript: { $exists: true, $ne: "" } },
        { projection: { transcript: 1, created_at: 1 }, sort: { created_at: -1 }, limit: 1 },
      ).next();
      if (!job?.transcript) continue;
      const body = dedupConsecutiveLines(String(job.transcript));
      await fs.writeFile(
        path.join(rawDir, "transcripts", `${id}.md`),
        frontmatter({ module: module.name, moduleId: id, type: module.type, resource_type: module.resource_type, filters: module.filters }) + body + "\n",
        "utf8",
      );
      counts.transcripts += 1;
    }

    // 4. Authored text content (preread/postread/text modules).
    for (const module of modules) {
      if (!["preread", "postread", "text"].includes(String(module.type))) continue;
      const full = await db.collection("modules").findOne({ _id: module._id }, { projection: { content: 1, preread_content: 1 } });
      const content = [full?.content, full?.preread_content ? JSON.stringify(full.preread_content) : ""].filter(Boolean).join("\n\n");
      if (!content.trim()) continue;
      await fs.writeFile(
        path.join(rawDir, "texts", `${String(module._id)}.md`),
        frontmatter({ module: module.name, moduleId: String(module._id), type: module.type, filters: module.filters }) + content + "\n",
        "utf8",
      );
      counts.texts += 1;
    }
    void moduleById;
    return counts;
  } finally { await client.close(); }
}
