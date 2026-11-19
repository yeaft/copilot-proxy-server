import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { state } from "../src/lib/state.js";
import { app } from "../src/server.js";
import type { ChatCompletionsPayload } from "../src/types/openai.js";

const versions = ["v1", "v1beta"] as const;
const model = "gemini-4-carbon";
const proxyKey = "test-proxy-key";
const copilotToken = "test-copilot-token";
const requestBody = {
  contents: [{ role: "user", parts: [{ text: "Reply OK." }] }],
  generationConfig: { maxOutputTokens: 128 },
};

beforeEach(() => {
  state.apiKey = proxyKey;
  state.copilotToken = copilotToken;
});

afterEach(() => {
  delete state.apiKey;
  delete state.copilotToken;
  delete state.models;
});

function geminiRequest(version: typeof versions[number], method: string, headers: HeadersInit = {}, modelId = model) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  return app.request(`/${version}/models/${modelId}:${method}`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(requestBody),
  });
}

for (const version of versions) {
  for (const stream of [false, true]) {
    const method = stream ? "streamGenerateContent" : "generateContent";
    test(`Gemini ${version} ${method} accepts the SDK key without forwarding it`, async (t) => {
      const upstream = t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
        assert.equal(input, "https://api.githubcopilot.com/chat/completions");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), `Bearer ${copilotToken}`);
        assert.equal(headers.has("x-api-key"), false);
        assert.equal(headers.has("x-goog-api-key"), false);
        const payload = JSON.parse(String(init?.body)) as ChatCompletionsPayload;
        assert.deepEqual(payload.messages, [{ role: "user", content: "Reply OK." }]);
        assert.equal(payload.model, model);
        assert.equal(payload.max_tokens, 128);
        assert.equal(payload.stream, stream);

        const usage = { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 };
        if (stream) {
          const events = [
            { choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
          ];
          return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return Response.json({ choices: [{ index: 0, message: { content: "OK" }, finish_reason: "stop" }], usage });
      });

      const response = await geminiRequest(version, stream ? `${method}?alt=sse` : method, { "x-goog-api-key": proxyKey });
      assert.equal(response.status, 200);
      if (stream) {
        assert.match(response.headers.get("content-type")!, /text\/event-stream/);
        const events = (await response.text()).split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)));
        assert.equal(events.length, 2);
        assert.equal(events[0].candidates[0].content.parts[0].text, "OK");
        assert.equal(events[1].candidates[0].finishReason, "STOP");
      } else {
        const body = await response.json();
        assert.equal(body.candidates[0].content.parts[0].text, "OK");
        assert.equal(body.modelVersion, model);
      }
      if (!stream) {
        const wrongKey = "wrong";
        for (const [headers, expected] of [
          [new Headers({ "x-api-key": proxyKey, "x-goog-api-key": wrongKey }), 200],
          [new Headers({ "x-api-key": wrongKey, "x-goog-api-key": proxyKey }), 403],
          [new Headers({ authorization: `Bearer ${proxyKey}`, "x-api-key": wrongKey, "x-goog-api-key": wrongKey }), 200],
          [new Headers({ authorization: `Bearer ${wrongKey}`, "x-api-key": proxyKey, "x-goog-api-key": proxyKey }), 403],
        ] as const) {
          const mixed = await geminiRequest(version, method, headers);
          assert.equal(mixed.status, expected);
        }
      }
      assert.equal(upstream.mock.callCount(), stream ? 1 : 3);
    });
  }

  test(`Gemini ${version} countTokens is local and accepts all existing auth methods`, async (t) => {
    const upstream = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("countTokens must not contact the upstream");
    });
    for (const headers of [
      new Headers({ "x-goog-api-key": proxyKey }),
      new Headers({ "x-api-key": proxyKey }),
      new Headers({ authorization: `Bearer ${proxyKey}` }),
    ]) {
      const response = await geminiRequest(version, "countTokens", headers);
      assert.equal(response.status, 200);
      assert.ok((await response.json()).totalTokens > 0);
    }
    assert.equal(upstream.mock.callCount(), 0);
  });

  test(`Gemini ${version} rejects missing or invalid SDK credentials`, async () => {
    assert.equal((await geminiRequest(version, "generateContent")).status, 401);
    for (const wrongKey of ["wrong", "x".repeat(proxyKey.length), "é".repeat(proxyKey.length)]) {
      const response = await geminiRequest(version, "generateContent", { "x-goog-api-key": wrongKey });
      assert.equal(response.status, 403);
    }
  });
}

test("Google SDK credentials are not accepted on unrelated routes or methods", async () => {
  const headers = { "x-goog-api-key": proxyKey };
  assert.equal((await app.request("/v1/models", { headers })).status, 401);
  assert.equal((await app.request("/v1/chat/completions", { method: "POST", headers })).status, 401);
  assert.equal((await app.request(`/v1/models/${model}:generateContent`, { headers })).status, 401);
  assert.equal((await geminiRequest("v1", "unsupported", headers)).status, 401);
});

test("GET /v1/models remains an OpenAI-style model catalog", async () => {
  state.models = { object: "list", data: [] };
  const response = await app.request("/v1/models", { headers: { "x-api-key": proxyKey } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { object: "list", data: [], has_more: false });
});
