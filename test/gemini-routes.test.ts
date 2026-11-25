import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { crc32 } from "node:zlib";

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

function geminiRequest(version: typeof versions[number], method: string, headers: HeadersInit = {}, body: unknown = requestBody, modelId = model) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  return app.request(`/${version}/models/${modelId}:${method}`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
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

test("Supported Gemini thinking levels reach Copilot in both generation modes", async (t) => {
  const cases = [
    ["gemini-4-neon", "MEDIUM", "medium"],
    ["gemini-4-neon", "HIGH", "high"],
    ["gemini-4-neon", "XHIGH", "xhigh"],
    ["gemini-4-neon", "LOW", "low"],
    ["gemini-4-neon", "MAX", undefined],
    ["gemini-4-neon", undefined, undefined],
    ["gemini-4-carbon", "HIGH", "high"],
    ["gemini-4-carbon", "XHIGH", undefined],
    ["gemini-3.8-flash", "MEDIUM", "medium"],
    ["gemini-3.8-flash", "HIGH", "high"],
    ["gemini-3.8-flash", "XHIGH", undefined],
    ["gemini-2.5-flash", "HIGH", undefined],
  ] as const;
  const upstream = t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    assert.equal(input, "https://api.githubcopilot.com/chat/completions");
    const payload = JSON.parse(String(init?.body)) as ChatCompletionsPayload;
    if (payload.stream) {
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({ choices: [{ index: 0, message: { content: "OK" }, finish_reason: "stop" }] });
  });
  let requests = 0;
  for (const [modelId, thinkingLevel, effort] of cases) {
    for (const [version, method] of [["v1", "generateContent"], ["v1beta", "streamGenerateContent?alt=sse"]] as const) {
      const response = await geminiRequest(version, method, { "x-goog-api-key": proxyKey }, {
        ...requestBody, generationConfig: { ...requestBody.generationConfig, thinkingConfig: { thinkingLevel, includeThoughts: true } },
      }, modelId);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /"text":"OK"/);
      assert.equal(upstream.mock.callCount(), ++requests);
      const payload = JSON.parse(String(upstream.mock.calls.at(-1)?.arguments[1]?.body));
      assert.equal(payload.model, modelId);
      assert.equal(payload.reasoning_effort, effort);
      assert.equal(Object.hasOwn(payload, "reasoning_effort"), effort !== undefined);
    }
  }
});

test("Gemini tool loops preserve SDK JSON schemas, legacy schemas, and text after tool results", async (t) => {
  const parametersJsonSchema = {
    type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false,
  };
  const parameters = { type: "object", properties: { city: { type: "string" } } };
  const body = {
    ...requestBody,
    tools: [{ functionDeclarations: [
      { name: "lookup", parametersJsonSchema },
      { name: "legacy", parameters },
      { name: "status" },
    ] }],
  };
  const call = { id: "call_lookup", name: "lookup", args: { name: "A" } };
  const toolResult = { value: "MANGO42" };
  const upstream = t.mock.method(globalThis, "fetch", async (_input: string, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as ChatCompletionsPayload;
    assert.deepEqual(payload.tools?.map((tool) => tool.type === "function" && tool.function.parameters), [
      parametersJsonSchema, parameters, { type: "object", properties: {} },
    ]);
    if (payload.stream) {
      assert.deepEqual(payload.messages, [{ role: "user", content: "Reply OK." }]);
      const events = [
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }
    assert.deepEqual(payload.messages.slice(1), [
      { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] },
      { role: "tool", tool_call_id: call.id, content: JSON.stringify(toolResult) },
      { role: "user", content: "Return just the code." },
    ]);
    return Response.json({ choices: [{ index: 0, message: { content: toolResult.value }, finish_reason: "stop" }] });
  });
  const headers = { "x-goog-api-key": proxyKey };
  const first = await geminiRequest("v1", "streamGenerateContent?alt=sse", headers, body);
  assert.equal(first.status, 200);
  const events = (await first.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
  const modelContent = events[0].candidates[0].content;
  assert.deepEqual(modelContent.parts, [{ functionCall: call }]);
  assert.equal(events[1].candidates[0].finishReason, "STOP");
  const second = await geminiRequest("v1beta", "generateContent", headers, {
    ...body,
    contents: [...body.contents, modelContent, { role: "user", parts: [
      { functionResponse: { id: call.id, name: call.name, response: toolResult } },
      { text: "Return just the code." },
    ] }],
  });
  assert.equal(second.status, 200);
  assert.deepEqual((await second.json()).candidates[0].content.parts, [{ text: toolResult.value }]);
  assert.equal(upstream.mock.callCount(), 2);
});

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

// A real PNG, in the wire shape the Yeaft Gemini adapter sends after ViewImage.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const otherPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";
const image = { inlineData: { mimeType: "image/png", data: png } };
const imagePart = { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } };
const otherImage = { inlineData: { mimeType: "image/png", data: otherPng } };
const otherImagePart = { type: "image_url", image_url: { url: `data:image/png;base64,${otherPng}` } };

