import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { after, before, test } from "node:test";

import { closeDatabase, initDatabase, logUsage } from "../src/lib/db.js";
import { dashboardAssets } from "../src/routes/dashboard/assets.js";

// Credentials are read when the dashboard module loads, so set them before importing the app.
process.env.DASHBOARD_USER = "tester";
process.env.DASHBOARD_PASS = "s3cret";
const { app } = await import("../src/server.js");

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
let dataDir = "";

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "copilot-proxy-dashboard-test-"));
  await initDatabase(dataDir);
});

after(async () => {
  closeDatabase();
  await rm(dataDir, { recursive: true, force: true });
});

const get = (path: string, cookie?: string) =>
  app.request(`http://localhost${path}`, { headers: cookie ? { cookie } : {} });

async function signIn(password = "s3cret") {
  return app.request("http://localhost/dashboard/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `username=tester&password=${encodeURIComponent(password)}`,
  });
}

async function session(): Promise<string> {
  const response = await signIn();
  assert.equal(response.status, 303);
  return response.headers.get("set-cookie")!.split(";", 1)[0];
}

test("only the sign-in page and its stylesheet are public", async () => {
  for (const path of ["/dashboard", "/dashboard/app.js"]) {
    const response = await get(path);
    assert.equal(response.status, 303, path);
    assert.equal(response.headers.get("location"), "/dashboard/login");
    assert.equal(response.headers.get("content-security-policy"), CSP);
  }
  const api = await get("/dashboard/api/metrics");
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { error: "Dashboard session expired." });

  const style = await get("/dashboard/style.css");
  assert.equal(style.status, 200);
  assert.match(style.headers.get("content-type")!, /^text\/css/);
  assert.match(await style.text(), /\.login-card/);

  const login = await get("/dashboard/login");
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("content-security-policy"), CSP);
  assert.equal(login.headers.get("x-content-type-options"), "nosniff");
  const html = await login.text();
  assert.match(html, /<link rel="stylesheet" href="\/dashboard\/style.css">/);
  // The strict CSP blocks inline styles and scripts, so the page must not rely on them.
  assert.doesNotMatch(html, /<style|\sstyle=|<script/);

  const wrong = await signIn("wrong");
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /Invalid username or password/);
  assert.equal(wrong.headers.get("set-cookie"), null);
});

test("signed-in users get the llm-proxy style dashboard and its assets", async () => {
  const cookie = await session();
  const page = await get("/dashboard", cookie);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type")!, /^text\/html/);
  assert.equal(page.headers.get("content-security-policy"), CSP);
  assert.equal(page.headers.get("cache-control"), "no-cache");
  const html = await page.text();
  assert.match(html, /<title>Copilot Proxy · Analytics<\/title>/);
  assert.match(html, /src="\/dashboard\/app.js"/);

  const script = await get("/dashboard/app.js", cookie);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type")!, /^text\/javascript/);
  assert.equal(await script.text(), dashboardAssets.script);
});

test("the metrics API validates its window and returns the llm-proxy report shape", async () => {
  const cookie = await session();
  logUsage({
    ip: "client", model: "gpt-6.1-sol", endpoint: "responses", status: 200, outcome: "ok", stream: true,
    duration_ms: 1_100, first_token_ms: 100, usage: { input: 1_000, output: 101, cacheRead: 600, cacheWrite: 0, reasoning: 0 },
  });
  logUsage({
    ip: "client", model: "gemini-4-carbon", endpoint: "openai", status: 503, outcome: "http_error", stream: false,
    duration_ms: 40, first_token_ms: null, usage: null,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const to = Date.now() + 1_000;
  const response = await get(`/dashboard/api/metrics?from=${to - 3_600_000}&to=${to}`, cookie);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const report = await response.json();
  assert.equal(report.summary.requests, 2);
  assert.equal(report.summary.errors, 1);
  assert.deepEqual(report.summary.output_tps, { count: 1, p50: 100, overall: 100 });
  assert.deepEqual(report.summary.input_cache_rate, { percent: 60, reported: 1 });
  assert.deepEqual(report.results, [{ name: "http_503", requests: 1 }, { name: "ok", requests: 1 }]);
  assert.deepEqual(report.available_models, ["gemini-4-carbon", "gpt-6.1-sol"]);
  assert.equal(report.trend.length, 48);
  assert.equal(report.model_trend.length, 2);
  assert.deepEqual([report.truncated, report.model_list_truncated, report.dropped_since_start], [false, false, 0]);

  const filtered = await (await get(`/dashboard/api/metrics?from=${to - 3_600_000}&to=${to}&model=gpt-6.1-sol&step=60000`, cookie)).json();
  assert.deepEqual([filtered.summary.requests, filtered.step, filtered.trend.length], [1, 60_000, 60]);

  for (const query of ["from=50&to=20", "from=0&to=60000&step=10", "from=abc&to=1"]) {
    const invalid = await get(`/dashboard/api/metrics?${query}`, cookie);
    assert.equal(invalid.status, 400, query);
    assert.equal(invalid.headers.get("cache-control"), "no-store");
    assert.match((await invalid.json()).error, /Use a/);
  }
});

test("reports run one at a time on the analytics worker; a concurrent request gets 503", async () => {
  const cookie = await session();
  const to = Date.now() + 1_000;
  const path = `/dashboard/api/metrics?from=${to - 3_600_000}&to=${to}`;
  const statuses = (await Promise.all([get(path, cookie), get(path, cookie)])).map((response) => response.status);
  assert.deepEqual(statuses.sort(), [200, 503]);
  // The slot is released once the report is delivered.
  const next = await get(path, cookie);
  assert.equal(next.status, 200);
  assert.equal(next.headers.get("cache-control"), "no-store");
});

test("the dashboard script only references elements that exist in the page", () => {
  // Syntax check without executing the browser code.
  assert.doesNotThrow(() => new Script(dashboardAssets.script, { filename: "app.js" }));
  const ids = new Set([...dashboardAssets.html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const referenced = [...dashboardAssets.script.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(referenced.length > 40);
  assert.deepEqual(referenced.filter((id) => !ids.has(id)), []);
  // Template references: `${name}-chart`, `-legend`, `-tooltip`, `-empty` for each time chart, and donut parts.
  for (const name of ["model", "traffic", "token"]) {
    for (const part of ["chart", "legend", "tooltip", "empty"]) assert.ok(ids.has(`${name}-${part}`), `${name}-${part}`);
  }
  for (const part of ["chart", "legend"]) assert.ok(ids.has(`outcomes-${part}`));
  assert.match(dashboardAssets.script, /fetch\(`\/dashboard\/api\/metrics\?/);
});
