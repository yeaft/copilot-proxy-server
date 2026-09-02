import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { createDashboardAuth } from "../src/routes/dashboard/auth.js";

function createApp() {
  const auth = createDashboardAuth("admin", "secret");
  const app = new Hono();
  app.get("/dashboard/login", (c) => c.html(auth.loginPage()));
  app.post("/dashboard/login", auth.login);
  app.use("/dashboard/*", auth.middleware);
  app.get("/dashboard/", (c) => c.text("dashboard"));
  app.get("/dashboard/api/stats", (c) => c.json({ ok: true }));
  return app;
}

test("dashboard login sets a persistent HttpOnly cookie and reuses it", async () => {
  const app = createApp();
  const login = await app.request("http://localhost/dashboard/login", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-proto": "https",
    },
    body: "username=admin&password=secret",
  });

  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), "/dashboard/");
  const setCookie = login.headers.get("set-cookie");
  assert.ok(setCookie);
  assert.match(setCookie, /dashboard_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /Max-Age=2592000/i);

  const cookie = setCookie.split(";", 1)[0];
  const dashboard = await app.request("http://localhost/dashboard/", {
    headers: { cookie },
  });
  assert.equal(dashboard.status, 200);
  assert.equal(await dashboard.text(), "dashboard");
});

test("dashboard rejects invalid login and expires API access cleanly", async () => {
  const app = createApp();
  const invalid = await app.request("http://localhost/dashboard/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=admin&password=wrong",
  });
  assert.equal(invalid.status, 401);

  const page = await app.request("http://localhost/dashboard/");
  assert.equal(page.status, 303);
  assert.equal(page.headers.get("location"), "/dashboard/login");

  const api = await app.request("http://localhost/dashboard/api/stats");
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { error: "Dashboard session expired." });
});
