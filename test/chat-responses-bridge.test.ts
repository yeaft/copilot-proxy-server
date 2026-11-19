import assert from "node:assert/strict";
import test from "node:test";

import {
  chatToResponsesPayload,
  decodeReasoningOpaque,
  encodeReasoningOpaque,
  responsesStreamToChatStream,
  responsesToChatResponse,
  UnsupportedChatParameterError,
} from "../src/services/chat-responses-bridge.js";
import type {
  ChatCompletionChunk,
  ChatCompletionsPayload,
  MessageToolCall,
} from "../src/types/openai.js";
import type { ResponsesResult } from "../src/types/responses.js";

const model = "gpt-6-luna";
const weatherTool = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get weather",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

function request(overrides: Partial<ChatCompletionsPayload> = {}): ChatCompletionsPayload {
  return { model, messages: [{ role: "user", content: "hi" }], ...overrides };
}

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

test("tool-calling history becomes function_call items, not user text", () => {
  const opaque = encodeReasoningOpaque(["enc-1", "enc-2"]);
  const out = chatToResponsesPayload(request({
    messages: [
      { role: "system", content: "Be terse." },
      { role: "developer", content: [{ type: "text", text: "Use tools." }] },
      { role: "user", content: "Weather in Paris and Rome?" },
      {
        role: "assistant",
        content: "Checking.",
        reasoning_opaque: opaque,
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } },
          { id: "call_b", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Rome\"}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "18C" },
      { role: "tool", tool_call_id: "call_b", content: [{ type: "text", text: "21C" }] },
    ],
    tools: [weatherTool],
  }));

  assert.deepEqual(out.input, [
    { type: "message", role: "system", content: "Be terse." },
    { type: "message", role: "developer", content: [{ type: "input_text", text: "Use tools." }] },
    { type: "message", role: "user", content: "Weather in Paris and Rome?" },
    { type: "reasoning", encrypted_content: "enc-1", summary: [] },
    { type: "reasoning", encrypted_content: "enc-2", summary: [] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking." }] },
    { type: "function_call", call_id: "call_a", name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
    { type: "function_call", call_id: "call_b", name: "get_weather", arguments: "{\"city\":\"Rome\"}" },
    { type: "function_call_output", call_id: "call_a", output: "18C" },
    { type: "function_call_output", call_id: "call_b", output: [{ type: "input_text", text: "21C" }] },
  ]);
  assert.equal(out.instructions, undefined);
});

test("foreign reasoning_opaque (e.g. from Gemini) is never forwarded as ciphertext", () => {
  const out = chatToResponsesPayload(request({
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "a", reasoning_opaque: "NLOz…gemini-thought-signature" },
      { role: "user", content: "q2" },
    ],
  }));
  assert.equal((out.input as Array<{ type?: string }>).some((item) => item.type === "reasoning"), false);
  assert.deepEqual(decodeReasoningOpaque("copilot-proxy.responses.v1:not json"), []);
  assert.deepEqual(decodeReasoningOpaque(encodeReasoningOpaque(["x"])), ["x"]);
  assert.equal(encodeReasoningOpaque([]), undefined);
});

test("function tools keep Chat Completions' non-strict default", () => {
  const out = chatToResponsesPayload(request({
    tools: [
      weatherTool,
      { type: "function", function: { name: "ping" } },
      { type: "function", function: { name: "strict_one", parameters: { type: "object" }, strict: true } },
    ],
  }));
  assert.deepEqual(out.tools, [
    { type: "function", name: "get_weather", description: "Get weather", parameters: weatherTool.function.parameters, strict: false },
    { type: "function", name: "ping", parameters: null, strict: false },
    { type: "function", name: "strict_one", parameters: { type: "object" }, strict: true },
  ]);
});

