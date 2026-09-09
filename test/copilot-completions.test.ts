import assert from "node:assert/strict";
import test from "node:test";

import {
  createResponses,
  responsesStreamToChatStream,
  responsesToChatResponse,
} from "../src/services/copilot-completions.js";
import { state } from "../src/lib/state.js";
import type { ResponsesPayload, ResponsesResult } from "../src/types/responses.js";

const response: ResponsesResult = {
  id: "resp_1",
  object: "response",
  created_at: 1,
  status: "completed",
  model: "gpt-5.6-sol-fast",
  output: [],
  usage: {
    input_tokens: 1_000,
    output_tokens: 100,
    total_tokens: 1_100,
    input_tokens_details: { cached_tokens: 800, cache_write_tokens: 120 },
  },
};

test("Responses requests preserve cache keys, reasoning continuity, and function items", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = state.copilotToken;
  let forwarded: ResponsesPayload | undefined;
  state.copilotToken = "test-token";
  globalThis.fetch = async (_input, init) => {
    forwarded = JSON.parse(String(init?.body)) as ResponsesPayload;
    return new Response(JSON.stringify(response), {
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const payload: ResponsesPayload = {
      model: response.model,
      prompt_cache_key: "session-1",
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high", summary: "auto" },
      input: [
        { type: "reasoning", encrypted_content: "opaque" },
        { type: "function_call", call_id: "call-1", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "call-1", output: "ok" },
      ],
    };
    await createResponses(payload);
    assert.deepEqual(forwarded, payload);
  } finally {
    globalThis.fetch = originalFetch;
    state.copilotToken = originalToken;
  }
});

test("Responses non-stream conversion preserves cached input tokens", () => {
  const converted = responsesToChatResponse(response, response.model);

  assert.equal(converted.usage?.prompt_tokens_details?.cached_tokens, 800);
});

test("Responses stream conversion preserves cached input tokens", async () => {
  async function* source() {
    yield {
      event: "response.completed",
      data: JSON.stringify({
        type: "response.completed",
        sequence_number: 1,
        response,
      }),
    };
  }

  const chunks = [];
  for await (const chunk of responsesStreamToChatStream(source(), response.model)) {
    chunks.push(JSON.parse(chunk.data));
  }

  assert.equal(chunks.at(-1)?.usage?.prompt_tokens_details?.cached_tokens, 800);
});
