import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import path from "node:path";

import { logger } from "./logger.js";
import type { MetricSample, MetricsWindow } from "./metrics-report.js";

/** How a proxied model request ended. Same vocabulary as llm-proxy's analytics. */
export type RequestOutcome =
  /** Completed normally. */
  | "ok"
  /** Refused before reaching the upstream (for example an invalid request body). */
  | "rejected"
  /** The upstream (or the proxy's rate limiter) answered with an HTTP error. */
  | "http_error"
  /** Connection, read or translation failure. */
  | "upstream_error"
  /** The upstream sent no response headers in time. */
  | "timeout"
  /** The upstream reported a failure inside the stream. */
  | "stream_error"
  /** The stream ended without a terminal event. */
  | "incomplete"
  /** The client disconnected before the response completed. */
  | "cancelled";

export interface TokenUsage {
  /** All input tokens, including cache reads and writes. */
  input: number;
  /** All output tokens, including reasoning. */
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Reasoning tokens counted in `output`. */
  reasoning: number;
}

export interface UsageRecord {
  ip: string;
  model: string;
  endpoint: string;
  status: number;
  outcome: RequestOutcome;
  stream: boolean;
  duration_ms: number;
  /** Time to the first visible output of a streamed response; null when not observed. */
  first_token_ms: number | null;
  /** null when the upstream did not report usage. */
  usage: TokenUsage | null;
}

/**
 * Columns added after the first release. Existing databases gain them in place,
 * and older builds keep working because their INSERT names its columns.
 * Rows written before outcome tracking were only logged for handled responses,
 * hence the `ok` / 200 / usage-known defaults.
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [name: string, definition: string]> = [
  ["ttfb_ms", "INTEGER NOT NULL DEFAULT 0"],
  ["cached_prompt_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["cache_write_prompt_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["usage_known", "INTEGER NOT NULL DEFAULT 1"],
  ["reasoning_tokens", "INTEGER"],
  ["status", "INTEGER NOT NULL DEFAULT 200"],
  ["outcome", "TEXT NOT NULL DEFAULT 'ok'"],
];

let db: DatabaseSync | null = null;
let dbPath: string = "";
let insertStmt: StatementSync | null = null;
let signalsRegistered = false;
let droppedRecords = 0;

export function closeDatabase(): void {
  insertStmt = null;
  if (!db) return;
  const current = db;
  db = null;
  try {
    current.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // Best-effort checkpoint; may fail on read-only or non-WAL databases.
  }
  try {
    current.close();
  } catch (err) {
    logger.error("Failed to close database:", err);
  }
}

function columnNames(database: DatabaseSync): Set<string> {
  const rows = database.prepare("PRAGMA table_info(usage_logs)").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function addMissingColumns(database: DatabaseSync): void {
  const existing = columnNames(database);
  for (const [name, definition] of ADDED_COLUMNS) {
    if (existing.has(name)) continue;
    try {
      database.exec(`ALTER TABLE usage_logs ADD COLUMN ${name} ${definition}`);
    } catch (err) {
      // Another process sharing the file may have added it first.
      if (!columnNames(database).has(name)) throw err;
    }
  }
}

export async function initDatabase(dataDir: string): Promise<void> {
  closeDatabase();

  dbPath = path.join(dataDir, "usage.db");
  db = new DatabaseSync(dbPath);

  // Enable WAL mode for fast incremental appends without blocking readers or serializing the whole DB.
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    const modeRow = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | undefined;
    if (modeRow?.journal_mode?.toLowerCase() === "wal") {
      db.exec("PRAGMA synchronous = NORMAL");
    } else {
      logger.warn(`SQLite WAL mode unavailable (active mode: ${modeRow?.journal_mode ?? "unknown"}); using default synchronous mode.`);
    }
  } catch (err) {
    logger.warn("Could not enable SQLite WAL mode, falling back to default journal mode:", err);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      ip TEXT NOT NULL,
      model TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cached_prompt_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_prompt_tokens INTEGER NOT NULL DEFAULT 0,
      stream INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      ttfb_ms INTEGER NOT NULL DEFAULT 0,
      usage_known INTEGER NOT NULL DEFAULT 1,
      reasoning_tokens INTEGER,
      status INTEGER NOT NULL DEFAULT 200,
      outcome TEXT NOT NULL DEFAULT 'ok'
    );

    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_ip ON usage_logs(ip);
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_logs(model);
  `);
  addMissingColumns(db);

  insertStmt = db.prepare(`
    INSERT INTO usage_logs (
      ip, model, endpoint, prompt_tokens, completion_tokens, total_tokens,
      cached_prompt_tokens, cache_write_prompt_tokens, stream, duration_ms, ttfb_ms,
      usage_known, reasoning_tokens, status, outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  if (!signalsRegistered) {
    signalsRegistered = true;
    process.once("SIGTERM", () => {
      closeDatabase();
      process.exit(0);
    });
    process.once("SIGINT", () => {
      closeDatabase();
      process.exit(0);
    });
  }

  logger.info(`Usage database initialized at ${dbPath}`);
}

/**
 * Asynchronously log usage record — never blocks the API response.
 */
