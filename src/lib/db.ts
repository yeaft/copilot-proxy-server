import initSqlJs, { type Database as SqlJsDatabase } from "sql.js/dist/sql-asm.js";
import fs from "node:fs";
import path from "node:path";

import { logger } from "./logger.js";

export interface UsageRecord {
  ip: string;
  model: string;
  endpoint: string; // 'openai' | 'anthropic' | 'gemini'
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
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
      stream INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      ttfb_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_ip ON usage_logs(ip);
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_logs(model);
  `);

  // Migration: add ttfb_ms column if missing
  try {
    db.run(`ALTER TABLE usage_logs ADD COLUMN ttfb_ms INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — ignore
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
        `INSERT INTO usage_logs (ip, model, endpoint, prompt_tokens, completion_tokens, total_tokens, stream, duration_ms, ttfb_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.ip,
          record.model,
          record.endpoint,
          record.prompt_tokens,
          record.completion_tokens,
          record.total_tokens,
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

// Helper to compute the datetime cutoff string for a period
function periodToDatetime(period: string): string {
  const hours: Record<string, number> = {
    "1h": 1,
    "6h": 6,
    "24h": 24,
    "7d": 168,
    "30d": 720,
  };
  const h = hours[period] ?? 24;
  return `-${h} hours`;
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
  total_tokens: number;
  active_ips: number;
  avg_ttfb_ms: number;
  avg_duration_ms: number;
  p50_ttfb_ms: number;
  p95_ttfb_ms: number;
  p50_duration_ms: number;
  p95_duration_ms: number;
}

export function getStatsOverview(period: string): StatsOverview {
  const offset = periodToDatetime(period);
  const base = queryOne<{
    total_requests: number;
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_tokens: number;
    active_ips: number;
    avg_ttfb_ms: number;
    avg_duration_ms: number;
  }>(
    `SELECT
      COUNT(*) as total_requests,
      COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COUNT(DISTINCT ip) as active_ips,
      COALESCE(AVG(CASE WHEN ttfb_ms > 0 THEN ttfb_ms END), 0) as avg_ttfb_ms,
      COALESCE(AVG(duration_ms), 0) as avg_duration_ms
    FROM usage_logs
    WHERE timestamp >= datetime('now', ?)`,
    [offset]
  );

  // Compute percentiles via sorted subqueries
  const ttfbPercentiles = queryOne<{ p50: number; p95: number }>(
    `SELECT
      COALESCE((SELECT ttfb_ms FROM usage_logs WHERE timestamp >= datetime('now', ?) AND ttfb_ms > 0 ORDER BY ttfb_ms LIMIT 1 OFFSET (SELECT MAX(0, CAST(COUNT(*) * 0.5 AS INTEGER) - 1) FROM usage_logs WHERE timestamp >= datetime('now', ?) AND ttfb_ms > 0)), 0) as p50,
      COALESCE((SELECT ttfb_ms FROM usage_logs WHERE timestamp >= datetime('now', ?) AND ttfb_ms > 0 ORDER BY ttfb_ms LIMIT 1 OFFSET (SELECT MAX(0, CAST(COUNT(*) * 0.95 AS INTEGER) - 1) FROM usage_logs WHERE timestamp >= datetime('now', ?) AND ttfb_ms > 0)), 0) as p95`,
    [offset, offset, offset, offset]
  );

  const durationPercentiles = queryOne<{ p50: number; p95: number }>(
    `SELECT
      COALESCE((SELECT duration_ms FROM usage_logs WHERE timestamp >= datetime('now', ?) ORDER BY duration_ms LIMIT 1 OFFSET (SELECT MAX(0, CAST(COUNT(*) * 0.5 AS INTEGER) - 1) FROM usage_logs WHERE timestamp >= datetime('now', ?))), 0) as p50,
      COALESCE((SELECT duration_ms FROM usage_logs WHERE timestamp >= datetime('now', ?) ORDER BY duration_ms LIMIT 1 OFFSET (SELECT MAX(0, CAST(COUNT(*) * 0.95 AS INTEGER) - 1) FROM usage_logs WHERE timestamp >= datetime('now', ?))), 0) as p95`,
    [offset, offset, offset, offset]
  );

  return {
    ...base,
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
  total_tokens: number;
  avg_ttfb_ms: number;
  avg_duration_ms: number;
}

export function getTimeSeries(period: string): TimeSeriesPoint[] {
  const offset = periodToDatetime(period);

  let strftime: string;
  if (period === "1h" || period === "6h") {
    strftime = "%Y-%m-%d %H:%M";
  } else if (period === "24h") {
    strftime = "%Y-%m-%d %H:00";
  } else {
    strftime = "%Y-%m-%d";
  }

  return queryAll<TimeSeriesPoint>(
    `SELECT
      strftime('${strftime}', timestamp) as time_bucket,
      COUNT(*) as requests,
      COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) as completion_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(AVG(CASE WHEN ttfb_ms > 0 THEN ttfb_ms END), 0) as avg_ttfb_ms,
      COALESCE(AVG(duration_ms), 0) as avg_duration_ms
    FROM usage_logs
    WHERE timestamp >= datetime('now', ?)
    GROUP BY time_bucket
    ORDER BY time_bucket`,
    [offset]
  );
}

export interface TopEntry {
  name: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  avg_ttfb_ms: number;
  avg_duration_ms: number;
}

export function getTopIps(period: string, limit = 20): TopEntry[] {
  const offset = periodToDatetime(period);
  return queryAll<TopEntry>(
    `SELECT
      ip as name,
      COUNT(*) as requests,
      COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) as completion_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(AVG(CASE WHEN ttfb_ms > 0 THEN ttfb_ms END), 0) as avg_ttfb_ms,
      COALESCE(AVG(duration_ms), 0) as avg_duration_ms
    FROM usage_logs
    WHERE timestamp >= datetime('now', ?)
    GROUP BY ip
    ORDER BY total_tokens DESC
    LIMIT ?`,
    [offset, limit]
  );
}

export function getTopModels(period: string, limit = 20): TopEntry[] {
  const offset = periodToDatetime(period);
  return queryAll<TopEntry>(
    `SELECT
      model as name,
      COUNT(*) as requests,
      COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) as completion_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(AVG(CASE WHEN ttfb_ms > 0 THEN ttfb_ms END), 0) as avg_ttfb_ms,
      COALESCE(AVG(duration_ms), 0) as avg_duration_ms
    FROM usage_logs
    WHERE timestamp >= datetime('now', ?)
    GROUP BY model
    ORDER BY total_tokens DESC
    LIMIT ?`,
    [offset, limit]
  );
}
