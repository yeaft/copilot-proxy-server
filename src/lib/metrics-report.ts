/**
 * Dashboard analytics report. A port of llm-proxy's `src/metrics.rs` report so both
 * dashboards share one client (`routes/dashboard/assets/app.js`) and the same semantics.
 * Kept free of I/O: the caller supplies rows newest first.
 */

const DAY_MS = 86_400_000;
const MAX_WINDOW_MS = 31 * DAY_MS;
const LATEST_VALID_MS = 8_640_000_000_000_000;
export const ROW_LIMIT = 100_000;
export const MODEL_LIMIT = 200;
const DEFAULT_BUCKETS = 48;
const MAX_BUCKETS = 240;
const MIN_STEP_MS = 1_000;
const BREAKDOWN_LIMIT = 50;
/** Per-model time series are reported for the busiest models only, to bound the payload. */
const MODEL_TREND_LIMIT = 8;

/** One stored request. Token fields are null when the upstream did not report usage. */
export interface MetricSample {
  ts: number;
  model: string;
  endpoint: string;
  status: number;
  outcome: string;
  duration_ms: number;
  /** Streamed requests only. */
  first_token_ms: number | null;
  input: number | null;
  output: number | null;
  input_cache_read: number | null;
  input_cache_write: number | null;
  /** Reasoning tokens counted in `output`; null for rows written before they were recorded. */
  reasoning: number | null;
}

export interface MetricsWindow {
  from: number;
  to: number;
  model?: string;
  step: number;
}

export class MetricsQueryError extends Error {}

function optionalInteger(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new MetricsQueryError("Use a valid UTC millisecond range of at most 31 days (from < to).");
  }
  return parsed;
}

/** Validate `from`/`to` (UTC ms), `model` and `step` (bucket width in ms). Defaults to the last 24 hours. */
export function resolveMetricsWindow(
  query: Partial<Record<"from" | "to" | "model" | "step", string>>,
  now: number
): MetricsWindow {
  const to = optionalInteger(query.to) ?? now;
  const from = optionalInteger(query.from) ?? to - DAY_MS;
  const span = to - from;
  if (from < 0 || span < 1 || span > MAX_WINDOW_MS || to > LATEST_VALID_MS) {
    throw new MetricsQueryError("Use a valid UTC millisecond range of at most 31 days (from < to).");
  }
  if (query.model !== undefined && query.model.length > 4096) {
    throw new MetricsQueryError("Model filter is too long.");
  }
  let step: number;
  const requested = query.step === undefined || query.step === "" ? undefined : Number(query.step);
  if (requested === undefined) {
    step = Math.floor((span - 1) / DEFAULT_BUCKETS) + 1;
  } else if (
    Number.isSafeInteger(requested) &&
    requested >= MIN_STEP_MS &&
    requested <= MAX_WINDOW_MS &&
    Math.floor((span - 1) / requested) < MAX_BUCKETS
  ) {
    step = requested;
  } else {
    throw new MetricsQueryError("Use a bucket step from 1 second to 31 days, with at most 240 buckets.");
  }
  return { from, to, model: query.model ? query.model : undefined, step };
}

/** `ok`, `http_<status>` for HTTP failures, or the proxy outcome (`cancelled`, `timeout`, ...). */
function resultLabel(status: number, outcome: string): string {
  const completed = outcome === "ok" || outcome === "success";
  if (completed && status >= 200 && status < 400) return "ok";
  if (completed || outcome === "http_error") return `http_${status}`;
  return outcome;
}

