export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
}

interface CreditRates {
  input: number;
  output: number;
  cacheRead: number;
}

// Credits per 1M tokens. One credit is $0.01.
// Cache writes remain part of regular input pricing; there is no separate
// cache-write rate in this table.
const MODEL_RATES: Array<[RegExp, CreditRates]> = [
  [/gemini[-_. ]?3\.[78][-_. ]?flash/i, { input: 75, output: 375, cacheRead: 7.5 }],
  [/gpt[-_. ]?5[-_. ]?mini/i, { input: 25, output: 200, cacheRead: 2.5 }],
  [/gpt[-_. ]?5\.3[-_. ]?codex/i, { input: 175, output: 1400, cacheRead: 17.5 }],
  // Match mini/fast variants before their base model.
  [/gpt[-_. ]?5\.4[-_. ]?mini/i, { input: 75, output: 450, cacheRead: 7.5 }],
  [/gpt[-_. ]?5\.4/i, { input: 250, output: 1500, cacheRead: 25 }],
  [/gpt[-_. ]?5\.5/i, { input: 500, output: 3000, cacheRead: 50 }],
  [/gpt[-_. ]?5\.6[-_. ]?luna/i, { input: 20, output: 120, cacheRead: 2 }],
  [/gpt[-_. ]?5\.6[-_. ]?sol[-_. ]?fast/i, { input: 800, output: 4000, cacheRead: 80 }],
  [/gpt[-_. ]?5\.6[-_. ]?sol/i, { input: 400, output: 2000, cacheRead: 40 }],
  [/gpt[-_. ]?5\.6[-_. ]?terra/i, { input: 200, output: 1200, cacheRead: 20 }],
  [/gpt[-_. ]?6[-_. ]?astra/i, { input: 1000, output: 5000, cacheRead: 100 }],
  [/gpt[-_. ]?6[-_. ]?luna/i, { input: 10, output: 50, cacheRead: 1 }],
  [/gpt[-_. ]?6[-_. ]?sol/i, { input: 200, output: 1000, cacheRead: 20 }],
  [/gpt[-_. ]?6\.1[-_. ]?sol/i, { input: 200, output: 1000, cacheRead: 10 }],
  [/grok[-_. ]?4\.[567]/i, { input: 200, output: 600, cacheRead: 50 }],
  [/mai[-_. ]?code[-_. ]?1\.1[-_. ]?flash/i, { input: 20, output: 120, cacheRead: 2 }],
  [/gpt[-_. ]?5\.2/i, { input: 175, output: 1400, cacheRead: 17.5 }],
];

export interface UsageCost {
  priced: boolean;
  credits: number;
  usd: number;
}

export function calculateUsageCost(model: string, usage: TokenUsage): UsageCost {
  const rates = MODEL_RATES.find(([pattern]) => pattern.test(model))?.[1];
  if (!rates) return { priced: false, credits: 0, usd: 0 };

  // OpenAI prompt_tokens includes cached tokens, so do not charge them twice.
  const cached = Math.max(0, usage.cached_prompt_tokens || 0);
  const uncachedInput = Math.max(0, (usage.prompt_tokens || 0) - cached);
  const credits = (
    uncachedInput * rates.input +
    Math.max(0, usage.completion_tokens || 0) * rates.output +
    cached * rates.cacheRead
  ) / 1_000_000;

  return { priced: true, credits, usd: credits * 0.01 };
}
