import initSqlJs, { type Database as SqlJsDatabase } from "sql.js/dist/sql-asm.js";
import fs from "node:fs";
import path from "node:path";

import { logger } from "./logger.js";
import { calculateUsageCost } from "./pricing.js";

export interface UsageRecord {
  ip: string;
  model: string;
  endpoint: string; // 'openai' | 'anthropic' | 'gemini'
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_prompt_tokens?: number;
  stream: boolean;
  duration_ms: number;
  ttfb_ms: number; // Time to first byte/token (0 for non-streaming)
}

let db: SqlJsDatabase | null = null;
let dbPath: string = "";
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function saveDb(): void {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  } catch (err) {
    logger.error("Failed to save database:", err);
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveDb();
  }, 1000);
}

export async function initDatabase(dataDir: string): Promise<void> {
  const SQL = await initSqlJs();

  dbPath = path.join(dataDir, "usage.db");

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
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
      stream INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      ttfb_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_ip ON usage_logs(ip);
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_logs(model);
  `);

  // Additive migrations keep existing usage databases compatible.
  for (const column of [
    "ttfb_ms INTEGER NOT NULL DEFAULT 0",
    "cached_prompt_tokens INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      db.run(`ALTER TABLE usage_logs ADD COLUMN ${column}`);
    } catch {
      // Column already exists.
    }
  }

  saveDb();

  // Flush database to disk on process exit
  process.on("SIGTERM", () => saveDb());
  process.on("SIGINT", () => saveDb());

  logger.info(`Usage database initialized at ${dbPath}`);
}

/**
 * Asynchronously log usage record — never blocks the API response.
 */
export function logUsage(record: UsageRecord): void {
  if (!db) return;
  setImmediate(() => {
    try {
      db!.run(
        `INSERT INTO usage_logs (
          ip, model, endpoint, prompt_tokens, completion_tokens, total_tokens,
          cached_prompt_tokens, stream, duration_ms, ttfb_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.ip,
          record.model,
          record.endpoint,
          record.prompt_tokens,
          record.completion_tokens,
          record.total_tokens,
          record.cached_prompt_tokens ?? 0,
          record.stream ? 1 : 0,
          record.duration_ms,
          record.ttfb_ms,
        ]
      );
      scheduleSave();
    } catch (err) {
      logger.error("Failed to log usage:", err);
    }
  });
}

export function getDb(): SqlJsDatabase {
  if (!db) throw new Error("Database not initialized");
  return db;
}

/** Query time range parameters */
export interface TimeRange {
  start: string; // ISO datetime e.g. '2026-04-01T00:00:00'
  end: string;   // ISO datetime e.g. '2026-04-03T00:00:00'
  granularity?: string; // '1m' | '5m' | '1h' | '1d' — auto-inferred if omitted
}

/** Convert a preset period string to a TimeRange (end = now) */
export function periodToTimeRange(period: string): TimeRange {
  const hours: Record<string, number> = {
    "1h": 1,
    "6h": 6,
    "24h": 24,
    "7d": 168,
    "30d": 720,
  };
  const h = hours[period] ?? 24;
  const now = new Date();
  const start = new Date(now.getTime() - h * 3600_000);
  return {
    start: start.toISOString().slice(0, 19),
    end: now.toISOString().slice(0, 19),
  };
}

/** Infer granularity from time range span */
function inferGranularity(start: string, end: string): string {
  const spanMs = new Date(end).getTime() - new Date(start).getTime();
  const spanHours = spanMs / 3600_000;
  if (spanHours <= 3) return "1m";
  if (spanHours <= 24) return "5m";
  if (spanHours <= 168) return "1h"; // 7 days
  return "1d";
}

/** Get strftime format string from granularity */
function granularityToStrftime(granularity: string): string {
  switch (granularity) {
    case "1m":
      return "%Y-%m-%d %H:%M";
    case "5m":
      // SQLite doesn't have native 5-min bucketing, we'll handle in query
      return "%Y-%m-%d %H:%M";
    case "1h":
      return "%Y-%m-%d %H:00";
    case "1d":
      return "%Y-%m-%d";
    default:
      return "%Y-%m-%d %H:00";
  }
}

/** Resolve granularity (use provided or auto-infer) */
function resolveGranularity(range: TimeRange): string {
  return range.granularity || inferGranularity(range.start, range.end);
}

