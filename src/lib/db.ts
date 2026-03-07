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
      duration_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_ip ON usage_logs(ip);
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_logs(model);
  `);

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
        `INSERT INTO usage_logs (ip, model, endpoint, prompt_tokens, completion_tokens, total_tokens, stream, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.ip,
          record.model,
          record.endpoint,
          record.prompt_tokens,
          record.completion_tokens,
          record.total_tokens,
          record.stream ? 1 : 0,
          record.duration_ms,
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
}

export function getStatsOverview(period: string): StatsOverview {
  const offset = periodToDatetime(period);
  return queryOne<StatsOverview>(
    `SELECT
      COUNT(*) as total_requests,
      COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COUNT(DISTINCT ip) as active_ips
    FROM usage_logs
    WHERE timestamp >= datetime('now', ?)`,
    [offset]
  );
}

export interface TimeSeriesPoint {
  time_bucket: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
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
      COALESCE(SUM(total_tokens), 0) as total_tokens
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
}

export function getTopIps(period: string, limit = 20): TopEntry[] {
  const offset = periodToDatetime(period);
  return queryAll<TopEntry>(
    `SELECT
      ip as name,
      COUNT(*) as requests,
      COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) as completion_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens
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
      COALESCE(SUM(total_tokens), 0) as total_tokens
    FROM usage_logs
    WHERE timestamp >= datetime('now', ?)
    GROUP BY model
    ORDER BY total_tokens DESC
    LIMIT ?`,
    [offset, limit]
  );
}
