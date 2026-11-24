import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  closeDatabase,
  getDb,
  initDatabase,
  logUsage,
  readMetricSamples,
  type UsageRecord,
} from "../src/lib/db.js";
import { logger } from "../src/lib/logger.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const ALL_TIME = { from: Date.UTC(2000, 0, 1), to: Date.UTC(2100, 0, 1), step: 1_000_000_000 };

async function withDataDir(run: (dataDir: string) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), "copilot-proxy-db-test-"));
  try {
    await run(dataDir);
  } finally {
    closeDatabase();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ip: "client",
    model: "gpt-6.1-sol",
    endpoint: "responses",
    status: 200,
    outcome: "ok",
    stream: true,
    duration_ms: 1_200,
    first_token_ms: 300,
    usage: { input: 1_000, output: 120, cacheRead: 800, cacheWrite: 50, reasoning: 20 },
    ...overrides,
  };
}

const LEGACY_SCHEMAS = {
  // The first released schema, before TTFT and cache columns.
  original: `CREATE TABLE usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    ip TEXT NOT NULL, model TEXT NOT NULL, endpoint TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    stream INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0
  )`,
  // The production usage.db: usage_known was added by the removed Loki integration.
  production: `CREATE TABLE usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    ip TEXT NOT NULL, model TEXT NOT NULL, endpoint TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    stream INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    ttfb_ms INTEGER NOT NULL DEFAULT 0,
    cached_prompt_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_prompt_tokens INTEGER NOT NULL DEFAULT 0,
    usage_known INTEGER NOT NULL DEFAULT 1
  )`,
};

for (const [name, schema] of Object.entries(LEGACY_SCHEMAS)) {
  test(`migrates the ${name} schema in place; existing rows read as completed requests`, async () => {
    await withDataDir(async (dataDir) => {
      const legacy = new DatabaseSync(join(dataDir, "usage.db"));
      legacy.exec(schema);
      legacy.exec(
        `INSERT INTO usage_logs (timestamp, ip, model, endpoint, prompt_tokens, completion_tokens, total_tokens, stream, duration_ms)
         VALUES ('2026-09-02 08:30:00', 'legacy-client', 'gpt-5.4', 'openai', 10, 2, 12, 1, 500)`
      );
      legacy.close();

      await initDatabase(dataDir);
      // Reinitializing is idempotent and preserves existing data.
      await initDatabase(dataDir);
      const journal = getDb().prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      assert.equal(journal.journal_mode.toLowerCase(), "wal");

      logUsage(record({ model: "gpt-5.4", endpoint: "openai" }));
      await flush();

      const { samples } = readMetricSamples(ALL_TIME, 100, 10);
      assert.equal(samples.length, 2);
      const old = samples.find((row) => row.ts === Date.UTC(2026, 8, 2, 8, 30));
      assert.ok(old);
      assert.deepEqual(
        { ...old },
        {
          ts: Date.UTC(2026, 8, 2, 8, 30),
          model: "gpt-5.4",
          endpoint: "openai",
          status: 200,
          outcome: "ok",
          duration_ms: 500,
          first_token_ms: null,
          input: 10,
          output: 2,
          input_cache_read: 0,
          input_cache_write: 0,
          // Unknown for legacy rows, which keeps them out of output speed.
          reasoning: null,
        }
      );
    });
  });
}

test("logs outcomes, usage and first-token timing and persists them across reopen", async () => {
  await withDataDir(async (dataDir) => {
    await initDatabase(dataDir);
    logUsage(record());
    logUsage(record({
      model: "gemini-4-carbon",
      endpoint: "gemini",
      status: 502,
      outcome: "http_error",
      stream: false,
      first_token_ms: 999, // ignored: only streamed responses have a first token
      usage: null,
    }));
    logUsage(record({ model: "gpt-6-luna", status: 499, outcome: "cancelled", first_token_ms: null, usage: null }));
    await flush();

    // Reopen immediately: WAL persistence must not depend on a timer flush.
    await initDatabase(dataDir);
    const rows = readMetricSamples(ALL_TIME, 100, 10).samples;
    const byModel = new Map(rows.map((row) => [row.model, { ...row }]));

    assert.deepEqual(
      { ...byModel.get("gpt-6.1-sol"), ts: 0 },
      {
        ts: 0,
        model: "gpt-6.1-sol",
        endpoint: "responses",
        status: 200,
        outcome: "ok",
        duration_ms: 1_200,
        first_token_ms: 300,
        input: 1_000,
        output: 120,
        input_cache_read: 800,
        input_cache_write: 50,
        reasoning: 20,
      }
    );
    const failed = byModel.get("gemini-4-carbon");
    assert.deepEqual(
      [failed?.status, failed?.outcome, failed?.input, failed?.output, failed?.reasoning],
      [502, "http_error", null, null, null]
    );
    const cancelled = byModel.get("gpt-6-luna");
    assert.deepEqual([cancelled?.status, cancelled?.outcome, cancelled?.first_token_ms], [499, "cancelled", null]);

    const stored = getDb().prepare(
      "SELECT total_tokens, usage_known, ttfb_ms, stream FROM usage_logs WHERE model = 'gemini-4-carbon'"
    ).get() as Record<string, number>;
    assert.deepEqual({ ...stored }, { total_tokens: 0, usage_known: 0, ttfb_ms: 0, stream: 0 });
  });
});

test("reads [from, to) at second resolution, filters by model and caps rows", async () => {
  await withDataDir(async (dataDir) => {
    await initDatabase(dataDir);
    const insert = getDb().prepare("INSERT INTO usage_logs (timestamp, ip, model, endpoint) VALUES (?, 'ip', ?, 'openai')");
    insert.run("2026-09-02 07:59:59", "before");
    insert.run("2026-09-02 08:00:00", "alpha");
    insert.run("2026-09-02 08:00:01", "beta");
    insert.run("2026-09-02 08:00:01", "alpha");
    insert.run("2026-09-02 08:00:02", "gamma");

    const at = (seconds: number) => Date.UTC(2026, 8, 2, 8, 0, seconds);
    const models = (from: number, to: number, model?: string, limit = 100) =>
      readMetricSamples({ from, to, model, step: 1_000 }, limit, 10).samples.map((row) => row.model);

    assert.deepEqual(models(at(0), at(1)), ["alpha"]);
    // A row stamped at second S belongs to the window when from <= S * 1000 < to.
    assert.deepEqual(models(at(0), at(1) + 1), ["alpha", "beta", "alpha"]);
    assert.deepEqual(models(at(0) + 1, at(2)), ["alpha", "beta"]);
    // Newest first; ties keep insertion order, newest id first.
    assert.deepEqual(models(at(0), at(3)), ["gamma", "alpha", "beta", "alpha"]);
    assert.deepEqual(models(at(0), at(3), "alpha"), ["alpha", "alpha"]);
    // One row beyond the limit, so the report can flag truncation.
    assert.deepEqual(models(at(0), at(3), undefined, 2), ["gamma", "alpha", "beta"]);

    // The model list ignores the model filter and is bounded.
    const filtered = readMetricSamples({ from: at(0), to: at(3), model: "alpha", step: 1_000 }, 100, 2);
    assert.deepEqual(filtered.availableModels, ["alpha", "beta"]);
    assert.equal(filtered.modelListTruncated, true);
    const all = readMetricSamples({ from: at(0), to: at(3), step: 1_000 }, 100, 10);
    assert.deepEqual(all.availableModels, ["alpha", "beta", "gamma"]);
    assert.equal(all.modelListTruncated, false);
  });
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