test("custom tools, their calls and outputs map to custom_tool_call items", () => {
  const out = chatToResponsesPayload(request({
    tools: [{
      type: "custom",
      custom: {
        name: "math_exp",
        description: "Math",
        format: { type: "grammar", grammar: { syntax: "regex", definition: "^\\d+$" } },
      },
    }, { type: "custom", custom: { name: "free" } }],
    tool_choice: { type: "custom", custom: { name: "math_exp" } },
    messages: [
      { role: "user", content: "4+4" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_c", type: "custom", custom: { name: "math_exp", input: "4 + 4" } }] },
      { role: "tool", tool_call_id: "call_c", content: "8" },
    ],
  }));
  assert.deepEqual(out.tools, [
    { type: "custom", name: "math_exp", description: "Math", format: { type: "grammar", syntax: "regex", definition: "^\\d+$" } },
    { type: "custom", name: "free" },
  ]);
  assert.deepEqual(out.tool_choice, { type: "custom", name: "math_exp" });
  assert.deepEqual((out.input as unknown[]).slice(1), [
    { type: "custom_tool_call", call_id: "call_c", name: "math_exp", input: "4 + 4" },
    { type: "custom_tool_call_output", call_id: "call_c", output: "8" },
  ]);
});

test("tool_choice variants map to the Responses shapes", () => {
  const choice = (tool_choice: ChatCompletionsPayload["tool_choice"]) =>
    chatToResponsesPayload(request({ tools: [weatherTool], tool_choice })).tool_choice;
  assert.equal(choice("required"), "required");
  assert.deepEqual(choice({ type: "function", function: { name: "get_weather" } }), { type: "function", name: "get_weather" });
  assert.deepEqual(
    choice({ type: "allowed_tools", allowed_tools: { mode: "required", tools: [{ type: "function", function: { name: "get_weather" } }] } }),
    { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "get_weather" }] }
  );
});

test("images, files and prompt-cache breakpoints reach the Responses input", () => {
  const breakpoint = { mode: "explicit" as const };
  const out = chatToResponsesPayload(request({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Describe", prompt_cache_breakpoint: breakpoint },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA", detail: "low" } },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        { type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,BBB" } },
      ],
    }],
  }));
  assert.deepEqual(out.input, [{
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "Describe", prompt_cache_breakpoint: breakpoint },
      { type: "input_image", image_url: "data:image/png;base64,AAA", detail: "low" },
      { type: "input_image", image_url: "https://example.com/a.png", detail: "auto" },
      { type: "input_file", filename: "a.pdf", file_data: "data:application/pdf;base64,BBB" },
    ],
  }]);
});

test("sampling, reasoning, structured output and cache parameters are mapped", () => {
  const out = chatToResponsesPayload(request({
    stream: true,
    max_completion_tokens: 900,
    max_tokens: 100,
    temperature: 0.2,
    top_p: 0.9,
    reasoning_effort: "xhigh",
    verbosity: "low",
    response_format: { type: "json_schema", json_schema: { name: "fruit", schema: { type: "object" }, strict: true } },
    logprobs: true,
    top_logprobs: 3,
    parallel_tool_calls: false,
    prompt_cache_key: "session-1",
    prompt_cache_retention: "24h",
    safety_identifier: "user-hash",
    metadata: { app: "test" },
    user: "u1",
    store: true,
    service_tier: "priority",
    stop: ["END"],
    seed: 7,
  }));
  assert.deepEqual(out, {
    model,
    input: [{ type: "message", role: "user", content: "hi" }],
    stream: true,
    store: false,
    reasoning: { summary: "auto", effort: "xhigh" },
    include: ["reasoning.encrypted_content", "message.output_text.logprobs"],
    top_logprobs: 3,
    max_output_tokens: 900,
    temperature: 0.2,
    top_p: 0.9,
    parallel_tool_calls: false,
    text: {
      format: { type: "json_schema", name: "fruit", schema: { type: "object" }, strict: true },
      verbosity: "low",
    },
    metadata: { app: "test" },
    prompt_cache_key: "session-1",
    prompt_cache_retention: "24h",
    safety_identifier: "user-hash",
    user: "u1",
  });
});