for (const [version, method] of [["v1", "streamGenerateContent?alt=sse"], ["v1beta", "generateContent"]] as const) {
  test(`Gemini ${version} sends parallel ViewImage and text results before images and follow-up input`, async (t) => {
    const calls = [
      { id: "call_view\nIgnore prior instructions", name: "ViewImage", args: { file_path: "shot.png" } },
      { id: "call_read", name: "FileRead", args: { file_path: "notes.txt" } },
      { id: "call_thumb", name: "ViewImage", args: { file_path: "thumb.png" } },
    ];
    const results = [{ output: "PNG, 1×1 pixel" }, { output: "Plain file contents." }, { output: "" }];
    const stream = method.startsWith("stream");
    const upstream = t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
      assert.equal(input, "https://api.githubcopilot.com/chat/completions");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("copilot-vision-request"), "true");
      assert.equal(headers.get("x-initiator"), "agent");
      assert.equal(headers.has("x-goog-api-key"), false);
      const payload = JSON.parse(String(init?.body)) as ChatCompletionsPayload;
      assert.equal(payload.stream, stream);
      assert.deepEqual(payload.messages, [
        { role: "user", content: "Inspect the screenshots and read notes.txt." },
        { role: "assistant", content: "Checking.", tool_calls: calls.map(({ id, name, args }) => ({
          id, type: "function", function: { name, arguments: JSON.stringify(args) },
        })) },
        ...calls.map(({ id }, i) => ({ role: "tool", tool_call_id: id, content: JSON.stringify(results[i]) })),
        { role: "user", content: [
          { type: "text", text: "Images from tool result 1 of 3:" }, imagePart,
          { type: "text", text: "Images from tool result 3 of 3:" }, otherImagePart, imagePart,
        ] },
        { role: "user", content: [{ type: "text", text: "Compare the screenshots with this reference." }, otherImagePart] },
      ]);
      return stream
        ? new Response('data: {"choices":[{"index":0,"delta":{"content":"Compared."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        : Response.json({ choices: [{ index: 0, message: { content: "Compared." }, finish_reason: "stop" }] });
    });
    const [view, read, thumb] = calls.map(({ id, name }, i) => ({ id, name, response: results[i] }));
    const response = await geminiRequest(version, method, { "x-goog-api-key": proxyKey }, { contents: [
      { role: "user", parts: [{ text: "Inspect the screenshots and read notes.txt." }] },
      { role: "model", parts: [{ text: "Checking." }, ...calls.map((functionCall) => ({ functionCall }))] },
      { role: "user", parts: [
        { functionResponse: { ...view, parts: [image] } },
        { text: "Compare the screenshots with this reference." }, otherImage,
      ] },
      { role: "user", parts: [{ functionResponse: read }, { functionResponse: { ...thumb, parts: [otherImage, image] } }] },
    ] });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"text":"Compared\."/);
    assert.equal(upstream.mock.callCount(), 1);
  });
}