function queryAll<T>(sql: string, params: unknown[] = []): T[] {
  const d = getDb();
  const stmt = d.prepare(sql);
  stmt.bind(params);
  const results: T[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return results;
}

function queryOne<T>(sql: string, params: unknown[] = []): T {
  const d = getDb();
  const stmt = d.prepare(sql);
  stmt.bind(params);
  stmt.step();
  const row = stmt.getAsObject() as T;
  stmt.free();
  return row;
}

export interface StatsOverview {
  total_requests: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cached_prompt_tokens: number;
  total_tokens: number;
  total_credits: number;
  total_cost_usd: number;
  unpriced_tokens: number;
  active_ips: number;
  avg_ttfb_ms: number;
  avg_duration_ms: number;
  p50_ttfb_ms: number;
  p95_ttfb_ms: number;
  p50_duration_ms: number;
  p95_duration_ms: number;
}

export function getStatsOverview(range: TimeRange): StatsOverview {
  const { start, end } = range;
  const whereClause = `timestamp >= ? AND timestamp <= ?`;
  const whereParams = [start, end];

  const base = queryOne<{
    total_requests: number;
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_cached_prompt_tokens: number;
    total_tokens: number;
    active_ips: number;
    avg_ttfb_ms: number;
    avg_duration_ms: number;
  }>(
    `SELECT
      COUNT(*) as total_requests,
      COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
      COALESCE(SUM(cached_prompt_tokens), 0) as total_cached_prompt_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COUNT(DISTINCT ip) as active_ips,
      COALESCE(AVG(CASE WHEN ttfb_ms > 0 THEN ttfb_ms END), 0) as avg_ttfb_ms,
      COALESCE(AVG(duration_ms), 0) as avg_duration_ms
    FROM usage_logs
    WHERE ${whereClause}`,
    whereParams
  );

  // Compute percentiles via sorted subqueries
  const ttfbPercentiles = queryOne<{ p50: number; p95: number }>(
    `SELECT
      COALESCE((SELECT ttfb_ms FROM usage_logs WHERE ${whereClause} AND ttfb_ms > 0 ORDER BY ttfb_ms LIMIT 1 OFFSET (SELECT MAX(0, CAST(COUNT(*) * 0.5 AS INTEGER) - 1) FROM usage_logs WHERE ${whereClause} AND ttfb_ms > 0)), 0) as p50,
      COALESCE((SELECT ttfb_ms FROM usage_logs WHERE ${whereClause} AND ttfb_ms > 0 ORDER BY ttfb_ms LIMIT 1 OFFSET (SELECT MAX(0, CAST(COUNT(*) * 0.95 AS INTEGER) - 1) FROM usage_logs WHERE ${whereClause} AND ttfb_ms > 0)), 0) as p95`,
    [...whereParams, ...whereParams, ...whereParams, ...whereParams]
  );

  const durationPercentiles = queryOne<{ p50: number; p95: number }>(
    `SELECT
      COALESCE((SELECT duration_ms FROM usage_logs WHERE ${whereClause} ORDER BY duration_ms LIMIT 1 OFFSET (SELECT MAX(0, CAST(COUNT(*) * 0.5 AS INTEGER) - 1) FROM usage_logs WHERE ${whereClause})), 0) as p50,
      COALESCE((SELECT duration_ms FROM usage_logs WHERE ${whereClause} ORDER BY duration_ms LIMIT 1 OFFSET (SELECT MAX(0, CAST(COUNT(*) * 0.95 AS INTEGER) - 1) FROM usage_logs WHERE ${whereClause})), 0) as p95`,
    [...whereParams, ...whereParams, ...whereParams, ...whereParams]
  );

  const modelUsage = queryAll<{
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    cached_prompt_tokens: number;
    total_tokens: number;
  }>(
    `SELECT model,
      COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) as completion_tokens,
      COALESCE(SUM(cached_prompt_tokens), 0) as cached_prompt_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens
    FROM usage_logs WHERE ${whereClause} GROUP BY model`,
    whereParams
  );
  let totalCredits = 0;
  let unpricedTokens = 0;
  for (const usage of modelUsage) {
    const cost = calculateUsageCost(usage.model, usage);
    if (cost.priced) totalCredits += cost.credits;
    else unpricedTokens += usage.total_tokens;
  }

  return {
    ...base,
    total_credits: totalCredits,
    total_cost_usd: totalCredits * 0.01,
    unpriced_tokens: unpricedTokens,
    p50_ttfb_ms: ttfbPercentiles.p50,
    p95_ttfb_ms: ttfbPercentiles.p95,
    p50_duration_ms: durationPercentiles.p50,
    p95_duration_ms: durationPercentiles.p95,
  };
}

export interface TimeSeriesPoint {
  time_bucket: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  total_tokens: number;
  avg_ttfb_ms: number;
  avg_duration_ms: number;
}

export function getTimeSeries(range: TimeRange): TimeSeriesPoint[] {
  const { start, end } = range;
  const granularity = resolveGranularity(range);
  const strftime = granularityToStrftime(granularity);

  if (granularity === "5m") {
    // 5-minute bucketing: truncate minutes to nearest 5
    return queryAll<TimeSeriesPoint>(
      `SELECT
        strftime('%Y-%m-%d %H:', timestamp) || printf('%02d', (CAST(strftime('%M', timestamp) AS INTEGER) / 5) * 5) as time_bucket,
        COUNT(*) as requests,
        COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) as completion_tokens,
        COALESCE(SUM(cached_prompt_tokens), 0) as cached_prompt_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(AVG(CASE WHEN ttfb_ms > 0 THEN ttfb_ms END), 0) as avg_ttfb_ms,
        COALESCE(AVG(duration_ms), 0) as avg_duration_ms
      FROM usage_logs
      WHERE timestamp >= ? AND timestamp <= ?
      GROUP BY time_bucket
      ORDER BY time_bucket`,
      [start, end]
    );
  }

  return queryAll<TimeSeriesPoint>(
    `SELECT
      strftime('${strftime}', timestamp) as time_bucket,
      COUNT(*) as requests,
      COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) as completion_tokens,
      COALESCE(SUM(cached_prompt_tokens), 0) as cached_prompt_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(AVG(CASE WHEN ttfb_ms > 0 THEN ttfb_ms END), 0) as avg_ttfb_ms,
      COALESCE(AVG(duration_ms), 0) as avg_duration_ms
    FROM usage_logs
    WHERE timestamp >= ? AND timestamp <= ?
    GROUP BY time_bucket
    ORDER BY time_bucket`,
    [start, end]
  );
}

export interface TopEntry {
  name: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  total_tokens: number;
  credits?: number | null;
  cost_usd?: number | null;
  avg_ttfb_ms: number;
  avg_duration_ms: number;
}

export function getTopIps(range: TimeRange, limit = 20): TopEntry[] {
  const { start, end } = range;
  return queryAll<TopEntry>(
    `SELECT
      ip as name,
      COUNT(*) as requests,
      COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) as completion_tokens,
      COALESCE(SUM(cached_prompt_tokens), 0) as cached_prompt_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(AVG(CASE WHEN ttfb_ms > 0 THEN ttfb_ms END), 0) as avg_ttfb_ms,
      COALESCE(AVG(duration_ms), 0) as avg_duration_ms
    FROM usage_logs
    WHERE timestamp >= ? AND timestamp <= ?
    GROUP BY ip
    ORDER BY total_tokens DESC
    LIMIT ?`,
    [start, end, limit]
  );
}

export function getTopModels(range: TimeRange, limit = 20): TopEntry[] {
  const { start, end } = range;
  const rows = queryAll<TopEntry>(
    `SELECT
      model as name,
      COUNT(*) as requests,
      COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) as completion_tokens,
      COALESCE(SUM(cached_prompt_tokens), 0) as cached_prompt_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(AVG(CASE WHEN ttfb_ms > 0 THEN ttfb_ms END), 0) as avg_ttfb_ms,
      COALESCE(AVG(duration_ms), 0) as avg_duration_ms
    FROM usage_logs
    WHERE timestamp >= ? AND timestamp <= ?
    GROUP BY model
    ORDER BY total_tokens DESC
    LIMIT ?`,
    [start, end, limit]
  );
  return rows.map((row) => {
    const cost = calculateUsageCost(row.name, row);
    return {
      ...row,
      credits: cost.priced ? cost.credits : null,
      cost_usd: cost.priced ? cost.usd : null,
    };
  });
}
