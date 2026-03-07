import type { Context } from "hono";
import { streamSSE, type SSEMessage } from "hono/streaming";

import { logger } from "../../lib/logger.js";
import { state } from "../../lib/state.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { extractClientHeaders } from "../../lib/headers.js";
import { logUsage } from "../../lib/db.js";
import { getClientIp } from "../../lib/ip.js";
import { createChatCompletions } from "../../services/copilot-completions.js";
import type {
  ChatCompletionsPayload,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from "../../types/openai.js";

export async function handleChatCompletion(c: Context) {
  await checkRateLimit(state);
  const startTime = Date.now();

  const payload = await c.req.json<ChatCompletionsPayload>();
  logger.debug("OpenAI request payload:", JSON.stringify(payload).slice(-400));

  // Set max_tokens from model capabilities if not provided
  if (payload.max_tokens == null) {
    const selectedModel = state.models?.data.find(
      (model) => model.id === payload.model
    );
    if (selectedModel?.capabilities.limits.max_output_tokens) {
      payload.max_tokens = selectedModel.capabilities.limits.max_output_tokens;
    }
  }

  const clientHeaders = extractClientHeaders(c);
  const response = await createChatCompletions(payload, clientHeaders);
  const ip = getClientIp(c);

  if (isNonStreaming(response)) {
    logger.debug("Non-streaming response");
    logUsage({
      ip,
      model: payload.model,
      endpoint: "openai",
      prompt_tokens: response.usage?.prompt_tokens ?? 0,
      completion_tokens: response.usage?.completion_tokens ?? 0,
      total_tokens: response.usage?.total_tokens ?? 0,
      stream: false,
      duration_ms: Date.now() - startTime,
    });
    return c.json(response);
  }

  logger.debug("Streaming response");
  return streamSSE(c, async (stream) => {
    let lastUsage: ChatCompletionChunk["usage"] | undefined;
    for await (const chunk of response) {
      await stream.writeSSE(chunk as SSEMessage);
      // Track usage from the last chunk that has it
      try {
        const parsed = JSON.parse((chunk as SSEMessage).data) as ChatCompletionChunk;
        if (parsed.usage) lastUsage = parsed.usage;
      } catch { /* ignore parse errors */ }
    }
    logUsage({
      ip,
      model: payload.model,
      endpoint: "openai",
      prompt_tokens: lastUsage?.prompt_tokens ?? 0,
      completion_tokens: lastUsage?.completion_tokens ?? 0,
      total_tokens: lastUsage?.total_tokens ?? 0,
      stream: true,
      duration_ms: Date.now() - startTime,
    });
  });
}

function isNonStreaming(
  response: ChatCompletionResponse | AsyncIterable<{ data: string }>
): response is ChatCompletionResponse {
  return Object.hasOwn(response as object, "choices");
}
