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
const GPT_RATES: Array<[RegExp, CreditRates]> = [
  [/gpt[-_. ]?5\.4[-_. ]?mini/i, { input: 75, output: 450, cacheRead: 7.5 }],
  [/gpt[-_. ]?5\.5/i, { input: 500, output: 3000, cacheRead: 50 }],
  [/gpt[-_. ]?5\.6[-_. ]?luna/i, { input: 20, output: 120, cacheRead: 2 }],
  [/gpt[-_. ]?5\.6[-_. ]?sol[-_. ]?fast/i, { input: 400, output: 2000, cacheRead: 40 }],
  [/gpt[-_. ]?5\.6[-_. ]?sol/i, { input: 200, output: 1000, cacheRead: 20 }],
  [/gpt[-_. ]?5\.6[-_. ]?terra/i, { input: 200, output: 1200, cacheRead: 20 }],
];

export interface UsageCost {
  priced: boolean;
  credits: number;
  usd: number;
}

export function calculateUsageCost(model: string, usage: TokenUsage): UsageCost {
  const rates = GPT_RATES.find(([pattern]) => pattern.test(model))?.[1];
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
