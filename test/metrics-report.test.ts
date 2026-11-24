import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMetricsReport,
  MetricsQueryError,
  resolveMetricsWindow,
  ROW_LIMIT,
  type MetricSample,
  type MetricsWindow,
} from "../src/lib/metrics-report.js";

// Ported from llm-proxy's src/metrics.rs tests so both dashboards keep the same semantics.

const DAY_MS = 86_400_000;
const MAX_WINDOW_MS = 31 * DAY_MS;

function sample(ts: number, model: string, overrides: Partial<MetricSample> = {}): MetricSample {
  return {
    ts,
    model,
    endpoint: "openai",
    status: 200,
    outcome: "ok",
    duration_ms: 35,
    first_token_ms: null,
    input: null,
    output: null,
    input_cache_read: null,
    input_cache_write: null,
    reasoning: null,
    ...overrides,
  };
}

function report(window: MetricsWindow, samples: Array<MetricSample>) {
  return buildMetricsReport(window, {
    samples: [...samples].sort((a, b) => b.ts - a.ts),
    availableModels: [],
    modelListTruncated: false,
    droppedSinceStart: 0,
  });
}

test("buckets requests and keeps token coverage, latency and results per window", () => {
  const data = report({ from: 10, to: 30, step: 5 }, [
    sample(10, "alpha", { input: 20, output: 0, input_cache_read: 5, first_token_ms: 12, reasoning: 0 }),
    sample(20, "alpha", { outcome: "stream_error", duration_ms: 65 }),
  ]);
  assert.equal(data.step, 5);
  assert.deepEqual(
    data.trend.map((bucket) => [bucket.start, bucket.end, bucket.requests]),
    [[10, 15, 1], [15, 20, 0], [20, 25, 1], [25, 30, 0]]
  );
  assert.deepEqual(data.results, [{ name: "ok", requests: 1 }, { name: "stream_error", requests: 1 }]);
  assert.deepEqual(data.endpoints, [{ name: "openai", requests: 2 }]);
  assert.deepEqual([data.summary.requests, data.summary.errors], [2, 1]);
  assert.deepEqual(data.summary.latency_ms, { count: 2, avg: 50, p50: 35, p95: 65, p99: 65 });
  // The failed 65 ms request counts toward all-request latency only.
  assert.deepEqual([data.summary.completed_latency_ms.count, data.summary.completed_latency_ms.p95], [1, 35]);
  assert.deepEqual([data.summary.ttft_ms.count, data.summary.ttft_ms.p95], [1, 12]);
  assert.deepEqual(data.summary.usage.input, { tokens: 20, reported: 1 });
  assert.equal(data.summary.usage.input_cache_read.tokens, 5);
  assert.deepEqual(data.summary.input_cache_rate, { percent: 25, reported: 1 });
  assert.equal(data.models[0].input_cache_rate.percent, 25);
  assert.equal(data.trend[0].input_cache_rate.percent, 25);
  assert.equal(data.trend[2].input_cache_rate.percent, null);
  assert.equal(data.trend[0].latency_ms.avg, 35);
  assert.equal(data.trend[2].latency_ms.avg, 65);
  assert.equal(data.summary.usage.output.tokens, 0);
  // Copilot never reports output caching; the client hides unreported fields.
  assert.deepEqual(data.summary.usage.output_cache_read, { tokens: null, reported: 0 });
  assert.equal(data.models.length, 1);
});

test("averages preserve fractional values; percentiles use nearest rank", () => {
  const data = report({ from: 0, to: 10, step: 10 }, [
    sample(1, "a", { duration_ms: 2 }),
    sample(2, "a", { duration_ms: 1 }),
    sample(3, "a", { duration_ms: 100 }),
  ]);
  assert.deepEqual(data.summary.latency_ms, { count: 3, avg: 103 / 3, p50: 2, p95: 100, p99: 100 });
  const empty = report({ from: 0, to: 10, step: 10 }, []);
  assert.deepEqual(empty.summary.latency_ms, { count: 0, avg: null, p50: null, p95: null, p99: null });
});

test("cache hit rate is token-weighted over paired observations", () => {
  const pairs: Array<[number | null, number | null]> = [
    [100, 80], [900, 90], [1_000, null], [null, 1_000], [0, 0], [null, null], [10, 11],
  ];
  const data = report(
    { from: 0, to: 10, step: 10 },
    pairs.map(([input, read], index) =>
      sample(index, "a", { duration_ms: 1, input, input_cache_read: read, input_cache_write: 50 })
    )
  );
  // 170 / 1000 = 17%, not mean(80%, 10%) or a ratio of unpaired totals.
  assert.deepEqual(data.summary.input_cache_rate, { percent: 17, reported: 3 });
  assert.equal(data.summary.latency_ms.avg, 1);
  assert.equal(data.summary.ttft_ms.avg, null);

  const rate = (input: number, read: number) =>
    report({ from: 0, to: 10, step: 10 }, [sample(1, "a", { input, input_cache_read: read })]).summary.input_cache_rate;
  assert.deepEqual(rate(0, 0), { percent: null, reported: 1 });
  assert.equal(rate(100, 0).percent, 0);
  assert.equal(rate(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).percent, 100);
});

