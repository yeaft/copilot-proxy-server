import assert from "node:assert/strict";
import test from "node:test";

import {
  responsesStreamToChatStream,
  responsesToChatResponse,
} from "../src/services/copilot-completions.js";
import type { ResponsesResult } from "../src/types/responses.js";

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
    input_tokens_details: { cached_tokens: 800 },
  },
};

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
