import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import { logger } from "../../lib/logger.js";
import { state } from "../../lib/state.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { extractClientHeaders } from "../../lib/headers.js";
import { logUsage } from "../../lib/db.js";
import { getClientIp } from "../../lib/ip.js";
import { createResponses } from "../../services/copilot-completions.js";
import type { ResponsesPayload, ResponsesResult } from "../../types/responses.js";
import {
  createDeepseekCompletion,
  isDeepseekModel,
} from "../../services/deepseek-completions.js";

export async function handleResponses(c: Context) {
  await checkRateLimit(state);
  const startTime = Date.now();

  const payload = await c.req.json<ResponsesPayload>();
  logger.debug("Responses API request:", JSON.stringify(payload).slice(-400));

  if (isDeepseekModel(payload.model)) {
    const response = await createDeepseekCompletion(
      "/v1/responses",
      payload as unknown as Record<string, unknown>
    );

    logUsage({
      ip: getClientIp(c),
      model: payload.model,
      endpoint: "deepseek-responses",
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      stream: Boolean(payload.stream),
      duration_ms: Date.now() - startTime,
      ttfb_ms: Date.now() - startTime,
    });

    return response;
  }

  const clientHeaders = extractClientHeaders(c);
  const response = await createResponses(payload, clientHeaders);
  const ip = getClientIp(c);

  // Non-streaming: response is a ResponsesResult object
  if (isNonStreamingResult(response)) {
    logger.debug("Non-streaming responses result");
    logUsage({
      ip,
      model: payload.model,
      endpoint: "responses",
      prompt_tokens: response.usage?.input_tokens ?? 0,
      completion_tokens: response.usage?.output_tokens ?? 0,
      total_tokens: response.usage?.total_tokens ?? 0,
      stream: false,
      duration_ms: Date.now() - startTime,
      ttfb_ms: Date.now() - startTime,
    });
    return c.json(response);
  }

  // Streaming: forward SSE events directly
  logger.debug("Streaming responses result");
  return streamSSE(c, async (stream) => {
    let lastUsage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined;
    let ttfb = 0;

    for await (const sse of response) {
      if (!ttfb) ttfb = Date.now() - startTime;

      await stream.writeSSE({
        event: sse.event,
        data: sse.data,
      });

      // Track usage from response.completed event
      try {
        const parsed = JSON.parse(sse.data);
        if (parsed.response?.usage) {
          lastUsage = parsed.response.usage;
        }
      } catch { /* ignore */ }
    }

    logUsage({
      ip,
      model: payload.model,
      endpoint: "responses",
      prompt_tokens: lastUsage?.input_tokens ?? 0,
      completion_tokens: lastUsage?.output_tokens ?? 0,
      total_tokens: lastUsage?.total_tokens ?? 0,
      stream: true,
      duration_ms: Date.now() - startTime,
      ttfb_ms: ttfb,
    });
  });
}

function isNonStreamingResult(
  response: ResponsesResult | AsyncIterable<{ event: string; data: string }>
): response is ResponsesResult {
  return Object.hasOwn(response as object, "output");
}
