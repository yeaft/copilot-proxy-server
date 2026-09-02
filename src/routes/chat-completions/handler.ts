import type { Context } from "hono";
import { streamSSE, type SSEMessage } from "hono/streaming";

import { logger } from "../../lib/logger.js";
import { state } from "../../lib/state.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { extractClientHeaders } from "../../lib/headers.js";
import { logUsage } from "../../lib/db.js";
import { getClientIp } from "../../lib/ip.js";
import { hasChatOutput } from "../../lib/latency.js";
import {
  createChatCompletions,
  shouldUseResponsesApi,
  createResponses,
  chatToResponsesPayload,
  responsesToChatResponse,
  responsesStreamToChatStream,
} from "../../services/copilot-completions.js";
import type {
  ChatCompletionsPayload,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from "../../types/openai.js";
import type { ResponsesResult } from "../../types/responses.js";
import {
  createDeepseekCompletion,
  isDeepseekModel,
} from "../../services/deepseek-completions.js";

export async function handleChatCompletion(c: Context) {
  await checkRateLimit(state);
  const startTime = Date.now();

  const payload = await c.req.json<ChatCompletionsPayload>();
  logger.debug("OpenAI request payload:", JSON.stringify(payload).slice(-400));

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
      cached_prompt_tokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      stream: false,
      duration_ms: Date.now() - startTime,
      ttfb_ms: 0,
    });
    return c.json(response);
  }

  logger.debug("Streaming response");
  return streamSSE(c, async (stream) => {
    let lastUsage: ChatCompletionChunk["usage"] | undefined;
    let ttfb = 0;
    for await (const chunk of response) {
      // Track usage and the first user-visible output chunk.
      try {
        const parsed = JSON.parse(chunk.data) as ChatCompletionChunk;
        if (!ttfb && hasChatOutput(parsed)) ttfb = Date.now() - startTime;
        if (parsed.usage) lastUsage = parsed.usage;
      } catch { /* ignore parse errors */ }
      await stream.writeSSE(chunk as SSEMessage);
    }
    logUsage({
      ip,
      model: payload.model,
      endpoint: "openai",
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
 * Handle models that support /responses by converting chat/completions
 * requests to/from the Responses API format transparently.
 */
async function handleViaResponsesApi(
  c: Context,
  payload: ChatCompletionsPayload,
  startTime: number
) {
  logger.debug(`Model ${payload.model}: routing chat/completions → /responses`);

  const responsesPayload = chatToResponsesPayload(payload);
  const clientHeaders = extractClientHeaders(c);
  const response = await createResponses(responsesPayload, clientHeaders);
  const ip = getClientIp(c);

  // Non-streaming
  if (isResponsesResult(response)) {
    const chatResponse = responsesToChatResponse(response, payload.model);
    logUsage({
      ip,
      model: payload.model,
      endpoint: "openai",
      prompt_tokens: response.usage?.input_tokens ?? 0,
      completion_tokens: response.usage?.output_tokens ?? 0,
      total_tokens: response.usage?.total_tokens ?? 0,
      cached_prompt_tokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      stream: false,
      duration_ms: Date.now() - startTime,
      ttfb_ms: 0,
    });
    return c.json(chatResponse);
  }

  // Streaming: convert responses stream → chat completions chunks
  const chatStream = responsesStreamToChatStream(response, payload.model);

  return streamSSE(c, async (stream) => {
    let lastUsage: ChatCompletionChunk["usage"] | undefined;
    let ttfb = 0;

    for await (const chunk of chatStream) {
      try {
        const parsed = JSON.parse(chunk.data) as ChatCompletionChunk;
        if (!ttfb && hasChatOutput(parsed)) ttfb = Date.now() - startTime;
        if (parsed.usage) lastUsage = parsed.usage;
      } catch { /* ignore */ }
      await stream.writeSSE({ data: chunk.data });
    }

    logUsage({
      ip,
      model: payload.model,
      endpoint: "openai",
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
