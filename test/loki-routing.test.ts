import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";

import { app } from "../src/server.js";
import { LokiSignInRequired, LokiAuthError } from "../src/auth/loki-auth.js";
import { state } from "../src/lib/state.js";
import { LokiProvider } from "../src/services/loki.js";

let upstream: Server;
let proxy: ReturnType<typeof serve>;
let base: string;
let requests: Array<{ path: string; payload: Record<string, unknown>; headers: Record<string, unknown> }> = [];
let catalogStatus = 200;
const oldState = { ...state };
const nativeModel = "gpt-6.1-sol";

before(async () => {
  upstream = createServer(async (req, res) => {
    if (req.url === "/models") {
      res.writeHead(catalogStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: nativeModel, name: "Sol", supported_endpoints: ["/responses"], custom_metadata: "preserved" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: req.url!, payload, headers: req.headers });
    res.writeHead(200, { "content-type": payload.stream ? "text/event-stream" : "application/json" });
    res.end(payload.stream ? 'event: response.completed\ndata: {"response":{"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n'
      : JSON.stringify({ ok: true, input_tokens: 7, usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  state.apiKey = "client-only-key";
  state.copilotEnabled = false;
  state.loki = new LokiProvider({ tokens: { getToken: async () => "ms-upstream-only" }, environment: "prod",
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/` });
  await new Promise<void>((resolve) => {
    proxy = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve());
  });
  base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

after(async () => {
  Object.assign(state, oldState);
  delete state.loki;
  for (const server of [proxy, upstream]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function post(path: string, payload: Record<string, unknown>, key = "client-only-key") {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json",
    authorization: `Bearer ${key}`, "anthropic-beta": "test-beta" }, body: JSON.stringify(payload) });
}

test("client authentication runs before Loki discovery or forwarding", async () => {
  const count = requests.length;
  assert.equal((await post("/v1/responses", { model: `loki/${nativeModel}` }, "wrong")).status, 403);
  assert.equal(requests.length, count);
});

for (const [path, upstreamPath] of [
  ["/v1/chat/completions", "/chat/completions"], ["/chat/completions", "/chat/completions"],
  ["/v1/responses", "/responses"], ["/responses", "/responses"],
  ["/v1/messages", "/v1/messages"], ["/v1/messages/count_tokens", "/v1/messages/count_tokens"],
]) {
  test(`${path} routes directly to native Loki without protocol translation`, async () => {
    const payload = { model: `loki/${nativeModel}`, messages: [{ role: "user", content: "hi" }],
      previous_response_id: "continuation", thinking: { type: "adaptive" }, custom_field: { untouched: true } };
    const response = await post(`${path}?test=1`, payload);
    assert.equal(response.status, 200, await response.text());
    const received = requests.at(-1)!;
    assert.equal(received.path, `${upstreamPath}?test=1`);
    assert.deepEqual(received.payload, { ...payload, model: nativeModel });
    assert.equal(received.headers.authorization, "Bearer ms-upstream-only");
    assert.equal(received.headers["anthropic-beta"], "test-beta");
  });
}

test("native SSE is returned unchanged through the full server", async () => {
  const response = await post("/v1/responses", { model: `loki/${nativeModel}`, stream: true });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'event: response.completed\ndata: {"response":{"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n');
});

test("Loki catalog is namespaced and metadata is retained without GitHub auth", async () => {
  for (const path of ["/v1/models", "/playground/api/models"]) {
    const response = await fetch(`${base}${path}`, { headers: { authorization: "Bearer client-only-key" } });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: Record<string, unknown>[] };
    assert.equal(body.data[0].id, `loki/${nativeModel}`);
    assert.equal(body.data[0].provider, "loki");
    assert.equal(body.data[0].custom_metadata, "preserved");
    assert.deepEqual(body.data[0].supported_endpoints, ["/responses"]);
  }
});

for (const method of ["generateContent", "streamGenerateContent", "countTokens"]) {
  test(`Gemini ${method} refuses Loki models before Copilot dispatch`, async () => {
    const count = requests.length;
    const response = await post(`/v1beta/models/loki/${nativeModel}:${method}`, { contents: [] });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Loki models do not support/);
    assert.equal(requests.length, count);
  });
}

test("Loki-only mode rejects bare Copilot models", async () => {
  assert.equal((await post("/v1/responses", { model: nativeModel, input: "hi" })).status, 503);
});

test("disabled Loki is explicit rather than falling through to Copilot", async () => {
  const provider = state.loki;
  state.loki = undefined;
  try {
    const response = await post("/v1/responses", { model: `loki/${nativeModel}` });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /Loki provider is disabled/);
  } finally { state.loki = provider; }
});

test("mixed catalogs retain Copilot models when Loki is unavailable", async () => {
  const provider = state.loki;
  const models = state.models;
  const enabled = state.copilotEnabled;
  state.copilotEnabled = true;
  state.models = { object: "list", data: [{ id: "copilot-test", name: "Copilot", vendor: "test" }] } as typeof state.models;
  state.loki = new LokiProvider({ tokens: { getToken: async () => "test" }, environment: "prod",
    baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/` });
  catalogStatus = 503;
  try {
    const response = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer client-only-key" } });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { id: string }[] };
    assert.deepEqual(body.data.map((model) => model.id), ["copilot-test"]);
  } finally {
    catalogStatus = 200;
    state.loki = provider;
    state.models = models;
    state.copilotEnabled = enabled;
  }
});

test("invalid requests are rejected and health remains public", async () => {
  assert.equal((await post("/v1/responses", { model: "loki/" })).status, 400);
  const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: { authorization: "Bearer client-only-key",
    "content-type": "application/json" }, body: "not-json" });
  assert.equal(response.status, 400);
  assert.equal((await fetch(base)).status, 200);
});

test("missing Microsoft credentials return an actionable error without upstream requests", async () => {
  const original = state.loki;
  const count = requests.length;
  state.loki = new LokiProvider({ tokens: { getToken: async () => { throw new LokiSignInRequired("Not signed in. Run npm run auth:loki."); } }, environment: "prod" });
  try {
    const response = await post("/v1/responses", { model: `loki/${nativeModel}` });
    assert.equal(response.status, 401);
    assert.match(await response.text(), /npm run auth:loki/);
    assert.equal(requests.length, count);
  } finally { state.loki = original; }
});

test("transient Microsoft refresh errors report 503, not invalid client authentication", async () => {
  const original = state.loki;
  state.loki = new LokiProvider({ tokens: { getToken: async () => { throw new LokiAuthError("Could not refresh the sign-in. Check the network connection."); } }, environment: "prod" });
  try {
    const response = await post("/v1/responses", { model: `loki/${nativeModel}` });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /Check the network/);
  } finally { state.loki = original; }
});

test("Loki keeps the proxy rate limit response", async () => {
  const seconds = state.rateLimitSeconds;
  const last = state.lastRequestTimestamp;
  state.rateLimitSeconds = 60;
  state.lastRequestTimestamp = Date.now();
  try {
    assert.equal((await post("/v1/responses", { model: `loki/${nativeModel}` })).status, 429);
  } finally { state.rateLimitSeconds = seconds; state.lastRequestTimestamp = last; }
});