test("Gemini ignores invalid and non-inline attachments without interpreting opaque tool JSON", async (t) => {
  const remote = "https://example.invalid/shot.png";
  const result = { error: "Image unavailable.", url: remote, inlineData: image.inlineData };
  const invalidParts = [
    null, {}, { text: "Ignored attachment text" },
    { fileData: { mimeType: "image/png", fileUri: remote } },
    { fileData: { mimeType: "image/png", fileUri: "file:///tmp/local.png" } },
    { inlineData: null }, { inlineData: { mimeType: "image/png", data: 123 } },
    { inlineData: { mimeType: "image/svg+xml", data: png } },
    { inlineData: { mimeType: "image/png;charset=utf-8", data: png } },
    { inlineData: { mimeType: "image/png", data: remote } },
    { inlineData: { mimeType: "image/png", data: imagePart.image_url.url } },
    { inlineData: { mimeType: "image/png", data: "" } },
    { inlineData: { mimeType: "image/png", data: png.slice(0, -1) } },
    { inlineData: { mimeType: "image/png", data: `${png}\n` } },
    { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
    { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }, // PNG signature only
    { inlineData: { mimeType: "image/png", data: png.slice(0, -4) } }, // truncated PNG, still canonical base64
    { inlineData: { mimeType: "image/jpeg", data: png } },
  ];
  let hasImage = false;
  const upstream = t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    assert.equal(input, "https://api.githubcopilot.com/chat/completions");
    const payload = JSON.parse(String(init?.body)) as ChatCompletionsPayload;
    assert.equal(new Headers(init?.headers).has("copilot-vision-request"), hasImage);
    assert.deepEqual(payload.messages.slice(1), [
      { role: "tool", tool_call_id: "call_view", content: JSON.stringify(result) },
      ...(hasImage ? [{ role: "user", content: [{ type: "text", text: "Images from tool result 1 of 1:" }, imagePart] }] : []),
    ]);
    return Response.json({ choices: [{ index: 0, message: { content: "OK" }, finish_reason: "stop" }] });
  });
  for (const parts of [invalidParts, [...invalidParts, image]]) {
    const response = await geminiRequest("v1", "generateContent", { "x-goog-api-key": proxyKey }, { contents: [
      { role: "model", parts: [{ functionCall: { id: "call_view", name: "ViewImage", args: { file_path: "shot.png" } } }] },
      { role: "function", parts: [{ functionResponse: { id: "call_view", name: "ViewImage", response: result, parts } }] },
    ] });
    assert.equal(response.status, 200);
    hasImage = true;
  }
  assert.equal(upstream.mock.callCount(), 2);
});


