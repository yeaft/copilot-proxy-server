import type { Context } from "hono";

import { logger } from "../../lib/logger.js";
import { state } from "../../lib/state.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { extractClientHeaders } from "../../lib/headers.js";
import {
  chatUsage,
  parseEventData,
  streamObserved,
  type RequestObservation,
} from "../../lib/request-observation.js";
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
} from "../../types/openai.js";
import type { ResponsesPayload, ResponsesResult } from "../../types/responses.js";
import {
  createDeepseekCompletion,
  isDeepseekModel,
} from "../../services/deepseek-completions.js";

export async function handleChatCompletion(c: Context, observation: RequestObservation) {
  await checkRateLimit(state);

  const payload = await c.req.json<ChatCompletionsPayload>();
  observation.request(payload.model, payload.stream === true);
  logger.debug("OpenAI request payload:", () => JSON.stringify(payload).slice(-400));

  if (isDeepseekModel(payload.model)) {
    return handleDeepseekChatCompletion(payload, observation);
  }

  // Models that support /responses — route through it for better capabilities
  // (reasoning tokens, etc.). Codex models require it; gpt-5.x also prefers it.
  if (shouldUseResponsesApi(payload.model)) {
    return handleViaResponsesApi(c, payload, observation);
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

  if (isNonStreaming(response)) {
    logger.debug("Non-streaming response");
    if (response.usage) observation.reportUsage(chatUsage(response.usage));
    return c.json(response);
  }

  logger.debug("Streaming response");
  return streamChatChunks(c, response, observation);
}

/**
 * Handle models that support /responses by converting chat/completions
 * requests to/from the Responses API format transparently.
 */
async function handleViaResponsesApi(
  c: Context,
  payload: ChatCompletionsPayload,
  observation: RequestObservation
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

  if (isResponsesResult(response)) {
    const chatResponse = responsesToChatResponse(response, payload.model);
    if (chatResponse.usage) observation.reportUsage(chatUsage(chatResponse.usage));
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
  return streamChatChunks(c, chatStream, observation);
}

/**
 * Relay chat-completion SSE data to the client while observing TTFT, usage and how it ended.
 * A failure mid-stream is reported as an OpenAI-style `{"error": …}` chunk
 * (without `[DONE]`) instead of silently closing the connection.
 */
function streamChatChunks(
  c: Context,
  source: AsyncIterable<{ data: string }>,
  observation: RequestObservation
) {
  return streamObserved(c, observation, async (stream) => {
    try {
      for await (const chunk of source) {
        if (chunk.data === "[DONE]") observation.done();
        else observation.chatChunk(parseEventData(chunk.data));
        await stream.writeSSE({ data: chunk.data });
      }
    } catch (error) {
      observation.streamReadFailed();
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
    }
  });
}

async function handleDeepseekChatCompletion(
  payload: ChatCompletionsPayload,
  observation: RequestObservation
) {
  // Set first so failures to reach DeepSeek are attributed to it too.
  observation.endpoint = "deepseek-chat-completions";
  const response = await createDeepseekCompletion(
    "/v1/chat/completions",
    payload as unknown as Record<string, unknown>
  );

  // The body is relayed untouched, so usage is unknown and timing ends at the upstream headers.
  observation.finish(response.ok ? "ok" : "http_error", response.status);
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