interface Share {
  name: string;
  requests: number;
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Largest groups first, capped at `BREAKDOWN_LIMIT` entries, so shares can sum to less than the total. */
function shares(counts: Map<string, number>): Array<Share> {
  return [...counts]
    .map(([name, requests]) => ({ name, requests }))
    .sort((a, b) => b.requests - a.requests || byName(a.name, b.name))
    .slice(0, BREAKDOWN_LIMIT);
}

interface TokenTotal {
  tokens: number | null;
  reported: number;
}

const TOKEN_KEYS = [
  "input",
  "output",
  "input_cache_read",
  "input_cache_write",
  "output_cache_read",
  "output_cache_write",
] as const;
type TokenKey = (typeof TOKEN_KEYS)[number];
type TokenTotals = Record<TokenKey, TokenTotal>;
type Usage = Record<TokenKey, number | null>;

function usageOf(sample: MetricSample): Usage {
  return {
    input: sample.input,
    output: sample.output,
    input_cache_read: sample.input_cache_read,
    input_cache_write: sample.input_cache_write,
    // Copilot does not report output caching.
    output_cache_read: null,
    output_cache_write: null,
  };
}

interface Percentiles {
  count: number;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/** Nearest-rank percentiles. */
function percentiles(values: Array<number>): Percentiles {
  values.sort((a, b) => a - b);
  const quantile = (p: number) => {
    const rank = Math.ceil((values.length * p) / 100);
    return rank > 0 ? values[rank - 1] : null;
  };
  return {
    count: values.length,
    avg: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    p50: quantile(50),
    p95: quantile(95),
    p99: quantile(99),
  };
}

/**
 * Visible output generated after the first visible token: `(output - reasoning - 1)` tokens
 * over `duration - first token`. Only successful streamed requests with at least two visible
 * tokens qualify, so queueing, prompt processing, hidden reasoning and non-streamed responses
 * do not distort comparisons between models. (llm-proxy counts streamed reasoning deltas as
 * the first token instead; Copilot does not stream hidden reasoning, so it is excluded here.)
 */
function generation(
  error: boolean,
  duration: number,
  firstToken: number | null,
  output: number | null,
  reasoning: number | null
): [tokens: number, millis: number] | null {
  if (error || firstToken === null || output === null || reasoning === null) return null;
  const tokens = output - reasoning - 1;
  const millis = duration - firstToken;
  return tokens > 0 && millis > 0 ? [tokens, millis] : null;
}

interface Throughput {
  count: number;
  /** Median of per-request speeds. */
  p50: number | null;
  /** Token-weighted speed: all generated tokens over all generation time. */
  overall: number | null;
}

class ThroughputAccumulator {
  private rates: Array<number> = [];
  private tokens = 0;
  private millis = 0;

  add(generated: [number, number] | null): void {
    if (!generated) return;
    const [tokens, millis] = generated;
    this.rates.push((tokens * 1000) / millis);
    this.tokens += tokens;
    this.millis += millis;
  }

  finish(): Throughput {
    this.rates.sort((a, b) => a - b);
    return {
      count: this.rates.length,
      // Same nearest-rank rule as `percentiles`.
      p50: this.rates.length ? this.rates[Math.floor((this.rates.length - 1) / 2)] : null,
      overall: this.millis > 0 ? (this.tokens * 1000) / this.millis : null,
    };
  }
}

interface Point {
  requests: number;
  errors: number;
  /** All requests, including fast failures and client cancellations. */
  latency_ms: Percentiles;
  /** Successful requests only, for comparing how fast models complete work. */
  completed_latency_ms: Percentiles;
  ttft_ms: Percentiles;
  output_tps: Throughput;
}

/** The fields needed for request counts and timing. */
interface Observation {
  error: boolean;
  duration: number;
  firstToken: number | null;
  output: number | null;
  reasoning: number | null;
}

/** Request counts and timing without token totals; also used for per-model time series. */
class Performance {
  requests = 0;
  private errors = 0;
  private latency: Array<number> = [];
  private completedLatency: Array<number> = [];
  private ttft: Array<number> = [];
  private outputTps = new ThroughputAccumulator();

  add(item: Observation): void {
    this.requests++;
    if (item.error) this.errors++;
    this.latency.push(item.duration);
    if (!item.error) this.completedLatency.push(item.duration);
    if (item.firstToken !== null) this.ttft.push(item.firstToken);
    this.outputTps.add(generation(item.error, item.duration, item.firstToken, item.output, item.reasoning));
  }

  finish(): Point {
    return {
      requests: this.requests,
      errors: this.errors,
      latency_ms: percentiles(this.latency),
      completed_latency_ms: percentiles(this.completedLatency),
      ttft_ms: percentiles(this.ttft),
      output_tps: this.outputTps.finish(),
    };
  }
}

interface CacheRate {
  percent: number | null;
  reported: number;
}

interface Summary extends Point {
  usage: TokenTotals;
  input_cache_rate: CacheRate;
}

class Accumulator {
  readonly performance = new Performance();
  private usage = Object.fromEntries(
    TOKEN_KEYS.map((key) => [key, { tokens: null, reported: 0 }])
  ) as TokenTotals;
  private cacheInput = 0;
  private cacheRead = 0;
  private cacheReported = 0;

  get requests(): number {
    return this.performance.requests;
  }