test("json_schema response_format keeps Chat Completions' non-strict default", () => {
  const schema = { type: "object", properties: { fruit: { type: "string" } } };
  const out = chatToResponsesPayload(request({
    response_format: { type: "json_schema", json_schema: { name: "fruit", schema } },
  }));
  assert.deepEqual(out.text, { format: { type: "json_schema", name: "fruit", schema, strict: false } });
  assert.deepEqual(
    chatToResponsesPayload(request({ response_format: { type: "json_object" } })).text,
    { format: { type: "json_object" } }
  );
});

test("codex models drop temperature/top_p and non-reasoning models omit reasoning", () => {
  const codex = chatToResponsesPayload(request({ model: "gpt-5.3-codex", temperature: 0.5, top_p: 0.5 }));
  assert.equal(codex.temperature, undefined);
  assert.equal(codex.top_p, undefined);

  const plain = chatToResponsesPayload(request({ reasoning_effort: "low" }), { reasoning: false });
  assert.equal(plain.reasoning, undefined);
  assert.equal(plain.include, undefined);
});

test("parameters the Responses API cannot honour are rejected, not dropped", () => {
  const cases: Array<[Partial<ChatCompletionsPayload>, string]> = [
    [{ n: 2 }, "n"],
    [{ functions: [{ name: "f" }] }, "functions"],
    [{ function_call: "auto" }, "function_call"],
    [{ modalities: ["text", "audio"] }, "modalities"],
    [{ audio: { voice: "alloy", format: "mp3" } }, "modalities"],
    [{ web_search_options: {} }, "web_search_options"],
    [{ moderation: { model: "omni-moderation-latest" } }, "moderation"],
    [{ messages: [{ role: "function", name: "f", content: "x" }] }, "messages[0].role"],
    [{ messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "AA", format: "wav" } }] }] }, "messages[0].content[0]"],
  ];
  for (const [overrides, param] of cases) {
    assert.throws(
      () => chatToResponsesPayload(request(overrides)),
      (error: unknown) => error instanceof UnsupportedChatParameterError && error.param === param,
      param
    );
  }
  assert.doesNotThrow(() => chatToResponsesPayload(request({ n: 1 })));
});

// ---------------------------------------------------------------------------
// Non-streaming response
// ---------------------------------------------------------------------------

function result(overrides: Partial<ResponsesResult>): ResponsesResult {
  return {
    id: "resp_x",
    object: "response",
    created_at: 1_795_000_000,
    model: "gpt-6-luna-2026-01-01",
    status: "completed",
    output: [],
    usage: {
      input_tokens: 100,
      output_tokens: 40,
      total_tokens: 140,
      input_tokens_details: { cached_tokens: 64, cache_write_tokens: 8 },
      output_tokens_details: { reasoning_tokens: 12 },
    },
    ...overrides,
  };
}

test("non-stream: text, reasoning summary/state, usage details and copilot_usage", () => {
  const chat = responsesToChatResponse(result({
    service_tier: "default",
    copilot_usage: { total_nano_aiu: 5 },
    output: [
      { type: "reasoning", id: "r1", encrypted_content: "enc-final", summary: [{ type: "summary_text", text: "Plan A" }, { type: "summary_text", text: "Plan B" }] },
      { type: "message", id: "m1", role: "assistant", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "Let me check." }] },
      {
        type: "message", id: "m2", role: "assistant", status: "completed", phase: "final_answer",
        content: [{
          type: "output_text",
          text: "See docs.",
          annotations: [{ type: "url_citation", start_index: 4, end_index: 8, title: "Docs", url: "https://d" }],
          logprobs: [{ token: "See", logprob: -0.1, bytes: [83, 101, 101], top_logprobs: [] }],
        }],
      },
    ],
  }), model);

  const [choice] = chat.choices;
  assert.equal(chat.object, "chat.completion");
  assert.equal(chat.model, model);
  assert.equal(chat.service_tier, "default");
  assert.equal(choice.finish_reason, "stop");
  assert.equal(choice.message.content, "Let me check.\n\nSee docs.");
  assert.equal(choice.message.refusal, null);
  assert.equal(choice.message.tool_calls, undefined);
  assert.equal(choice.message.reasoning_text, "Plan A\n\nPlan B");
  assert.deepEqual(decodeReasoningOpaque(choice.message.reasoning_opaque), ["enc-final"]);
  // Annotation offsets are shifted into the joined content.
  assert.deepEqual(choice.message.annotations, [
    { type: "url_citation", url_citation: { start_index: 19, end_index: 23, title: "Docs", url: "https://d" } },
  ]);
  assert.equal(choice.message.content!.slice(19, 23), "docs");
  assert.equal(choice.logprobs?.content?.[0].token, "See");
  assert.deepEqual(chat.usage, {
    prompt_tokens: 100,
    completion_tokens: 40,
    total_tokens: 140,
    prompt_tokens_details: { cached_tokens: 64, cache_write_tokens: 8 },
    completion_tokens_details: { reasoning_tokens: 12 },
  });
  assert.deepEqual(chat.copilot_usage, { total_nano_aiu: 5 });
});

