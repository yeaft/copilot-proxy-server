import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { closeDatabase, getDb, initDatabase } from "../src/lib/db.js";
import { UpstreamHeadersTimeoutError } from "../src/lib/error.js";
import { state } from "../src/lib/state.js";
import { app } from "../src/server.js";
import type { Model } from "../src/types/copilot.js";

const proxyKey = "test-proxy-key";
let dataDir = "";

function model(id: string, endpoints: Array<string>): Model {
  return {
    id,
    name: id,
    object: "model",
    vendor: "test",
    version: id,
    preview: false,
    model_picker_enabled: true,
    supported_endpoints: endpoints,
    capabilities: {
      family: id,
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      limits: { max_output_tokens: 1000 },
      supports: { tool_calls: true, reasoning_effort: ["low", "medium", "high"] },
    },
  };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "copilot-proxy-metrics-test-"));
  await initDatabase(dataDir);
});

after(async () => {
  closeDatabase();
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().exec("DELETE FROM usage_logs");
  state.apiKey = proxyKey;
  state.copilotToken = "test-copilot-token";
  state.models = {
    object: "list",
    data: [model("gemini-4-carbon", ["/chat/completions"]), model("gpt-6-luna", ["/responses"])],
  };
});

afterEach(() => {
  delete state.apiKey;
  delete state.copilotToken;
  delete state.models;
});

interface Row {
  model: string;
  endpoint: string;
  status: number;
  outcome: string;
  stream: number;
  ttfb_ms: number;
  usage_known: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  reasoning_tokens: number | null;
}

function rows(): Array<Row> {
  return (getDb().prepare(
    `SELECT model, endpoint, status, outcome, stream, ttfb_ms, usage_known,
       prompt_tokens, completion_tokens, cached_prompt_tokens, reasoning_tokens
     FROM usage_logs ORDER BY id`
  ).all() as Array<Row>).map((row) => ({ ...row }));
}

/** Usage rows are written on a later tick (and streams only once they end). */
async function waitForRows(count = 1): Promise<Array<Row>> {
  const deadline = Date.now() + 2_000;
  while (rows().length < count) {
    assert.ok(Date.now() < deadline, `expected ${count} usage row(s), found ${rows().length}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return rows();
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function post(path: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${proxyKey}` }) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const chat = (body: Record<string, unknown>) =>
  post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }], ...body });

const encoder = new TextEncoder();
function sse(events: Array<string>, failAfter = false) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        if (failAfter) controller.error(new Error("socket hang up"));
        else controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
}

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gemini-4-carbon", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
const finish = (usage?: Record<string, unknown>) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gemini-4-carbon", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`;
const responsesEvent = (event: Record<string, unknown> & { type: string }) =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

const chatUsage = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 60 },
  completion_tokens_details: { reasoning_tokens: 5 },
};

test("records a completed non-streamed request with its usage", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    id: "c1", object: "chat.completion", created: 1, model: "gemini-4-carbon",
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: chatUsage,
  }));
  assert.equal((await chat({ model: "gemini-4-carbon" })).status, 200);
  assert.deepEqual(await waitForRows(), [{
    model: "gemini-4-carbon", endpoint: "openai", status: 200, outcome: "ok", stream: 0, ttfb_ms: 0,
    usage_known: 1, prompt_tokens: 100, completion_tokens: 20, cached_prompt_tokens: 60, reasoning_tokens: 5,
  }]);
});

test("records upstream HTTP errors, header timeouts and rejected requests as failures", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => new Response("overloaded", { status: 503 }));
  assert.equal((await chat({ model: "gemini-4-carbon" })).status, 503);

  upstream.mock.mockImplementation(async () => {
    throw new UpstreamHeadersTimeoutError(120_000);
  });
  assert.equal((await chat({ model: "gemini-4-carbon" })).status, 504);

  // Invalid JSON never reaches the upstream; the response itself is unchanged (500).
  assert.equal((await post("/v1/chat/completions", "{")).status, 500);
  // Parameters /responses cannot honour are refused before calling it.
  assert.equal((await chat({ model: "gpt-6-luna", n: 3 })).status, 400);

  const recorded = (await waitForRows(4)).map((row) => [row.model, row.status, row.outcome, row.usage_known]);
  assert.deepEqual(recorded, [
    ["gemini-4-carbon", 503, "http_error", 0],
    ["gemini-4-carbon", 504, "timeout", 0],
    ["(unresolved)", 500, "rejected", 0],
    ["gpt-6-luna", 400, "rejected", 0],
  ]);
  assert.equal(upstream.mock.callCount(), 2);
});

