import type { EmbeddingProvider } from "engram-memory";

/**
 * Local semantic embeddings via transformers.js (bge-small-en-v1.5, q8).
 * Pure npm, ~30MB weights cached on first run, ~5-20ms per text on M1 CPU.
 * Replaces Engram's default hashing provider wherever real recall matters.
 *
 * Shared between the knowledge base (src/knowledge/store.ts) and personal
 * memory (src/memory/engram.ts) — one model instance, one provider identity.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "bge-small-en-v1.5-q8@384";
  readonly dim = 384;
  private extractor?: Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>>;

  private load() {
    this.extractor ||= import("@huggingface/transformers").then(async ({ pipeline }) => {
      const pipe = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" });
      return (texts: string[], opts: object) => pipe(texts, opts) as Promise<{ tolist(): number[][] }>;
    });
    return this.extractor;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const extract = await this.load();
    const out: Float32Array[] = [];
    for (let index = 0; index < texts.length; index += 32) {
      const batch = texts.slice(index, index + 32).map((t) => t.slice(0, 2000));
      const result = await extract(batch, { pooling: "mean", normalize: true });
      for (const row of result.tolist()) out.push(Float32Array.from(row));
    }
    return out;
  }
}