test("non-stream: parallel function and custom tool calls finish with tool_calls", () => {
  const chat = responsesToChatResponse(result({
    output: [
      { type: "function_call", id: "fc1", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Paris\"}", status: "completed" },
      { type: "function_call", id: "fc2", call_id: "call_2", name: "get_time", arguments: "{\"city\":\"Paris\"}", status: "completed" },
      { type: "custom_tool_call", id: "ct1", call_id: "call_3", name: "math_exp", input: "4 + 4", status: "completed" },
    ],
  }), model);
  const [choice] = chat.choices;
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.message.content, null);
  assert.deepEqual(choice.message.tool_calls, [
    { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } },
    { id: "call_2", type: "function", function: { name: "get_time", arguments: "{\"city\":\"Paris\"}" } },
    { id: "call_3", type: "custom", custom: { name: "math_exp", input: "4 + 4" } },
  ] satisfies Array<MessageToolCall>);
});

test("non-stream: truncation and content filtering set length/content_filter", () => {
  const truncatedCall = responsesToChatResponse(result({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"L", status: "incomplete" }],
  }), model);
  assert.equal(truncatedCall.choices[0].finish_reason, "length");
  assert.equal(truncatedCall.choices[0].message.tool_calls?.length, 1);

  const filtered = responsesToChatResponse(result({
    status: "incomplete",
    incomplete_details: { reason: "content_filter" },
    output: [{ type: "message", id: "m", role: "assistant", status: "incomplete", content: [{ type: "refusal", refusal: "Can't help." }] }],
  }), model);
  assert.equal(filtered.choices[0].finish_reason, "content_filter");
  assert.equal(filtered.choices[0].message.refusal, "Can't help.");
});

// ---------------------------------------------------------------------------
// Streaming response
// ---------------------------------------------------------------------------

type Event = Record<string, unknown> & { type: string };

async function* sse(events: Array<Event>) {
  let sequence = 0;
  for (const event of events) {
    yield { event: event.type, data: JSON.stringify({ sequence_number: sequence++, ...event }) };
  }
}

async function collect(events: Array<Event>, includeUsage = false) {
  const data: Array<string> = [];
  for await (const chunk of responsesStreamToChatStream(sse(events), model, { includeUsage })) {
    data.push(chunk.data);
  }
  const chunks = data.filter((d) => d !== "[DONE]").map((d) => JSON.parse(d) as ChatCompletionChunk & { error?: { message: string } });
  return { data, chunks };
}

/** Reassemble chunks the way OpenAI SDKs do. */
function accumulate(chunks: Array<ChatCompletionChunk>) {
  let content = "";
  let reasoning = "";
  let opaque: string | undefined;
  let finish: string | null = null;
  const calls: Array<{ id?: string; type?: string; name?: string; args: string }> = [];
  for (const chunk of chunks) {
    for (const choice of chunk.choices) {
      const { delta } = choice;
      content += delta.content ?? "";
      reasoning += delta.reasoning_text ?? "";
      opaque = delta.reasoning_opaque ?? opaque;
      finish = choice.finish_reason ?? finish;
      for (const call of delta.tool_calls ?? []) {
        const slot = (calls[call.index] ??= { args: "" });
        slot.id ??= call.id;
        slot.type ??= call.type;
        slot.name ??= call.function?.name ?? call.custom?.name;
        slot.args += call.function?.arguments ?? call.custom?.input ?? "";
      }
    }
  }
  return { content, reasoning, opaque, finish, calls };
}