  add(item: Observation, usage: Usage): void {
    this.performance.add(item);
    for (const key of TOKEN_KEYS) {
      const value = usage[key];
      if (value === null) continue;
      this.usage[key].tokens = (this.usage[key].tokens ?? 0) + value;
      this.usage[key].reported++;
    }
    // Pair observations: missing cache usage must not dilute the rate, and an
    // invalid breakdown (reads above input) cannot define a meaningful hit rate.
    if (usage.input !== null && usage.input_cache_read !== null && usage.input_cache_read <= usage.input) {
      this.cacheInput += usage.input;
      this.cacheRead += usage.input_cache_read;
      this.cacheReported++;
    }
  }

  finish(): Summary {
    return {
      ...this.performance.finish(),
      usage: this.usage,
      input_cache_rate: {
        percent: this.cacheInput > 0 ? (this.cacheRead / this.cacheInput) * 100 : null,
        reported: this.cacheReported,
      },
    };
  }
}

export interface MetricsReport {
  from: number;
  to: number;
  step: number;
  summary: Summary;
  models: Array<{ model: string } & Summary>;
  available_models: Array<string>;
  model_list_truncated: boolean;
  results: Array<Share>;
  endpoints: Array<Share>;
  trend: Array<{ start: number; end: number } & Summary>;
  /** The busiest models (at most `MODEL_TREND_LIMIT`); `null` marks a bucket without requests. */
  model_trend: Array<{ model: string; points: Array<Point | null> }>;
  truncated: boolean;
  dropped_since_start: number;
}

export interface ReportInput {
  /** Newest first; anything beyond `ROW_LIMIT` marks the report as truncated. */
  samples: Array<MetricSample>;
  availableModels: Array<string>;
  modelListTruncated: boolean;
  droppedSinceStart: number;
}

export function buildMetricsReport(window: MetricsWindow, input: ReportInput): MetricsReport {
  const { from, to, step } = window;
  const timeline: Array<Accumulator> = [];
  for (let start = from; start < to; start += step) timeline.push(new Accumulator());

  const total = new Accumulator();
  const grouped = new Map<string, { summary: Accumulator; observations: Array<{ bucket: number } & Observation> }>();
  const results = new Map<string, number>();
  const endpoints = new Map<string, number>();
  const truncated = input.samples.length > ROW_LIMIT;

  for (const sample of input.samples.slice(0, ROW_LIMIT)) {
    const bucket = Math.floor((sample.ts - from) / step);
    // Defensive: the query bounds the window, but never index outside the timeline.
    if (bucket < 0 || bucket >= timeline.length) continue;
    const item: Observation = {
      error: !(sample.status >= 200 && sample.status < 400) || !(sample.outcome === "ok" || sample.outcome === "success"),
      duration: sample.duration_ms,
      firstToken: sample.first_token_ms,
      output: sample.output,
      reasoning: sample.reasoning,
    };
    const usage = usageOf(sample);
    const label = resultLabel(sample.status, sample.outcome);
    results.set(label, (results.get(label) ?? 0) + 1);
    endpoints.set(sample.endpoint, (endpoints.get(sample.endpoint) ?? 0) + 1);
    total.add(item, usage);
    timeline[bucket].add(item, usage);
    let group = grouped.get(sample.model);
    if (!group) grouped.set(sample.model, (group = { summary: new Accumulator(), observations: [] }));
    group.summary.add(item, usage);
    group.observations.push({ bucket, ...item });
  }

  const ranked = [...grouped].sort(
    ([nameA, a], [nameB, b]) => b.summary.requests - a.summary.requests || byName(nameA, nameB)
  );

  return {
    from,
    to,
    step,
    summary: total.finish(),
    models: ranked.slice(0, MODEL_LIMIT).map(([model, group]) => ({ model, ...group.summary.finish() })),
    available_models: input.availableModels,
    model_list_truncated: input.modelListTruncated || grouped.size > MODEL_LIMIT,
    results: shares(results),
    endpoints: shares(endpoints),
    trend: timeline.map((accumulator, index) => ({
      start: from + index * step,
      end: Math.min(from + (index + 1) * step, to),
      ...accumulator.finish(),
    })),
    model_trend: ranked.slice(0, MODEL_TREND_LIMIT).map(([model, group]) => {
      const points: Array<Performance | null> = timeline.map(() => null);
      for (const { bucket, ...item } of group.observations) {
        (points[bucket] ??= new Performance()).add(item);
      }
      return { model, points: points.map((point) => point?.finish() ?? null) };
    }),
    truncated,
    dropped_since_start: input.droppedSinceStart,
  };
}
