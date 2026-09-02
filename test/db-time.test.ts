import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getDb,
  getStatsOverview,
  getTimeSeries,
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
