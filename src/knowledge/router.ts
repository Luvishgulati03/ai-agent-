import type { KnowledgeDomain } from "./store.ts";

/**
 * Zero-LLM heuristic router: decides whether a turn is domain-relevant enough
 * to justify pulling the organization's knowledge base into the prompt at all.
 * Adapted from ingest.ts's deriveDomain, but deliberately stricter: deriveDomain
 * always resolves to a bucket (defaulting to "general") because every ingested
 * chunk needs *some* domain tag. Here a miss must stay a miss — ordinary chit-chat
 * ("hello henry") should never pay the recall cost, so we return null instead of
 * ever landing on "general".
 */
export function detectKnowledgeDomain(prompt: string): KnowledgeDomain | null {
  const text = prompt.toLowerCase();
  if (/\bgtm|go[ -]?to[ -]?market|launch|distribution\b/.test(text)) return "gtm";
  if (/growth|acquisition|retention|funnel|marketing/.test(text)) return "growth-strategy";
  if (/product|\bpm\b|roadmap|\bprd\b|discovery/.test(text)) return "product-management";
  if (/engineer|develop|\btech\b|coding|software|\bapi\b|bug|typescript|javascript/.test(text)) return "software-development";
  if (/community|member/.test(text)) return "community";
  if (/sales|pipeline|outbound|\bdeal\b/.test(text)) return "sales";
  if (/career|talent|interview|resume|\bjob\b/.test(text)) return "careers";
  return null;
}
