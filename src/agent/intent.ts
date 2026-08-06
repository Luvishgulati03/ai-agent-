/**
 * Zero-LLM intent gate (latency §11.5 #5): trivial conversational turns ride
 * the t0 tier (haiku/mini — ~5s) instead of a full frontier pass. Anything
 * that even smells like work stays on the default tier — when uncertain,
 * return undefined.
 */

const SMALLTALK = /^(hi+|hey+|hello+|yo|sup|what'?s up|good (morning|night|evening|afternoon)|gm|gn|thanks?( you)?|thank you|thx|ok(ay)?|cool|nice|great|haha+|lol|bye|goodnight|see ya|how are you\??|how'?s it going\??)(\s+henry)?[\s!.?,🙂😊🌙👋]*$/i;

const ACTION_SIGNALS = /\b(send|remind|draft|schedule|check|run|create|edit|search|open|fix|build|deploy|write|read|review|apply|submit|cancel|delete|update|install|email|gmail|job|resume|cover|memory|knowledge|code|workflow|screenshot|meeting|linkedin|goal|approve|dashboard)\b|https?:\/\/|\/|\d{1,2}[:.]\d{2}|\bat \d/i;

export function classifyIntentTier(prompt: string): "t0" | undefined {
  const text = prompt.trim();
  if (!text || text.length >= 120) return undefined;
  if (ACTION_SIGNALS.test(text)) return undefined;
  if (SMALLTALK.test(text)) return "t0";
  return undefined;
}
