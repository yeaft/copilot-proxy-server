import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import { logger } from "../../lib/logger.js";
import { state } from "../../lib/state.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { extractClientHeaders } from "../../lib/headers.js";
import { logUsage } from "../../lib/db.js";
import { getClientIp } from "../../lib/ip.js";
import { hasChatOutput } from "../../lib/latency.js";
import {
  createChatCompletions,
  createResponses,
  hasImageInput,
  initiatorFor,
  modelSupportsReasoning,
  shouldUseResponsesApi,
} from "../../services/copilot-completions.js";
import {
  chatToResponsesPayload,
  responsesStreamToChatStream,
  responsesToChatResponse,
  UnsupportedChatParameterError,
} from "../../services/chat-responses-bridge.js";
import type {
  ChatCompletionsPayload,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatCompletionUsage,
} from "../../types/openai.js";
import type { ResponsesPayload, ResponsesResult } from "../../types/responses.js";
import {
  createDeepseekCompletion,
  isDeepseekModel,
} from "../../services/deepseek-completions.js";

export async function handleChatCompletion(c: Context) {
  await checkRateLimit(state);
  const startTime = Date.now();

  const payload = await c.req.json<ChatCompletionsPayload>();
  logger.debug("OpenAI request payload:", () => JSON.stringify(payload).slice(-400));

  if (isDeepseekModel(payload.model)) {
    return handleDeepseekChatCompletion(c, payload, startTime);
  }

  // Models that support /responses — route through it for better capabilities
  // (reasoning tokens, etc.). Codex models require it; gpt-5.x also prefers it.
  if (shouldUseResponsesApi(payload.model)) {
    return handleViaResponsesApi(c, payload, startTime);
  }

  // Set max_tokens from model capabilities if neither max_tokens nor max_completion_tokens is provided
  if (payload.max_tokens == null && payload.max_completion_tokens == null) {
    const selectedModel = state.models?.data.find(
      (model) => model.id === payload.model
    );
    if (selectedModel?.capabilities.limits.max_output_tokens) {
      payload.max_tokens = selectedModel.capabilities.limits.max_output_tokens;
    }
  }

  const clientHeaders = extractClientHeaders(c);
  const response = await createChatCompletions(payload, clientHeaders, { forwardDone: true });
  const ip = getClientIp(c);
  const record = (usage: ChatCompletionUsage | null | undefined, stream: boolean, ttfb: number) =>
    logChatUsage(ip, payload.model, usage, stream, Date.now() - startTime, ttfb);

  if (isNonStreaming(response)) {
    logger.debug("Non-streaming response");
    record(response.usage, false, 0);
    return c.json(response);
  }

  logger.debug("Streaming response");
  return streamChatChunks(c, response, startTime, record);
}

/**
 * Handle models that support /responses by converting chat/completions
 * requests to/from the Responses API format transparently.
 */
async function handleViaResponsesApi(
  c: Context,
  payload: ChatCompletionsPayload,
  startTime: number
) {
  logger.debug(`Model ${payload.model}: routing chat/completions → /responses`);

  let responsesPayload: ResponsesPayload;
  try {
    responsesPayload = chatToResponsesPayload(payload, {
      reasoning: modelSupportsReasoning(payload.model),
    });
  } catch (error) {
    if (!(error instanceof UnsupportedChatParameterError)) throw error;
    return c.json(
      {
        error: {
          message: error.message,
          type: "invalid_request_error",
          param: error.param,
          code: "unsupported_parameter",
        },
      },
      400
    );
  }

  const response = await createResponses(responsesPayload, extractClientHeaders(c), {
    vision: hasImageInput(payload.messages),
    initiator: initiatorFor(payload.messages),
  });
  const ip = getClientIp(c);
  const record = (usage: ChatCompletionUsage | null | undefined, stream: boolean, ttfb: number) =>
    logChatUsage(ip, payload.model, usage, stream, Date.now() - startTime, ttfb);

  if (isResponsesResult(response)) {
    const chatResponse = responsesToChatResponse(response, payload.model);
    record(chatResponse.usage, false, 0);
    if (response.status === "failed") {
      return c.json(
        {
          error: {
            message: response.error?.message || "Upstream response failed",
            type: "upstream_error",
            code: response.error?.code ?? null,
          },
        },
        502
      );
    }
    return c.json(chatResponse);
  }

  // The bridge always emits usage (on the finish chunk, or on the trailing
  // usage chunk with include_usage), so streamChatChunks can account for it.
  const chatStream = responsesStreamToChatStream(response, payload.model, {
    includeUsage: payload.stream_options?.include_usage === true,
  });
  return streamChatChunks(c, chatStream, startTime, record);
}

/**
 * Relay chat-completion SSE data to the client, tracking TTFT and usage.
 * A failure mid-stream is reported as an OpenAI-style `{"error": …}` chunk
 * (without `[DONE]`) instead of silently closing the connection.
 */
function streamChatChunks(
  c: Context,
  source: AsyncIterable<{ data: string }>,
  startTime: number,
  record: (usage: ChatCompletionUsage | null | undefined, stream: boolean, ttfb: number) => void
) {
  return streamSSE(c, async (stream) => {
    let lastUsage: ChatCompletionUsage | null | undefined;
    let ttfb = 0;
    try {
      for await (const chunk of source) {
        if (chunk.data !== "[DONE]") {
          try {
            const parsed = JSON.parse(chunk.data) as ChatCompletionChunk;
            if (!ttfb && hasChatOutput(parsed)) ttfb = Date.now() - startTime;
            if (parsed.usage) lastUsage = parsed.usage;
          } catch { /* not a chunk we track */ }
        }
        await stream.writeSSE({ data: chunk.data });
      }
    } catch (error) {
      logger.error("Chat completions stream failed:", error);
      await stream.writeSSE({
        data: JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: "upstream_error",
            code: null,
          },
        }),
      });
    } finally {
      record(lastUsage, true, ttfb);
    }
  });
}

function logChatUsage(
  ip: string,
  model: string,
  usage: ChatCompletionUsage | null | undefined,
  stream: boolean,
  durationMs: number,
  ttfbMs: number
) {
  logUsage({
    ip,
    model,
    endpoint: "openai",
    prompt_tokens: usage?.prompt_tokens ?? 0,
    completion_tokens: usage?.completion_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0,
    cached_prompt_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    cache_write_prompt_tokens: usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
    stream,
    duration_ms: durationMs,
    ttfb_ms: ttfbMs,
  });
}

async function handleDeepseekChatCompletion(
  c: Context,
  payload: ChatCompletionsPayload,
  startTime: number
) {
  const response = await createDeepseekCompletion(
    "/v1/chat/completions",
    payload as unknown as Record<string, unknown>
  );

  logUsage({
    ip: getClientIp(c),
    model: payload.model,
    endpoint: "deepseek-chat-completions",
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    stream: Boolean(payload.stream),
    duration_ms: Date.now() - startTime,
    ttfb_ms: 0,
  });

  return response;
}

function isNonStreaming(
  response: ChatCompletionResponse | AsyncIterable<{ data: string }>
): response is ChatCompletionResponse {
  return Object.hasOwn(response as object, "choices");
}

function isResponsesResult(
  response: ResponsesResult | AsyncIterable<{ event: string; data: string }>
): response is ResponsesResult {
  return Object.hasOwn(response as object, "output");
}