test("streamed chat: complete, read failure, and missing terminal event", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () =>
    sse([chunk({ content: "Hi" }), finish(chatUsage), "data: [DONE]\n\n"])
  );
  await (await chat({ model: "gemini-4-carbon", stream: true })).text();
  upstream.mock.mockImplementation(async () => sse([chunk({ content: "par" })], true));
  await (await chat({ model: "gemini-4-carbon", stream: true })).text();
  upstream.mock.mockImplementation(async () => sse([chunk({ content: "cut" })]));
  await (await chat({ model: "gemini-4-carbon", stream: true })).text();

  const [ok, failed, cut] = await waitForRows(3);
  assert.deepEqual([ok.outcome, ok.status, ok.stream, ok.prompt_tokens, ok.reasoning_tokens], ["ok", 200, 1, 100, 5]);
  assert.ok(ok.ttfb_ms >= 1, "streamed responses record the first visible output");
  assert.deepEqual([failed.outcome, failed.status, failed.usage_known], ["upstream_error", 200, 0]);
  assert.deepEqual([cut.outcome, cut.status], ["incomplete", 200]);
});

test("responses-only models: an upstream failure inside the bridged stream is a stream error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => sse([
    responsesEvent({ type: "response.created", response: { id: "r1", created_at: 1, status: "in_progress", output: [] } }),
    responsesEvent({ type: "response.failed", response: { id: "r1", created_at: 1, status: "failed", output: [], error: { code: "server_error", message: "boom" } } }),
  ]));
  const text = await (await chat({ model: "gpt-6-luna", stream: true })).text();
  assert.match(text, /boom/);
  const [row] = await waitForRows();
  assert.deepEqual([row.model, row.endpoint, row.outcome, row.status], ["gpt-6-luna", "openai", "stream_error", 200]);
});

test("native /v1/responses streams record usage, reasoning and incomplete responses", async (t) => {
  const usage = { input_tokens: 50, output_tokens: 30, total_tokens: 80, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 12 } };
  const upstream = t.mock.method(globalThis, "fetch", async () => sse([
    responsesEvent({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hi" }),
    responsesEvent({ type: "response.completed", response: { id: "r1", created_at: 1, status: "completed", output: [], usage } }),
  ]));
  await (await post("/v1/responses", { model: "gpt-6-luna", input: "hi", stream: true })).text();
  upstream.mock.mockImplementation(async () => sse([
    responsesEvent({ type: "response.incomplete", response: { id: "r2", created_at: 1, status: "incomplete", output: [], usage } }),
  ]));
  await (await post("/v1/responses", { model: "gpt-6-luna", input: "hi", stream: true })).text();

  const [completed, incomplete] = await waitForRows(2);
  assert.deepEqual(
    [completed.endpoint, completed.outcome, completed.prompt_tokens, completed.cached_prompt_tokens, completed.reasoning_tokens],
    ["responses", "ok", 50, 40, 12]
  );
  assert.ok(completed.ttfb_ms >= 1);
  // Same as llm-proxy: response.incomplete means the response was cut short.
  assert.deepEqual([incomplete.outcome, incomplete.ttfb_ms], ["stream_error", 0]);
});

test("Anthropic and Gemini streams are recorded under their endpoints", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    sse([chunk({ content: "Hi" }), finish(chatUsage), "data: [DONE]\n\n"])
  );
  await (await post("/v1/messages", { model: "gemini-4-carbon", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] })).text();
  await (await post("/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse", { contents: [{ role: "user", parts: [{ text: "hi" }] }] })).text();

  const recorded = (await waitForRows(2)).map((row) => [row.endpoint, row.model, row.outcome, row.stream, row.prompt_tokens]);
  assert.deepEqual(recorded, [
    ["anthropic", "gemini-4-carbon", "ok", 1, 100],
    ["gemini", "gemini-4-carbon", "ok", 1, 100],
  ]);
});

test("a client that disconnects mid-stream is recorded as cancelled", async (t) => {
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  t.mock.method(globalThis, "fetch", async () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
        controller.enqueue(encoder.encode(chunk({ content: "Hel" })));
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  ));

  const response = await chat({ model: "gemini-4-carbon", stream: true });
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  // The relay keeps draining the upstream (existing behaviour); the row is written when it ends.
  upstream.enqueue(encoder.encode(finish(chatUsage)));
  upstream.close();

  const [row] = await waitForRows();
  assert.deepEqual([row.outcome, row.status, row.prompt_tokens], ["cancelled", 499, 100]);
});

test("unauthenticated requests and token counting are not recorded", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  assert.equal((await post("/v1/chat/completions", { model: "x", messages: [] }, {})).status, 401);
  assert.equal((await post("/v1/messages/count_tokens", { model: "claude-x", messages: [{ role: "user", content: "hi" }] })).status, 200);
  await settle();
  assert.deepEqual(rows(), []);
  assert.equal(upstream.mock.callCount(), 0);
});
