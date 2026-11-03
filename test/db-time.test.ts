import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import initSqlJs from "sql.js/dist/sql-asm.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getDb,
  getStatsOverview,
  logUsage,
  getTimeSeries,
  getTopIps,
  getTopModels,
  initDatabase,
  toSqliteUtcTimestamp,
} from "../src/lib/db.js";

test("normalizes browser UTC timestamps to SQLite timestamp text", () => {
  assert.equal(
    toSqliteUtcTimestamp("2026-09-02T08:23:45Z"),
    "2026-09-02 08:23:45"
  );
});

test("converts explicit timezone offsets to UTC", () => {
  assert.equal(
    toSqliteUtcTimestamp("2026-09-02T16:23:45+08:00"),
    "2026-09-02 08:23:45"
  );
});

test("treats legacy timestamps without an offset as UTC", () => {
  assert.equal(
    toSqliteUtcTimestamp("2026-09-02T08:23:45"),
    "2026-09-02 08:23:45"
  );
});

test("rejects invalid timestamps", () => {
  assert.throws(() => toSqliteUtcTimestamp("not-a-time"), /Invalid timestamp/);
});

test("queries same-day UTC ranges and groups chart buckets in browser local time", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "copilot-proxy-db-test-"));
  try {
    await initDatabase(dataDir);
    getDb().run(
      `INSERT INTO usage_logs (
        timestamp, ip, model, endpoint, prompt_tokens, completion_tokens,
        total_tokens, cached_prompt_tokens, stream, duration_ms, ttfb_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["2026-09-02 08:30:00", "127.0.0.1", "test-model", "openai", 100, 20, 120, 40, 1, 500, 100]
    );

    const range = {
      start: "2026-09-02T06:00:00Z",
      end: "2026-09-02T12:00:00Z",
      granularity: "1h",
      timezoneOffsetMinutes: -480,
    };

    assert.equal(getStatsOverview(range).total_requests, 1);
    assert.deepEqual(getTimeSeries(range).map((point) => point.time_bucket), ["2026-09-02 16:00"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("persists and aggregates cache writes separately from cache reads", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "copilot-proxy-db-test-"));
  try {
    await initDatabase(dataDir);
    logUsage({
      ip: "client-cache",
      model: "gpt-5.6-sol",
      endpoint: "responses",
      prompt_tokens: 1_000,
      completion_tokens: 100,
      total_tokens: 1_100,
      cached_prompt_tokens: 800,
      cache_write_prompt_tokens: 120,
      stream: false,
      duration_ms: 200,
      ttfb_ms: 0,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const range = {
      start: "2000-01-01T00:00:00Z",
      end: "2100-01-01T00:00:00Z",
    };
    const overview = getStatsOverview(range);
    assert.equal(overview.total_cached_prompt_tokens, 800);
    assert.equal(overview.total_cache_write_prompt_tokens, 120);
    assert.equal(getTimeSeries(range)[0]?.cache_write_prompt_tokens, 120);
    assert.equal(getTopModels(range)[0]?.cache_write_prompt_tokens, 120);
    assert.equal(getTopIps(range)[0]?.cache_write_prompt_tokens, 120);
    // Cache writes remain part of regular input pricing; only cache reads receive
    // the discounted rate.
    assert.equal(overview.total_credits, 0.312);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("reports per-model latency percentiles and prices IP usage per model", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "copilot-proxy-db-test-"));
  try {
    await initDatabase(dataDir);
    const insert = getDb().prepare(
      `INSERT INTO usage_logs (
        timestamp, ip, model, endpoint, prompt_tokens, completion_tokens,
        total_tokens, cached_prompt_tokens, stream, duration_ms, ttfb_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const rows = [
      ["2026-09-02 08:00:00", "client-a", "gpt-5.6-sol", "openai", 1_000_000, 0, 1_000_000, 0, 1, 1_000, 100],
      ["2026-09-02 08:01:00", "client-a", "gpt-5.6-sol", "openai", 0, 0, 0, 0, 1, 2_000, 200],
      ["2026-09-02 08:02:00", "client-a", "gpt-5.6-sol", "openai", 0, 0, 0, 0, 1, 3_000, 300],
      // Legacy non-streaming rows incorrectly stored duration as TTFB. They must
      // not contaminate TTFT aggregates.
      ["2026-09-02 08:02:30", "client-a", "gpt-5.6-sol", "openai", 0, 0, 0, 0, 0, 9_000, 9_000],
      ["2026-09-02 08:03:00", "client-a", "gpt-5.6-sol-fast", "openai", 1_000_000, 0, 1_000_000, 0, 1, 4_000, 400],
    ];
    for (const row of rows) insert.run(row);
    insert.free();

    const range = {
      start: "2026-09-02T07:00:00Z",
      end: "2026-09-02T09:00:00Z",
    };
    const models = getTopModels(range);
    const sol = models.find((entry) => entry.name === "gpt-5.6-sol");
    assert.ok(sol);
    assert.equal(sol.ttfb_samples, 3);
    assert.equal(sol.avg_ttfb_ms, 200);
    assert.equal(sol.p50_ttfb_ms, 200);
    assert.equal(sol.p95_ttfb_ms, 300);
    assert.equal(sol.avg_duration_ms, 3_750);
    assert.equal(getStatsOverview(range).avg_ttfb_ms, 250);

    const ip = getTopIps(range)[0];
    assert.equal(ip.name, "client-a");
    assert.equal(ip.prompt_tokens, 2_000_000);
    assert.equal(ip.credits, 1_200);
    assert.equal(ip.cost_usd, 12);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("additive usage-known migration preserves legacy rows and exposes unknown counts", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "copilot-proxy-db-migration-test-"));
  try {
    const SQL = await initSqlJs();
    const legacy = new SQL.Database();
    legacy.run(
      `CREATE TABLE usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        ip TEXT NOT NULL, model TEXT NOT NULL, endpoint TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        stream INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO usage_logs (ip, model, endpoint, prompt_tokens, completion_tokens, total_tokens)
      VALUES ('legacy-client', 'gpt-5.4', 'openai', 10, 2, 12);`
    );
    await writeFile(join(dataDir, "usage.db"), Buffer.from(legacy.export()));
    legacy.close();
    await initDatabase(dataDir);
    // Reinitializing is idempotent and preserves the migrated data/defaults.
    await initDatabase(dataDir);
    assert.deepEqual(getDb().exec("SELECT usage_known, total_tokens FROM usage_logs")[0].values, [[1, 12]]);
    const column = getDb().exec("PRAGMA table_info(usage_logs)")[0].values
      .find((row) => row[1] === "usage_known");
    assert.ok(column);
    assert.equal(column[3], 1); // NOT NULL
    assert.equal(String(column[4]), "1");

    const base = {
      ip: "native-client", model: "loki/gpt-5.4", endpoint: "openai",
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      stream: true, duration_ms: 20, ttfb_ms: 0,
    };
    logUsage({ ...base, usage_known: false });
    logUsage({ ...base }); // Existing callers without the flag remain known.
    logUsage({ ...base, usage_known: true }); // Real zero usage is distinct from unknown.
    logUsage({ ...base, usage_known: false, model: "loki/anthropic", prompt_tokens: 5, total_tokens: 5 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(getDb().exec("SELECT usage_known FROM usage_logs ORDER BY id")[0].values, [[1], [0], [1], [1], [0]]);
    const range = { start: "2000-01-01T00:00:00Z", end: "2100-01-01T00:00:00Z" };
    const overview = getStatsOverview(range);
    assert.equal(overview.total_requests, 5);
    assert.equal(overview.unknown_usage_requests, 2);
    assert.equal(overview.total_tokens, 17);
    assert.equal(overview.unpriced_tokens, 5);
    assert.equal(getTopModels(range).find((row) => row.name === "loki/gpt-5.4")?.unknown_usage_requests, 1);
    assert.equal(getTopModels(range).find((row) => row.name === "gpt-5.4")?.unknown_usage_requests, 0);
    const ip = getTopIps(range).find((row) => row.name === "native-client");
    assert.equal(ip?.requests, 4);
    assert.equal(ip?.unknown_usage_requests, 2);
    assert.equal(ip?.credits, null);
    for (const granularity of ["1m", "5m", "1h", "1d"]) {
      assert.equal(getTimeSeries({ ...range, granularity })[0]?.unknown_usage_requests, 2);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    getDb().close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
