import { Hono, type Context } from "hono";

import { logger } from "../../lib/logger.js";
import { AnalyticsBusyError, queryMetricsReport } from "../../lib/metrics-query.js";
import {
  MetricsQueryError,
  resolveMetricsWindow,
  type MetricsWindow,
} from "../../lib/metrics-report.js";
import { dashboardAssets } from "./assets.js";
import { createDashboardAuth } from "./auth.js";

const dashboardUser = process.env.DASHBOARD_USER || "admin";
const dashboardPass = process.env.DASHBOARD_PASS || "admin";
const dashboardAuth = createDashboardAuth(dashboardUser, dashboardPass);

/** Same policy as llm-proxy: no inline script or style, no third-party origins, no framing. */
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
  "form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const NO_STORE = { "Cache-Control": "no-store" };

function asset(c: Context, contentType: string, content: string) {
  return c.body(content, 200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
}

export const dashboardRoutes = new Hono();

dashboardRoutes.use("*", async (c, next) => {
  await next();
  c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
});

// Public: the sign-in page and the stylesheet it shares with the dashboard (no data).
dashboardRoutes.get("/login", (c) => c.html(dashboardAuth.loginPage()));
dashboardRoutes.post("/login", dashboardAuth.login);
dashboardRoutes.get("/style.css", (c) => asset(c, "text/css; charset=utf-8", dashboardAssets.style));

dashboardRoutes.use("*", dashboardAuth.middleware);

dashboardRoutes.get("/", (c) => asset(c, "text/html; charset=utf-8", dashboardAssets.html));
dashboardRoutes.get("/app.js", (c) => asset(c, "text/javascript; charset=utf-8", dashboardAssets.script));

/** Analytics report: `from`/`to` in UTC ms (max 31 days), optional `model` and bucket `step` in ms. */
dashboardRoutes.get("/api/metrics", async (c) => {
  let window: MetricsWindow;
  try {
    window = resolveMetricsWindow(c.req.query(), Date.now());
  } catch (error) {
    if (error instanceof MetricsQueryError) return c.json({ error: error.message }, 400, NO_STORE);
    throw error;
  }
  try {
    return c.json(await queryMetricsReport(window), 200, NO_STORE);
  } catch (error) {
    if (error instanceof AnalyticsBusyError) return c.json({ error: error.message }, 503, NO_STORE);
    logger.error("Failed to build dashboard analytics:", error);
    return c.json({ error: "Unable to read analytics." }, 500, NO_STORE);
  }
});
