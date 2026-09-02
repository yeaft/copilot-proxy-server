import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";

import {
  getStatsOverview,
  getTimeSeries,
  getTopIps,
  getTopModels,
  periodToTimeRange,
  type TimeRange,
} from "../../lib/db.js";
import { getDashboardHtml } from "./page.js";

const dashboardUser = process.env.DASHBOARD_USER || "admin";
const dashboardPass = process.env.DASHBOARD_PASS || "admin";

export const dashboardRoutes = new Hono();

// Basic Auth for all dashboard routes
dashboardRoutes.use(
  "*",
  basicAuth({ username: dashboardUser, password: dashboardPass })
);

/** Parse time range from query params. Supports both preset period and custom start/end. */
function parseTimeRange(c: { req: { query: (k: string) => string | undefined } }): TimeRange {
  const start = c.req.query("start");
  const end = c.req.query("end");
  const granularity = c.req.query("granularity");
  const timezoneOffset = Number(c.req.query("tzOffset"));
  const timezoneOffsetMinutes = Number.isFinite(timezoneOffset)
    ? Math.max(-840, Math.min(840, Math.trunc(timezoneOffset)))
    : undefined;

  if (start && end) {
    return {
      start,
      end,
      granularity: granularity || undefined,
      timezoneOffsetMinutes,
    };
  }

  // Fallback to preset period
  const period = c.req.query("period") || "24h";
  const range = periodToTimeRange(period);
  if (granularity) range.granularity = granularity;
  range.timezoneOffsetMinutes = timezoneOffsetMinutes;
  return range;
}

// Dashboard page
dashboardRoutes.get("/", (c) => {
  return c.html(getDashboardHtml());
});

// API: overview stats
dashboardRoutes.get("/api/stats", (c) => {
  const range = parseTimeRange(c);
  return c.json(getStatsOverview(range));
});

// API: time series data
dashboardRoutes.get("/api/usage", (c) => {
  const range = parseTimeRange(c);
  return c.json(getTimeSeries(range));
});

// API: top IPs by token usage
dashboardRoutes.get("/api/top-ips", (c) => {
  const range = parseTimeRange(c);
  return c.json(getTopIps(range));
});

// API: top models by token usage
dashboardRoutes.get("/api/top-models", (c) => {
  const range = parseTimeRange(c);
  return c.json(getTopModels(range));
});