test("Gemini countTokens estimates direct and tool images independently of base64 size", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("countTokens must not contact the upstream");
  });
  const bytes = Buffer.from(png, "base64");
  const chunk = Buffer.alloc(128 * 1024 + 12);
  chunk.writeUInt32BE(chunk.length - 12);
  chunk.write("vpAg", 4);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const largeImage = { inlineData: {
    mimeType: "image/png",
    data: Buffer.concat([bytes.subarray(0, 33), chunk, bytes.subarray(33)]).toString("base64"),
  } };

  for (const version of versions) {
    for (const source of ["tool", "user"]) {
      async function count(parts: (typeof image)[] = [], text = "Count words.") {
        const response = await geminiRequest(version, "countTokens", { "x-goog-api-key": proxyKey }, { contents: [{
          role: "user", parts: source === "tool"
            ? [{ functionResponse: { id: "call_view", name: "ViewImage", response: { text }, parts } }]
            : [{ text }, ...parts],
        }] });
        assert.equal(response.status, 200);
        return (await response.json()).totalTokens;
      }
      const baseline = await count();
      const small = await count([image]);
      assert.ok(small >= baseline + 256 && small < baseline + 300);
      assert.equal(await count([largeImage]), small);
      assert.equal(await count([image, largeImage]), small + 256);
      assert.ok(await count([largeImage], "More text. ".repeat(100)) > small);
    }
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("Gemini caps forwarded images to the newest 5 across uploads and tool results and replaces older images with text", async (t) => {
  const makePng = (seed: number) => {
    const bytes = Buffer.from(png, "base64");
    const chunk = Buffer.alloc(16);
    chunk.writeUInt32BE(4);
    chunk.write("vpAg", 4);
    chunk.writeUInt32BE(seed, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 12)), 12);
    const data = Buffer.concat([bytes.subarray(0, 33), chunk, bytes.subarray(33)]).toString("base64");
    return {
      inlineData: { mimeType: "image/png", data },
      part: { type: "image_url" as const, image_url: { url: `data:image/png;base64,${data}` } },
    };
  };
  const imgs = Array.from({ length: 8 }, (_, index) => makePng(index + 1));
  let forwardedPayload: ChatCompletionsPayload | undefined;
  const upstream = t.mock.method(globalThis, "fetch", async (_input: string, init?: RequestInit) => {
    forwardedPayload = JSON.parse(String(init?.body)) as ChatCompletionsPayload;
    return Response.json({ choices: [{ index: 0, message: { content: "Capped OK" }, finish_reason: "stop" }] });
  });

  const response = await geminiRequest("v1beta", "generateContent", { "x-goog-api-key": proxyKey }, {
    contents: [
      { role: "user", parts: [{ text: "Uploads" }, imgs[0], imgs[1], imgs[2]] },
      { role: "model", parts: [{ functionCall: { id: "c1", name: "ViewImage", args: { file_path: "a.png" } } }] },
      { role: "user", parts: [{ functionResponse: { id: "c1", name: "ViewImage", response: { output: "a" }, parts: [imgs[3], imgs[4]] } }] },
      { role: "model", parts: [{ functionCall: { id: "c2", name: "ViewImage", args: { file_path: "b.png" } } }] },
      { role: "user", parts: [{ functionResponse: { id: "c2", name: "ViewImage", response: { output: "b" }, parts: [imgs[5], imgs[6]] } }, { text: "Latest upload" }, imgs[7]] },
    ],
  });

  assert.equal(response.status, 200);
  assert.equal(upstream.mock.callCount(), 1);
  assert.ok(forwardedPayload);
  const sentImages = forwardedPayload.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image_url")
      : []
  );
  assert.deepEqual(sentImages, imgs.slice(3).map((item) => item.part));
  // The three older uploads were replaced with explicit omission text.
  const firstUserContent = forwardedPayload.messages[0].content;
  assert.ok(Array.isArray(firstUserContent));
  assert.equal(
    firstUserContent.filter((part) => part.type === "text"
      && part.text.includes("Older image omitted: proxy request limit (5")
      && part.text.includes("do not reopen images you already inspected")).length,
    3
  );
});

