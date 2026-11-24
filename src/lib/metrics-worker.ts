import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";

import { readMetricSamples } from "./db.js";
import { buildMetricsReport, MODEL_LIMIT, ROW_LIMIT } from "./metrics-report.js";
import type { MetricsReportRequest, MetricsReportResponse } from "./metrics-query.js";

/**
 * Builds dashboard reports off the main thread: reading and aggregating up to
 * ROW_LIMIT rows takes long enough to stall every proxied stream otherwise.
 * Each report uses its own read-only connection, which WAL lets run alongside writes.
 */
parentPort!.on("message", ({ path, window, droppedSinceStart }: MetricsReportRequest) => {
  let response: MetricsReportResponse;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 5000");
    const samples = readMetricSamples(window, ROW_LIMIT, MODEL_LIMIT, database);
    response = { report: buildMetricsReport(window, { ...samples, droppedSinceStart }) };
  } catch (error) {
    response = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    database?.close();
  }
  parentPort!.postMessage(response);
});