export function logUsage(record: UsageRecord): void {
  if (!db || !insertStmt) return;
  setImmediate(() => {
    if (!db || !insertStmt) return;
    const usage = record.usage;
    try {
      insertStmt.run(
        record.ip,
        record.model,
        record.endpoint,
        usage?.input ?? 0,
        usage?.output ?? 0,
        usage ? usage.input + usage.output : 0,
        usage?.cacheRead ?? 0,
        usage?.cacheWrite ?? 0,
        record.stream ? 1 : 0,
        Math.max(0, Math.round(record.duration_ms)),
        // 0 means "not observed"; only streamed responses have a first token.
        record.stream ? record.first_token_ms ?? 0 : 0,
        usage ? 1 : 0,
        usage ? usage.reasoning : null,
        record.status,
        record.outcome
      );
    } catch (err) {
      droppedRecords++;
      logger.error("Failed to log usage:", err);
    }
  });
}

/** Usage rows that could not be written since the process started. */
export function droppedUsageRecords(): number {
  return droppedRecords;
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error("Database not initialized");
  return db;
}

/** File path of the open usage database, for readers on other threads. */
export function getDatabasePath(): string {
  if (!db) throw new Error("Database not initialized");
  return dbPath;
}

/** SQLite `datetime('now')` text for the first whole second at or after `ms`. */
function secondAtOrAfter(ms: number): string {
  return new Date(Math.ceil(ms / 1000) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

export interface MetricSamples {
  /** Newest first; one row beyond `rowLimit` when more matched, so the report can flag truncation. */
  samples: Array<MetricSample>;
  /** Distinct models among the newest `rowLimit` rows of the window, ignoring the model filter. */
  availableModels: Array<string>;
  modelListTruncated: boolean;
}

/**
 * Rows whose timestamp falls in [from, to). Timestamps have second resolution, so a row
 * stamped at second S belongs to the window when from <= S * 1000 < to.
 */
export function readMetricSamples(
  window: MetricsWindow,
  rowLimit: number,
  modelLimit: number,
  database: DatabaseSync = getDb()
): MetricSamples {
  const range: Array<SQLInputValue> = [secondAtOrAfter(window.from), secondAtOrAfter(window.to)];

  const models = (database.prepare(
    `SELECT DISTINCT model FROM (
       SELECT model FROM usage_logs WHERE timestamp >= ? AND timestamp < ?
       ORDER BY timestamp DESC, id DESC LIMIT ?
     ) ORDER BY model LIMIT ?`
  ).all(...range, rowLimit, modelLimit + 1) as Array<{ model: string }>).map((row) => row.model);

  const modelFilter = window.model === undefined ? "" : "AND model = ?";
  const samples = database.prepare(
    `SELECT
       CAST(strftime('%s', timestamp) AS INTEGER) * 1000 AS ts,
       model, endpoint, status, outcome, duration_ms,
       CASE WHEN stream = 1 AND ttfb_ms > 0 THEN ttfb_ms END AS first_token_ms,
       CASE WHEN usage_known THEN prompt_tokens END AS input,
       CASE WHEN usage_known THEN completion_tokens END AS output,
       CASE WHEN usage_known THEN cached_prompt_tokens END AS input_cache_read,
       CASE WHEN usage_known THEN cache_write_prompt_tokens END AS input_cache_write,
       CASE WHEN usage_known THEN reasoning_tokens END AS reasoning
     FROM usage_logs
     WHERE timestamp >= ? AND timestamp < ? ${modelFilter}
     ORDER BY timestamp DESC, id DESC
     LIMIT ?`
  ).all(
    ...range,
    ...(window.model === undefined ? [] : [window.model]),
    rowLimit + 1
  ) as unknown as Array<MetricSample>;

  return {
    samples,
    availableModels: models.slice(0, modelLimit),
    modelListTruncated: models.length > modelLimit,
  };
}
