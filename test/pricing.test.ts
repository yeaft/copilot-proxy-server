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
  assert.equal(cost.credits, 0.624);
  assert.equal(cost.usd, 0.00624);
});

test("prices GPT-6 Astra usage", () => {
  const cost = calculateUsageCost("gpt-6-astra", {
    prompt_tokens: 2_000_000,
    cached_prompt_tokens: 1_000_000,
    completion_tokens: 1_000_000,
  });

  assert.equal(cost.priced, true);
  assert.equal(cost.credits, 6_100);
  assert.equal(cost.usd, 61);
});

// Rates transcribed from the supplied Copilot credit table (per 1M tokens).
const screenshotRates: Array<[string, number, number, number]> = [
  ["gemini-3.7-flash", 75, 375, 7.5],
  ["gemini-3.8-flash", 75, 375, 7.5],
  ["gpt-5-mini", 25, 200, 2.5],
  ["gpt-5.3-codex", 175, 1400, 17.5],
  ["gpt-5.4", 250, 1500, 25],
  ["gpt-5.4-mini", 75, 450, 7.5],
  ["gpt-5.5", 500, 3000, 50],
  ["gpt-5.6-luna", 20, 120, 2],
  ["gpt-5.6-sol", 400, 2000, 40],
  ["gpt-5.6-sol-fast", 800, 4000, 80],
  ["gpt-5.6-terra", 200, 1200, 20],
  ["gpt-6-astra", 1000, 5000, 100],
  ["gpt-6-luna", 10, 50, 1],
  ["gpt-6-sol", 200, 1000, 20],
  ["gpt-6.1-sol", 200, 1000, 10],
  ["grok-4.5", 200, 600, 50],
  ["grok-4.6", 200, 600, 50],
  ["grok-4.7", 200, 600, 50],
  ["mai-code-1.1-flash", 20, 120, 2],
  ["gpt-5.2", 175, 1400, 17.5],
];

for (const [model, input, output, cacheRead] of screenshotRates) {
  test(`${model} matches each screenshot rate independently`, () => {
    for (const [usage, expected] of [
      [{ prompt_tokens: 1_000_000, completion_tokens: 0, cached_prompt_tokens: 0 }, input],
      [{ prompt_tokens: 0, completion_tokens: 1_000_000, cached_prompt_tokens: 0 }, output],
      [{ prompt_tokens: 1_000_000, completion_tokens: 0, cached_prompt_tokens: 1_000_000 }, cacheRead],
    ] as const) {
      assert.deepEqual(calculateUsageCost(model, usage), {
        priced: true, credits: expected, usd: expected * 0.01,
      });
    }
  });
}

test("supports display names and dated model IDs", () => {
  for (const [id, canonical] of [
    ["GPT-6.1 Sol", "gpt-6.1-sol"],
    ["GPT-5.6 Sol Fast (Internal only)", "gpt-5.6-sol-fast"],
    ["Gemini 3.8 Flash", "gemini-3.8-flash"],
    ["MAI-Code-1.1-Flash", "mai-code-1.1-flash"],
    ["gpt-5.4-mini-2026-03-17", "gpt-5.4-mini"],
  ]) {
    const usage = { prompt_tokens: 2_000_000, completion_tokens: 1_000_000, cached_prompt_tokens: 1_000_000 };
    assert.deepEqual(calculateUsageCost(id, usage), calculateUsageCost(canonical, usage));
  }
});

test("unknown models stay unpriced", () => {
  assert.deepEqual(calculateUsageCost("unknown-model", {
    prompt_tokens: 1_000_000, completion_tokens: 1_000_000, cached_prompt_tokens: 0,
  }), { priced: false, credits: 0, usd: 0 });
});
