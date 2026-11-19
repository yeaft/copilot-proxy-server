import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  closeDatabase,
  getDb,
  getStatsOverview,
  logUsage,
  getTimeSeries,
  getTopIps,
  getTopModels,
  initDatabase,
  toSqliteUtcTimestamp,
} from "../src/lib/db.js";
import { logger } from "../src/lib/logger.js";

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
    getDb().prepare(
      `INSERT INTO usage_logs (
        timestamp, ip, model, endpoint, prompt_tokens, completion_tokens,
        total_tokens, cached_prompt_tokens, stream, duration_ms, ttfb_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("2026-09-02 08:30:00", "127.0.0.1", "test-model", "openai", 100, 20, 120, 40, 1, 500, 100);

    const range = {
      start: "2026-09-02T06:00:00Z",
      end: "2026-09-02T12:00:00Z",
      granularity: "1h",
      timezoneOffsetMinutes: -480,
    };

    assert.equal(getStatsOverview(range).total_requests, 1);
    assert.deepEqual(getTimeSeries(range).map((point) => point.time_bucket), ["2026-09-02 16:00"]);
  } finally {
    closeDatabase();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("persists immediately across reopen without timer flush and aggregates cache writes separately", async () => {
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

    // Reopen database immediately without waiting for any 1s timer to prove native WAL persistence.
    await initDatabase(dataDir);

    const range = {
      start: "2000-01-01T00:00:00Z",
      end: "2100-01-01T00:00:00Z",
    };
    const overview = getStatsOverview(range);
    assert.equal(overview.total_requests, 1);
    assert.equal(overview.total_cached_prompt_tokens, 800);
    assert.equal(overview.total_cache_write_prompt_tokens, 120);
    assert.equal(getTimeSeries(range)[0]?.cache_write_prompt_tokens, 120);
    assert.equal(getTopModels(range)[0]?.cache_write_prompt_tokens, 120);
    assert.equal(getTopIps(range)[0]?.cache_write_prompt_tokens, 120);
    // Cache writes remain part of regular input pricing; only cache reads receive
    // the discounted rate.
    assert.equal(overview.total_credits, 0.312);
  } finally {
    closeDatabase();
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
    const rows: Array<[string, string, string, string, number, number, number, number, number, number, number]> = [
      ["2026-09-02 08:00:00", "client-a", "gpt-5.6-sol", "openai", 1_000_000, 0, 1_000_000, 0, 1, 1_000, 100],
      ["2026-09-02 08:01:00", "client-a", "gpt-5.6-sol", "openai", 0, 0, 0, 0, 1, 2_000, 200],
      ["2026-09-02 08:02:00", "client-a", "gpt-5.6-sol", "openai", 0, 0, 0, 0, 1, 3_000, 300],
      // Legacy non-streaming rows incorrectly stored duration as TTFB. They must
      // not contaminate TTFT aggregates.
      ["2026-09-02 08:02:30", "client-a", "gpt-5.6-sol", "openai", 0, 0, 0, 0, 0, 9_000, 9_000],
      ["2026-09-02 08:03:00", "client-a", "gpt-5.6-sol-fast", "openai", 1_000_000, 0, 1_000_000, 0, 1, 4_000, 400],
    ];
    for (const row of rows) insert.run(...row);

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
    closeDatabase();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("migrates legacy databases and tolerates extra columns on existing usage.db files", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "copilot-proxy-db-migration-test-"));
  try {
    const legacyPath = join(dataDir, "usage.db");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(
      `CREATE TABLE usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        ip TEXT NOT NULL, model TEXT NOT NULL, endpoint TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        usage_known INTEGER NOT NULL DEFAULT 1,
        stream INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO usage_logs (ip, model, endpoint, prompt_tokens, completion_tokens, total_tokens)
      VALUES ('legacy-client', 'gpt-5.4', 'openai', 10, 2, 12);`
    );
    legacy.close();

    await initDatabase(dataDir);
    // Reinitializing is idempotent and preserves existing data.
    await initDatabase(dataDir);

    const journalMode = (getDb().prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    assert.equal(journalMode.toLowerCase(), "wal");

    logUsage({
      ip: "new-client",
      model: "gpt-5.4",
      endpoint: "openai",
      prompt_tokens: 20,
      completion_tokens: 5,
      total_tokens: 25,
      cached_prompt_tokens: 10,
      stream: true,
      duration_ms: 100,
      ttfb_ms: 30,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const range = { start: "2000-01-01T00:00:00Z", end: "2100-01-01T00:00:00Z" };
    const overview = getStatsOverview(range);
    assert.equal(overview.total_requests, 2);
    assert.equal(overview.total_tokens, 37);
    assert.equal(overview.total_cached_prompt_tokens, 10);
  } finally {
    closeDatabase();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("logger evaluates lazy formatting callbacks only when the level is active", () => {
  let calls = 0;
  logger.setLevel("info");
  logger.debug("payload:", () => {
    calls++;
    return "serialized";
  });
  assert.equal(calls, 0);

  const originalDebug = console.debug;
  const captured: unknown[][] = [];
  console.debug = (...args: unknown[]) => {
    captured.push(args);
  };
  try {
    logger.setLevel("debug");
    logger.debug("payload:", () => {
      calls++;
      return "serialized";
    });
    assert.equal(calls, 1);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.[1], "payload:");
    assert.equal(captured[0]?.[2], "serialized");
  } finally {
    console.debug = originalDebug;
    logger.setLevel("info");
  }
});
