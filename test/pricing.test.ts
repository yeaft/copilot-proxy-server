import assert from "node:assert/strict";
import test from "node:test";

import { calculateUsageCost } from "../src/lib/pricing.js";

test("charges cached input at the cache-read rate", () => {
  const cost = calculateUsageCost("gpt-5.6-sol-fast", {
    prompt_tokens: 1_000,
    cached_prompt_tokens: 800,
    completion_tokens: 100,
  });

  assert.equal(cost.priced, true);
  assert.equal(cost.credits, 0.312);
  assert.equal(cost.usd, 0.00312);
});