const usage = {
  input_tokens: 88,
  output_tokens: 58,
  total_tokens: 146,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 8 },
};
const created = { type: "response.created", response: { id: "resp_s", created_at: 1_795_000_000, status: "in_progress", output: [], usage: null, service_tier: "default" } };

// Event shapes recorded from Copilot's /responses (gpt-5.4-nano, parallel tools).
const parallelToolEvents: Array<Event> = [
  created,
  { type: "response.in_progress", response: { id: "resp_s", created_at: 1_795_000_000, status: "in_progress", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "r", encrypted_content: "partial", summary: [] } },
  { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "r", encrypted_content: "final", summary: [] } },
  { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc1", call_id: "call_1", name: "get_weather", arguments: "", status: "in_progress" } },
  { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc1", delta: "{\"city\":" },
  { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc1", delta: "\"Paris\"}" },
  { type: "response.function_call_arguments.done", output_index: 1, item_id: "fc1", arguments: "{\"city\":\"Paris\"}" },
  { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc1", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Paris\"}", status: "completed" } },
  { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc2", call_id: "call_2", name: "get_time", arguments: "", status: "in_progress" } },
  { type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc2", delta: "{\"city\":\"Paris\"}" },
  { type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "fc2", call_id: "call_2", name: "get_time", arguments: "{\"city\":\"Paris\"}", status: "completed" } },
  {
    type: "response.completed",
    copilot_usage: { total_nano_aiu: 0 },
    response: {
      id: "resp_s", created_at: 1_795_000_000, status: "completed", usage, service_tier: "default",
      output: [
        { type: "reasoning", id: "r", encrypted_content: "final", summary: [] },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
        { type: "function_call", call_id: "call_2", name: "get_time", arguments: "{\"city\":\"Paris\"}" },
      ],
    },
  },
];

test("stream: parallel tool calls follow the Chat Completions chunk protocol", async () => {
  const { data, chunks } = await collect(parallelToolEvents);
  assert.equal(data.at(-1), "[DONE]");
  assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant", content: "" });
  assert.ok(chunks.every((chunk) => chunk.id === "resp_s" && chunk.object === "chat.completion.chunk" && chunk.model === model));

  const headers = chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? []).filter((call) => call.id);
  assert.deepEqual(headers, [
    { index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } },
    { index: 1, id: "call_2", type: "function", function: { name: "get_time", arguments: "" } },
  ]);

  const message = accumulate(chunks);
  assert.equal(message.finish, "tool_calls");
  assert.deepEqual(message.calls.map((call) => [call.id, call.name, JSON.parse(call.args)]), [
    ["call_1", "get_weather", { city: "Paris" }],
    ["call_2", "get_time", { city: "Paris" }],
  ]);
  // Reasoning state comes from the final item, not the partial `added` payload.
  assert.deepEqual(decodeReasoningOpaque(message.opaque), ["final"]);

  const last = chunks.at(-1)!;
  assert.equal(last.choices[0].finish_reason, "tool_calls");
  assert.equal(last.usage?.completion_tokens_details?.reasoning_tokens, 8);
  assert.deepEqual(last.copilot_usage, { total_nano_aiu: 0 });
});

test("stream: summaries, preamble + answer, logprobs and refusal deltas", async () => {
  const text = (output_index: number, delta: string, logprobs: unknown[] = []) =>
    ({ type: "response.output_text.delta", output_index, content_index: 0, item_id: `m${output_index}`, delta, logprobs });
  const { chunks } = await collect([
    created,
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "r", summary: [] } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "**Plan**" },
    { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: " step" },
    { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 1, delta: "Next" },
    text(1, "Checking"),
    text(1, "."),
    text(2, "Done", [{ token: "Done", logprob: -0.01, bytes: [68], top_logprobs: [] }]),
    { type: "response.refusal.delta", output_index: 2, content_index: 1, delta: "No." },
    {
      type: "response.completed",
      response: {
        id: "resp_s", created_at: 1, status: "completed", usage,
        output: [{ type: "reasoning", id: "r", encrypted_content: "enc", summary: [] }],
      },
    },
  ]);
  const message = accumulate(chunks);
  assert.equal(message.reasoning, "**Plan** step\n\nNext");
  assert.equal(message.content, "Checking.\n\nDone");
  assert.equal(message.finish, "stop");
  assert.equal(chunks.find((chunk) => chunk.choices[0]?.logprobs)?.choices[0].logprobs?.content?.[0].token, "Done");
  assert.ok(chunks.some((chunk) => chunk.choices[0]?.delta.refusal === "No."));
});