test("validates windows and bucket steps like llm-proxy", () => {
  const resolve = (from: number, to: number, step?: number) =>
    resolveMetricsWindow({ from: String(from), to: String(to), step: step === undefined ? undefined : String(step) }, 0);
  assert.throws(() => resolve(0, MAX_WINDOW_MS + 1), MetricsQueryError);
  assert.throws(() => resolve(1, 1), MetricsQueryError);
  assert.throws(() => resolve(50, 20), MetricsQueryError);
  assert.throws(() => resolve(-1, 20), MetricsQueryError);
  // Default: 48 buckets, rounded up so the last bucket ends at or after `to`.
  assert.equal(resolve(0, DAY_MS).step, 1_800_000);
  assert.equal(resolve(0, 49).step, 2);
  // Explicit steps: at least one second and at most 240 buckets.
  assert.equal(resolve(0, 240_000, 1_000).step, 1_000);
  assert.throws(() => resolve(0, 240_001, 1_000), MetricsQueryError);
  assert.throws(() => resolve(0, 60_000, 999), MetricsQueryError);
  assert.throws(() => resolve(0, 60_000, -1), MetricsQueryError);
  assert.equal(resolve(0, 60_000, MAX_WINDOW_MS).step, MAX_WINDOW_MS);
  assert.throws(() => resolve(0, 60_000, Number.MAX_SAFE_INTEGER), MetricsQueryError);

  // Query strings that are not integers are rejected rather than coerced.
  for (const query of [{ from: "1e3", to: "5000" }, { from: "0", to: "abc" }, { from: "0", to: "60000", step: "1.5" }]) {
    assert.throws(() => resolveMetricsWindow(query, 0), MetricsQueryError);
  }
  assert.throws(() => resolveMetricsWindow({ model: "m".repeat(4097) }, DAY_MS), /too long/);

  const now = 10 * DAY_MS;
  assert.deepEqual(resolveMetricsWindow({}, now), { from: now - DAY_MS, to: now, model: undefined, step: 1_800_000 });
  assert.equal(resolveMetricsWindow({ model: "" }, now).model, undefined);
  assert.equal(resolveMetricsWindow({ model: "gpt-6.1-sol" }, now).model, "gpt-6.1-sol");
});

test("an empty report keeps the partial last bucket and missing usage", () => {
  const data = report({ from: 10, to: 2_510, step: 1_000 }, []);
  assert.equal(data.summary.requests, 0);
  assert.deepEqual([data.results, data.endpoints], [[], []]);
  assert.equal(data.trend.length, 3);
  assert.deepEqual([data.trend[2].start, data.trend[2].end], [2_010, 2_510]);
  for (const bucket of data.trend) {
    assert.equal(bucket.requests, 0);
    assert.equal(bucket.usage.input.tokens, null);
    assert.equal(bucket.latency_ms.p95, null);
    assert.equal(bucket.latency_ms.avg, null);
    assert.deepEqual(bucket.input_cache_rate, { percent: null, reported: 0 });
  }
});

test("output speed counts visible tokens of successful streamed requests only", () => {
  const speed = (overrides: Partial<MetricSample>) =>
    report({ from: 0, to: 10, step: 10 }, [
      sample(1, "a", { duration_ms: 1_100, first_token_ms: 100, output: 101, reasoning: 0, ...overrides }),
    ]).summary.output_tps;
  assert.deepEqual(speed({}), { count: 1, p50: 100, overall: 100 });
  // Hidden reasoning happens before the first visible token, so it is not generation speed.
  assert.deepEqual(speed({ reasoning: 50 }), { count: 1, p50: 50, overall: 50 });
  for (const excluded of [
    { outcome: "stream_error" },
    { status: 500 },
    { first_token_ms: null },
    { output: null },
    { reasoning: null }, // rows written before reasoning tokens were recorded
    { output: 1 },
    { output: 101, reasoning: 100 },
    { duration_ms: 100 },
    { first_token_ms: 200, duration_ms: 100 },
  ]) {
    assert.deepEqual(speed(excluded), { count: 0, p50: null, overall: null }, JSON.stringify(excluded));
  }

  const data = report({ from: 0, to: 10, step: 10 }, [
    sample(1, "a", { duration_ms: 1_100, first_token_ms: 100, output: 11, reasoning: 0 }),
    sample(2, "a", { duration_ms: 1_100, first_token_ms: 100, output: 301, reasoning: 0 }),
    sample(3, "a", { duration_ms: 1_100, first_token_ms: 100, output: 21, reasoning: 0 }),
  ]);
  assert.deepEqual(data.summary.output_tps, { count: 3, p50: 20, overall: 110 });
});