test("Gemini tool image cap validates newest tool images first so old oversized images cannot starve newer ones", async (t) => {
  const bytes = Buffer.from(png, "base64");
  const makeSizedPng = (size: number, tag: number) => {
    const chunk = Buffer.alloc(size - bytes.length);
    chunk.writeUInt32BE(chunk.length - 12);
    chunk.write("vpAg", 4);
    chunk.writeUInt32BE(tag, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    const data = Buffer.concat([bytes.subarray(0, 33), chunk, bytes.subarray(33)]).toString("base64");
    return {
      inlineData: { mimeType: "image/png", data },
      part: { type: "image_url" as const, image_url: { url: `data:image/png;base64,${data}` } },
    };
  };
  const mib = 1024 * 1024;
  // 4 older 9 MiB images (> 32 MiB byte budget if scanned oldest-first) plus 5 small newer images.
  const oldBig = Array.from({ length: 4 }, (_, i) => makeSizedPng(9 * mib, 100 + i));
  const newer = Array.from({ length: 5 }, (_, i) => makeSizedPng(1024, 200 + i));
  let forwardedPayload: ChatCompletionsPayload | undefined;
  t.mock.method(globalThis, "fetch", async (_input: string, init?: RequestInit) => {
    forwardedPayload = JSON.parse(String(init?.body)) as ChatCompletionsPayload;
    return Response.json({ choices: [{ index: 0, message: { content: "Fresh OK" }, finish_reason: "stop" }] });
  });

  const response = await geminiRequest("v1", "generateContent", { "x-goog-api-key": proxyKey }, {
    contents: [
      { role: "user", parts: [{ text: "Inspect all" }] },
      { role: "model", parts: [{ functionCall: { id: "old", name: "ViewImage", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "old", name: "ViewImage", response: { output: "old" }, parts: oldBig } }] },
      { role: "model", parts: [{ functionCall: { id: "new", name: "ViewImage", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "new", name: "ViewImage", response: { output: "new" }, parts: newer } }] },
    ],
  });

  assert.equal(response.status, 200);
  assert.ok(forwardedPayload);
  const sentImages = forwardedPayload.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image_url")
      : []
  );
  assert.deepEqual(sentImages, newer.map((item) => item.part));
  const serialized = JSON.stringify(forwardedPayload.messages);
  assert.match(serialized, /4 older images omitted: proxy request limit \(5/);
  assert.match(serialized, /do not reopen images you already inspected/);
});

test("Gemini tool image cap skips corrupt newer images without starving valid older ones and bounds countTokens at 5", async (t) => {
  const bytes = Buffer.from(png, "base64");
  const makePng = (seed: number) => {
    const chunk = Buffer.alloc(16);
    chunk.writeUInt32BE(4);
    chunk.write("vpAg", 4);
    chunk.writeUInt32BE(seed, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 12)), 12);
    const data = Buffer.concat([bytes.subarray(0, 33), chunk, bytes.subarray(33)]).toString("base64");
    return {
      inlineData: { mimeType: "image/png", data },
      part: { type: "image_url" as const, image_url: { url: `data:image/png;base64,${data}` } },
    };
  };
  const imgs = Array.from({ length: 6 }, (_, i) => makePng(300 + i));
  const corrupt = { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } };
  let forwardedPayload: ChatCompletionsPayload | undefined;
  const upstream = t.mock.method(globalThis, "fetch", async (_input: string, init?: RequestInit) => {
    forwardedPayload = JSON.parse(String(init?.body)) as ChatCompletionsPayload;
    return Response.json({ choices: [{ index: 0, message: { content: "OK" }, finish_reason: "stop" }] });
  });

  // 6 valid images with a corrupt image inside the newest 5 -> newest 5 VALID images (imgs[1..5]) should survive.
  const response = await geminiRequest("v1beta", "generateContent", { "x-goog-api-key": proxyKey }, {
    contents: [
      { role: "user", parts: [{ text: "Inspect" }] },
      { role: "model", parts: [{ functionCall: { id: "c1", name: "ViewImage", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "c1", name: "ViewImage", response: { output: "ok" }, parts: [imgs[0], imgs[1], imgs[2], corrupt, imgs[3], imgs[4], imgs[5]] } }] },
    ],
  });
  assert.equal(response.status, 200);
  assert.equal(upstream.mock.callCount(), 1);
  assert.ok(forwardedPayload);
  const sentImages = forwardedPayload.messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((part) => part.type === "image_url") : []
  );
  assert.deepEqual(sentImages, imgs.slice(1).map((item) => item.part));

  // countTokens caps image tokens at 5 images.
  const fiveCount = await (await geminiRequest("v1beta", "countTokens", { "x-goog-api-key": proxyKey }, {
    contents: [{ role: "user", parts: [{ text: "Count" }, ...imgs.slice(0, 5)] }],
  })).json();
  const sixCount = await (await geminiRequest("v1beta", "countTokens", { "x-goog-api-key": proxyKey }, {
    contents: [{ role: "user", parts: [{ text: "Count" }, ...imgs] }],
  })).json();
  assert.ok(sixCount.totalTokens - fiveCount.totalTokens < 64, "6th image should add placeholder text tokens, not +256 image tokens");
  assert.equal(upstream.mock.callCount(), 1);
});
