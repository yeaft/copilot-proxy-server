import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";

import {
  getStatsOverview,
  getTimeSeries,
  getTopIps,
  getTopModels,
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

// Dashboard page
dashboardRoutes.get("/", (c) => {
  return c.html(getDashboardHtml());
});

// API: overview stats
dashboardRoutes.get("/api/stats", (c) => {
  const period = (c.req.query("period") as string) || "24h";
  return c.json(getStatsOverview(period));
});

// API: time series data
dashboardRoutes.get("/api/usage", (c) => {
  const period = (c.req.query("period") as string) || "24h";
  return c.json(getTimeSeries(period));
});

// API: top IPs by token usage
dashboardRoutes.get("/api/top-ips", (c) => {
  const period = (c.req.query("period") as string) || "24h";
  return c.json(getTopIps(period));
});

// API: top models by token usage
dashboardRoutes.get("/api/top-models", (c) => {
  const period = (c.req.query("period") as string) || "24h";
  return c.json(getTopModels(period));
});