test("stream: response.incomplete still finishes with length, usage and [DONE]", async () => {
  const { data, chunks } = await collect([
    created,
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"city\":\"L" },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"L", status: "incomplete" } },
    {
      type: "response.incomplete",
      response: { id: "resp_s", created_at: 1, status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage, output: [] },
    },
  ]);
  assert.equal(data.at(-1), "[DONE]");
  const last = chunks.at(-1)!;
  assert.equal(last.choices[0].finish_reason, "length");
  assert.equal(last.usage?.total_tokens, 146);
});

test("stream: include_usage emits null usage then a trailing usage-only chunk", async () => {
  const { data, chunks } = await collect(parallelToolEvents, true);
  assert.equal(data.at(-1), "[DONE]");
  const usageChunk = chunks.at(-1)!;
  assert.deepEqual(usageChunk.choices, []);
  assert.equal(usageChunk.usage?.prompt_tokens, 88);
  assert.ok(chunks.slice(0, -1).every((chunk) => chunk.usage === null));
  assert.equal(chunks.at(-2)!.choices[0].finish_reason, "tool_calls");
});

test("stream: tool calls announced only at output_item.done are emitted whole", async () => {
  const { chunks } = await collect([
    created,
    // Grok-style: no `added` header with call_id/name, arguments only on done.
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"city\":" },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call-uuid-0", name: "get_weather", arguments: "{\"city\":\"Oslo\"}" } },
    { type: "response.completed", response: { id: "resp_s", created_at: 1, status: "completed", usage, output: [] } },
  ]);
  const message = accumulate(chunks);
  assert.deepEqual(message.calls, [{ id: "call-uuid-0", type: "function", name: "get_weather", args: "{\"city\":\"Oslo\"}" }]);
  assert.equal(message.finish, "tool_calls");
});

test("stream: custom tool input streams as custom tool_call deltas", async () => {
  const { chunks } = await collect([
    created,
    { type: "response.output_item.added", output_index: 0, item: { type: "custom_tool_call", call_id: "call_c", name: "math_exp", input: "" } },
    { type: "response.custom_tool_call_input.delta", output_index: 0, delta: "4 + " },
    { type: "response.custom_tool_call_input.delta", output_index: 0, delta: "4" },
    { type: "response.output_item.done", output_index: 0, item: { type: "custom_tool_call", call_id: "call_c", name: "math_exp", input: "4 + 4" } },
    { type: "response.completed", response: { id: "resp_s", created_at: 1, status: "completed", usage, output: [] } },
  ]);
  const message = accumulate(chunks);
  assert.deepEqual(message.calls, [{ id: "call_c", type: "custom", name: "math_exp", args: "4 + 4" }]);
  assert.equal(message.finish, "tool_calls");
});

test("stream: upstream failures end with an error chunk and no [DONE]", async () => {
  for (const events of [
    [created, { type: "response.failed", response: { id: "resp_s", created_at: 1, status: "failed", output: [], usage: null, error: { code: "server_error", message: "boom" } } }],
    [created, { type: "error", code: "rate_limit_exceeded", message: "slow down", param: null }],
    [created, { type: "response.output_text.delta", output_index: 0, delta: "partial" }],
  ] as Array<Array<Event>>) {
    const { data, chunks } = await collect(events);
    assert.notEqual(data.at(-1), "[DONE]");
    assert.ok(chunks.at(-1)?.error?.message);
  }
});
