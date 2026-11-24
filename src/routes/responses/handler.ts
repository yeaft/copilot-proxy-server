import type { Context } from "hono";

import { logger } from "../../lib/logger.js";
import { state } from "../../lib/state.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { extractClientHeaders } from "../../lib/headers.js";
import {
  parseEventData,
  responsesUsage,
  streamObserved,
  type RequestObservation,
} from "../../lib/request-observation.js";
import { createResponses } from "../../services/copilot-completions.js";
import type {
  ResponsesPayload,
  ResponsesResult,
} from "../../types/responses.js";
import {
  createDeepseekCompletion,
  isDeepseekModel,
} from "../../services/deepseek-completions.js";

export async function handleResponses(c: Context, observation: RequestObservation) {
  await checkRateLimit(state);

  const payload = await c.req.json<ResponsesPayload>();
  observation.request(payload.model, payload.stream === true);
  logger.debug("Responses API request:", () => JSON.stringify(payload).slice(-400));

  if (isDeepseekModel(payload.model)) {
    // Set first so failures to reach DeepSeek are attributed to it too.
    observation.endpoint = "deepseek-responses";
    const response = await createDeepseekCompletion(
      "/v1/responses",
      payload as unknown as Record<string, unknown>
    );

    // The body is relayed untouched, so usage is unknown and timing ends at the upstream headers.
    observation.finish(response.ok ? "ok" : "http_error", response.status);
    return response;
  }

  const clientHeaders = extractClientHeaders(c);
  const response = await createResponses(payload, clientHeaders);

  // Non-streaming: response is a ResponsesResult object
  if (isNonStreamingResult(response)) {
    logger.debug("Non-streaming responses result");
    if (response.usage) observation.reportUsage(responsesUsage(response.usage));
    return c.json(response);
  }

  // Streaming: forward SSE events directly
  logger.debug("Streaming responses result");
  return streamObserved(c, observation, async (stream) => {
    for await (const sse of response) {
      // Track the first output delta, usage from the terminal event, and how the stream ended.
      observation.responsesEvent(sse.event, parseEventData(sse.data));

      await stream.writeSSE({
        event: sse.event,
        data: sse.data,
      });
    }
  });
}

function isNonStreamingResult(
  response: ResponsesResult | AsyncIterable<{ event: string; data: string }>
): response is ResponsesResult {
  return Object.hasOwn(response as object, "output");
}
