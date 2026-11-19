import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { state } from "../src/lib/state.js";
import { app } from "../src/server.js";
import type { Model } from "../src/types/copilot.js";
import type { ChatCompletionsPayload } from "../src/types/openai.js";
import type { ResponsesPayload } from "../src/types/responses.js";

const proxyKey = "test-proxy-key";

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

beforeEach(() => {
  state.apiKey = proxyKey;
  state.copilotToken = "test-copilot-token";
  state.models = {
    object: "list",
    data: [model("gemini-4-carbon", ["/chat/completions"]), model("gpt-6-luna", ["/responses", "ws:/responses"])],
  };
});

afterEach(() => {
  delete state.apiKey;
  delete state.copilotToken;
  delete state.models;
});

function chat(body: Partial<ChatCompletionsPayload>) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${proxyKey}` },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], ...body }),
  });
}

function sseBody(lines: Array<string>, failAfter = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      if (failAfter) controller.error(new Error("socket hang up"));
      else controller.close();
    },
  });
}

function dataLines(text: string): Array<string> {
  return text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6));
}

test("native chat/completions streams forward upstream [DONE]", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string) => {
    assert.equal(input, "https://api.githubcopilot.com/chat/completions");
    const chunk = { id: "c1", object: "chat.completion.chunk", created: 1, model: "gemini-4-carbon", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] };
    return new Response(sseBody([`data: ${JSON.stringify(chunk)}\n\n`, "data: [DONE]\n\n"]), {
      headers: { "content-type": "text/event-stream" },
    });
  });

  const response = await chat({ model: "gemini-4-carbon", stream: true });
  assert.equal(response.status, 200);
  const lines = dataLines(await response.text());
  assert.equal(lines.length, 2);
  assert.equal(lines.at(-1), "[DONE]");
});

test("native chat/completions stream failure surfaces an error chunk", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    const chunk = { id: "c1", object: "chat.completion.chunk", created: 1, model: "gemini-4-carbon", choices: [{ index: 0, delta: { content: "par" }, finish_reason: null }] };
    return new Response(sseBody([`data: ${JSON.stringify(chunk)}\n\n`], true), {
      headers: { "content-type": "text/event-stream" },
    });
  });

  const lines = dataLines(await (await chat({ model: "gemini-4-carbon", stream: true })).text());
  assert.notEqual(lines.at(-1), "[DONE]");
  assert.match(JSON.parse(lines.at(-1)!).error.message, /socket hang up/);
});

test("responses-only models: tool history, images and Copilot headers reach /responses", async (t) => {
  let forwarded: ResponsesPayload | undefined;
  let headers: Headers | undefined;
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    assert.equal(input, "https://api.githubcopilot.com/responses");
    headers = new Headers(init?.headers);
    forwarded = JSON.parse(String(init?.body)) as ResponsesPayload;
    return Response.json({
      id: "resp_1", object: "response", created_at: 1, model: "gpt-6-luna", status: "completed",
      output: [{ type: "function_call", call_id: "call_2", name: "get_weather", arguments: "{\"city\":\"Rome\"}" }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
  });

  const response = await chat({
    model: "gpt-6-luna",
    tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Weather here?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "18C" },
    ],
  });

  assert.equal(response.status, 200);
  assert.equal(headers?.get("copilot-vision-request"), "true");
  assert.equal(headers?.get("x-initiator"), "agent");
  assert.equal(forwarded?.store, false);
  assert.deepEqual((forwarded?.input as Array<{ type: string }>).map((item) => item.type), ["message", "function_call", "function_call_output"]);

  const body = await response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(body.choices[0].message.tool_calls, [
    { id: "call_2", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Rome\"}" } },
  ]);
});

test("responses-only models stream complete chat chunks ending in [DONE]", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    const events = [
      { type: "response.created", response: { id: "resp_1", created_at: 1, status: "in_progress", output: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello" },
      { type: "response.completed", response: { id: "resp_1", created_at: 1, status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
    ];
    return new Response(sseBody(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)), {
      headers: { "content-type": "text/event-stream" },
    });
  });

  const lines = dataLines(await (await chat({ model: "gpt-6-luna", stream: true })).text());
  assert.equal(lines.at(-1), "[DONE]");
  const chunks = lines.slice(0, -1).map((line) => JSON.parse(line));
  assert.equal(chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join(""), "Hello");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  assert.equal(chunks.at(-1).usage.total_tokens, 4);
});

test("responses-only models reject unsupported parameters with an OpenAI 400", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  const response = await chat({ model: "gpt-6-luna", n: 3 });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.type, "invalid_request_error");
  assert.equal(body.error.param, "n");
  assert.equal(body.error.code, "unsupported_parameter");
  assert.equal(upstream.mock.callCount(), 0);
});
