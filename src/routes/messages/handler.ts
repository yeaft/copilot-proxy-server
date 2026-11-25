import type { Context } from "hono";

import { logger } from "../../lib/logger.js";
import { state } from "../../lib/state.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { extractClientHeaders } from "../../lib/headers.js";
import {
  chatUsage,
  streamObserved,
  type RequestObservation,
} from "../../lib/request-observation.js";
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

export async function handleMessagesCompletion(c: Context, observation: RequestObservation) {
  await checkRateLimit(state);

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>();
  observation.request(anthropicPayload.model, anthropicPayload.stream === true);
  logger.debug("Anthropic request payload:", () => JSON.stringify(anthropicPayload));

  // Route DeepSeek models directly (DeepSeek uses Anthropic-compatible API)
  if (isDeepseekModel(anthropicPayload.model)) {
    return handleDeepseekCompletion(c, anthropicPayload, observation);
  }

  const openAIPayload = translateToOpenAI(anthropicPayload);
  logger.debug("Translated OpenAI payload:", () => JSON.stringify(openAIPayload));

  const clientHeaders = extractClientHeaders(c);
  const response = await createChatCompletions(openAIPayload, clientHeaders, {
    signal: c.req.raw.signal,
  });

  if (isNonStreaming(response)) {
    logger.debug("Non-streaming response from Copilot");
    const anthropicResponse = translateToAnthropic(response);
    if (response.usage) observation.reportUsage(chatUsage(response.usage));
    return c.json(anthropicResponse);
  }

  logger.debug("Streaming response from Copilot");
  return streamObserved(c, observation, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    };

    for await (const rawEvent of response) {
      if (!rawEvent.data) continue;

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk;
      observation.chatChunk(chunk);
      const events = translateChunkToAnthropicEvents(chunk, streamState);

      for (const event of events) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        });
      }
    }
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
  observation: RequestObservation
) {
  // Set first so failures to reach DeepSeek are attributed to it too.
  observation.endpoint = "deepseek-messages";
  const response = await createDeepseekCompletion(
    "/v1/messages",
    anthropicPayload as unknown as Record<string, unknown>,
    { signal: c.req.raw.signal }
  );

  // The body is relayed untouched, so usage is unknown and timing ends at the upstream headers.
  observation.finish(response.ok ? "ok" : "http_error", response.status);
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
