import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import { logger } from "../../lib/logger.js";
import { state } from "../../lib/state.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { extractClientHeaders } from "../../lib/headers.js";
import { logUsage } from "../../lib/db.js";
import { getClientIp } from "../../lib/ip.js";
import { createChatCompletions } from "../../services/copilot-completions.js";
import {
  createDeepseekCompletion,
  isDeepseekModel,
} from "../../services/deepseek-completions.js";
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "../../types/openai.js";
import type {
  AnthropicMessagesPayload,
  AnthropicStreamState,
} from "./anthropic-types.js";
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation.js";
import { translateChunkToAnthropicEvents } from "./stream-translation.js";

export async function handleMessagesCompletion(c: Context) {
  await checkRateLimit(state);
  const startTime = Date.now();

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>();
  logger.debug("Anthropic request payload:", JSON.stringify(anthropicPayload));

  // Route DeepSeek models directly (DeepSeek uses Anthropic-compatible API)
  if (isDeepseekModel(anthropicPayload.model)) {
    return handleDeepseekCompletion(c, anthropicPayload, startTime);
  }

  const openAIPayload = translateToOpenAI(anthropicPayload);
  logger.debug("Translated OpenAI payload:", JSON.stringify(openAIPayload));

  const clientHeaders = extractClientHeaders(c);
  const response = await createChatCompletions(openAIPayload, clientHeaders);
  const ip = getClientIp(c);

  if (isNonStreaming(response)) {
    logger.debug("Non-streaming response from Copilot");
    const anthropicResponse = translateToAnthropic(response);
    logUsage({
      ip,
      model: anthropicPayload.model,
      endpoint: "anthropic",
      prompt_tokens: response.usage?.prompt_tokens ?? 0,
      completion_tokens: response.usage?.completion_tokens ?? 0,
      total_tokens: response.usage?.total_tokens ?? 0,
      cached_prompt_tokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      stream: false,
      duration_ms: Date.now() - startTime,
      ttfb_ms: Date.now() - startTime,
    });
    return c.json(anthropicResponse);
  }

  logger.debug("Streaming response from Copilot");
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    };
    let lastUsage: ChatCompletionChunk["usage"] | undefined;
    let ttfb = 0;

    for await (const rawEvent of response) {
      if (!rawEvent.data) continue;
      if (!ttfb) ttfb = Date.now() - startTime;

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk;
      if (chunk.usage) lastUsage = chunk.usage;
      const events = translateChunkToAnthropicEvents(chunk, streamState);

      for (const event of events) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        });
      }
    }

    logUsage({
      ip,
      model: anthropicPayload.model,
      endpoint: "anthropic",
      prompt_tokens: lastUsage?.prompt_tokens ?? 0,
      completion_tokens: lastUsage?.completion_tokens ?? 0,
      total_tokens: lastUsage?.total_tokens ?? 0,
      cached_prompt_tokens: lastUsage?.prompt_tokens_details?.cached_tokens ?? 0,
      stream: true,
      duration_ms: Date.now() - startTime,
      ttfb_ms: ttfb,
    });
  });
}

/**
 * Handle completion requests for DeepSeek models.
 * DeepSeek uses Anthropic-compatible Messages API, so we forward the request
 * as-is without any Anthropic ↔ OpenAI translation.
 */
async function handleDeepseekCompletion(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  startTime: number
) {
  const response = await createDeepseekCompletion(
    "/v1/messages",
    anthropicPayload as unknown as Record<string, unknown>
  );

  logUsage({
    ip: getClientIp(c),
    model: anthropicPayload.model,
    endpoint: "deepseek-messages",
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    stream: Boolean(anthropicPayload.stream),
    duration_ms: Date.now() - startTime,
    ttfb_ms: Date.now() - startTime,
  });

  return response;
}

export async function handleCountTokens(c: Context) {
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>();
  const openAIPayload = translateToOpenAI(anthropicPayload);

  // Simple estimation based on JSON size
  const jsonStr = JSON.stringify(openAIPayload.messages);
  const estimatedTokens = Math.ceil(jsonStr.length / 4);

  let finalCount = estimatedTokens;
  if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
    const toolsStr = JSON.stringify(anthropicPayload.tools);
    finalCount += Math.ceil(toolsStr.length / 4);
  }

  if (anthropicPayload.model.startsWith("claude")) {
    finalCount = Math.round(finalCount * 1.15);
  }

  return c.json({ input_tokens: finalCount });
}

function isNonStreaming(
  response: ChatCompletionResponse | AsyncIterable<{ data: string }>
): response is ChatCompletionResponse {
  return Object.hasOwn(response as object, "choices");
}
