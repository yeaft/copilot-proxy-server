import { Worker } from "node:worker_threads";

import { droppedUsageRecords, getDatabasePath } from "./db.js";
import type { MetricsReport, MetricsWindow } from "./metrics-report.js";

export interface MetricsReportRequest {
  path: string;
  window: MetricsWindow;
  droppedSinceStart: number;
}

export type MetricsReportResponse = { report: MetricsReport } | { error: string };

/** One report at a time, like llm-proxy: a second request gets 503 instead of queueing. */
export class AnalyticsBusyError extends Error {
  constructor() {
    super("Analytics is busy. Try again shortly.");
  }
}

// Next to this module in source (run through tsx), next to the bundle in dist (tsup entry).
const WORKER_URL = new URL(
  import.meta.url.endsWith(".ts") ? "./metrics-worker.ts" : "./metrics-worker.js",
  import.meta.url
);

/** A stuck worker is replaced instead of holding the single report slot forever. */
const REPORT_TIMEOUT_MS = 30_000;

let worker: Worker | null = null;
let pending: {
  resolve: (report: MetricsReport) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
} | null = null;

function settle(outcome: { report: MetricsReport } | { error: Error }): void {
  const current = pending;
  pending = null;
  if (current) clearTimeout(current.timer);
  // An idle analytics thread must not keep the process alive or delay shutdown.
  worker?.unref();
  if (!current) return;
  if ("report" in outcome) current.resolve(outcome.report);
  else current.reject(outcome.error);
}

function startWorker(): Worker {
  const created = new Worker(WORKER_URL);
  created.on("message", (message: MetricsReportResponse) => {
    settle("report" in message ? message : { error: new Error(message.error) });
  });
  created.on("error", (error) => settle({ error }));
  created.on("exit", (code) => {
    if (worker === created) worker = null;
    settle({ error: new Error(`Analytics worker exited (code ${code}).`) });
  });
  return created;
}

/** Build the dashboard report on the analytics worker thread. */
export function queryMetricsReport(window: MetricsWindow): Promise<MetricsReport> {
  if (pending) return Promise.reject(new AnalyticsBusyError());
  const request: MetricsReportRequest = {
    path: getDatabasePath(),
    window,
    droppedSinceStart: droppedUsageRecords(),
  };
  const current = (worker ??= startWorker());
  return new Promise((resolve, reject) => {
    // Terminating emits "exit", which rejects this request and clears the slot.
    const timer = setTimeout(() => void current.terminate(), REPORT_TIMEOUT_MS);
    timer.unref();
    pending = { resolve, reject, timer };
    // Keep the process alive until the pending report is delivered.
    current.ref();
    current.postMessage(request);
  });
}