test("model trend covers the busiest models per bucket", () => {
  const streamed = (ts: number, model: string, duration: number, ttft: number | null, output: number | null, outcome = "ok") =>
    sample(ts, model, { duration_ms: duration, first_token_ms: ttft, output, reasoning: 0, outcome });
  const samples = [
    streamed(10, "alpha", 1_100, 100, 101),
    streamed(12, "alpha", 600, 100, 26),
    streamed(21, "alpha", 900, 100, 500, "stream_error"),
    streamed(22, "alpha", 900, null, 500),
    streamed(23, "alpha", 900, 100, 1),
    streamed(11, "beta", 300, 300, 9),
    streamed(24, "beta", 300, 100, 41),
    ...Array.from({ length: 9 }, (_, index) => sample(15, `gamma${index}`)),
  ];
  const data = report({ from: 10, to: 30, step: 10 }, samples);
  assert.equal(data.trend.length, 2);
  assert.deepEqual(
    data.model_trend.map((item) => item.model),
    ["alpha", "beta", "gamma0", "gamma1", "gamma2", "gamma3", "gamma4", "gamma5"]
  );
  const [first, second] = data.model_trend[0].points;
  assert.ok(first && second);
  assert.deepEqual([first.requests, first.errors], [2, 0]);
  assert.equal(first.latency_ms.p50, 600);
  assert.deepEqual([first.output_tps.count, first.output_tps.p50], [2, 50]);
  assert.ok(Math.abs(first.output_tps.overall! - 125_000 / 1_500) < 1e-9);
  assert.deepEqual([second.requests, second.errors], [3, 1]);
  assert.deepEqual([second.latency_ms.count, second.completed_latency_ms.count], [3, 2]);
  assert.deepEqual([second.output_tps.count, second.output_tps.p50], [0, null]);
  assert.equal(data.model_trend[2].points[1], null);
  assert.equal(data.model_trend[1].points[0]?.output_tps.count, 0);
  assert.equal(data.model_trend[1].points[1]?.output_tps.p50, 200);
  assert.deepEqual([data.summary.output_tps.count, data.summary.output_tps.p50], [3, 100]);
  assert.equal(data.models[0].model, "alpha");
  assert.equal(data.models[0].output_tps.p50, 50);
  assert.equal(data.models.length, 11);
});

test("breakdowns are bounded and sorted by volume, then name", () => {
  const samples = [
    ...Array.from({ length: 60 }, (_, index) => sample(1, "a", { endpoint: `group_${String(index).padStart(2, "0")}` })),
    ...Array.from({ length: 100 }, () => sample(1, "a", { endpoint: "largest" })),
  ];
  const { endpoints } = report({ from: 0, to: 10, step: 10 }, samples);
  assert.equal(endpoints.length, 50);
  assert.equal(endpoints[0].name, "largest");
  assert.equal(endpoints[1].name, "group_00");
  assert.equal(endpoints[49].name, "group_48");
});

test("labels results by outcome and status", () => {
  const label = (status: number, outcome: string) =>
    report({ from: 0, to: 10, step: 10 }, [sample(1, "a", { status, outcome })]).results[0].name;
  assert.equal(label(200, "ok"), "ok");
  assert.equal(label(204, "success"), "ok");
  assert.equal(label(429, "http_error"), "http_429");
  assert.equal(label(500, "ok"), "http_500");
  assert.equal(label(200, "stream_error"), "stream_error");
  assert.equal(label(499, "cancelled"), "cancelled");
  assert.equal(label(504, "timeout"), "timeout");
  assert.equal(label(400, "rejected"), "rejected");
});

test("reports only the newest ROW_LIMIT requests and flags truncation", () => {
  const samples = Array.from({ length: ROW_LIMIT + 1 }, () => sample(5, "a"));
  const data = buildMetricsReport(
    { from: 0, to: 10, step: 10 },
    { samples, availableModels: ["a"], modelListTruncated: false, droppedSinceStart: 3 }
  );
  assert.equal(data.truncated, true);
  assert.equal(data.summary.requests, ROW_LIMIT);
  assert.equal(data.dropped_since_start, 3);
  assert.deepEqual(data.available_models, ["a"]);
  assert.equal(report({ from: 0, to: 10, step: 10 }, [sample(5, "a")]).truncated, false);
});
