import assert from "node:assert/strict";
import test from "node:test";

import { hasChatOutput, hasResponsesOutput } from "../src/lib/latency.js";
import type { ChatCompletionChunk } from "../src/types/openai.js";

function chunk(delta: Record<string, unknown>): ChatCompletionChunk {
  return {
    id: "chunk",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [{
      index: 0,
      delta,
      finish_reason: null,
      logprobs: null,
    }],
  } as ChatCompletionChunk;
}

test("chat TTFT ignores metadata and records text or tool output", () => {
  assert.equal(hasChatOutput(chunk({ role: "assistant" })), false);
  assert.equal(hasChatOutput(chunk({})), false);
  assert.equal(hasChatOutput(chunk({ content: "hello" })), true);
  assert.equal(hasChatOutput(chunk({ refusal: "no" })), true);
  assert.equal(hasChatOutput(chunk({
    tool_calls: [{ index: 0, function: { arguments: "{" } }],
  })), true);
  assert.equal(hasChatOutput(chunk({
    tool_calls: [{ index: 0, custom: { input: "4 + 4" } }],
  })), true);
  // Reasoning summaries and opaque state are not answer output.
  assert.equal(hasChatOutput(chunk({ reasoning_text: "thinking" })), false);
  assert.equal(hasChatOutput(chunk({ reasoning_opaque: "state" })), false);
});

test("responses TTFT ignores lifecycle events and records output deltas", () => {
  assert.equal(hasResponsesOutput("response.created", undefined), false);
  assert.equal(hasResponsesOutput("response.output_text.delta", ""), false);
  assert.equal(hasResponsesOutput("response.output_text.delta", "hello"), true);
  assert.equal(hasResponsesOutput("response.refusal.delta", "no"), true);
  assert.equal(
    hasResponsesOutput("response.function_call_arguments.delta", "{"),
    true
  );
  assert.equal(hasResponsesOutput("response.custom_tool_call_input.delta", "4"), true);
  assert.equal(hasResponsesOutput("response.reasoning_summary_text.delta", "thinking"), false);
});
