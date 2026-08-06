import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntentTier } from "../src/agent/intent.ts";

const t0 = ["hi", "hey henry", "hello!", "thanks", "thank you", "good night henry", "gm", "ok", "how are you?", "bye 👋"];
const full = [
  "send me a hi at 9",
  "check my email",
  "remind me tomorrow",
  "ok run it",
  "draft a reply to the recruiter",
  "what jobs came in today",
  "open the dashboard",
  "https://example.com/posting",
  "edit my resume to lead with PM work",
  "x".repeat(150),
  "I was thinking about how we should approach the GTM for the new community product and whether the pricing tiers make sense",
];

for (const p of t0) test(`t0: "${p}"`, () => assert.equal(classifyIntentTier(p), "t0"));
for (const p of full) test(`full: "${p.slice(0, 40)}"`, () => assert.equal(classifyIntentTier(p), undefined));
