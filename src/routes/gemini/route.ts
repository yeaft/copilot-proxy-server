import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { forwardError } from "../../lib/error.js";
import { logger } from "../../lib/logger.js";
import { state } from "../../lib/state.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { extractClientHeaders } from "../../lib/headers.js";
import { logUsage } from "../../lib/db.js";
import { getClientIp } from "../../lib/ip.js";
import { createChatCompletions } from "../../services/copilot-completions.js";
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "../../types/openai.js";
import type { GeminiGenerateContentRequest } from "./gemini-types.js";
import {
  translateGeminiToOpenAI,
  translateOpenAIToGemini,
  translateOpenAIChunkToGemini,
} from "./gemini-translation.js";

export const geminiRoutes = new Hono();

// POST /v1beta/models/{model}:generateContent
geminiRoutes.post(
  "/v1beta/models/:modelWithMethod{.+\\:generateContent}",
  async (c) => {
    try {
      await checkRateLimit(state);
      const startTime = Date.now();

      const { modelWithMethod } = c.req.param();
      const modelId = modelWithMethod.split(":")[0];
      const requestBody =
        await c.req.json<GeminiGenerateContentRequest>();

      logger.debug(
        `generateContent for model ${modelId}:`,
        JSON.stringify(requestBody)
      );

      const openAIPayload = translateGeminiToOpenAI(modelId, requestBody);
      openAIPayload.stream = false;

      const clientHeaders = extractClientHeaders(c);
      const response = await createChatCompletions(openAIPayload, clientHeaders);

      if (!isNonStreaming(response)) {
        return c.json(
          { error: { code: 500, message: "Unexpected streaming response", status: "INTERNAL_ERROR" } },
          500
        );
      }

      const geminiResponse = translateOpenAIToGemini(response, modelId);
      logger.debug("generateContent response:", JSON.stringify(geminiResponse));

      logUsage({
        ip: getClientIp(c),
        model: modelId,
        endpoint: "gemini",
        prompt_tokens: response.usage?.prompt_tokens ?? 0,
        completion_tokens: response.usage?.completion_tokens ?? 0,
        total_tokens: response.usage?.total_tokens ?? 0,
        stream: false,
        duration_ms: Date.now() - startTime,
        ttfb_ms: Date.now() - startTime,
      });

      return c.json(geminiResponse, 200);
    } catch (error) {
      logger.error("Gemini generateContent failed:", error);
      return await forwardError(c, error);
    }
  }
);

// POST /v1beta/models/{model}:streamGenerateContent
geminiRoutes.post(
  "/v1beta/models/:modelWithMethod{.+\\:streamGenerateContent}",
  async (c) => {
    try {
      await checkRateLimit(state);
      const startTime = Date.now();

      const { modelWithMethod } = c.req.param();
      const modelId = modelWithMethod.split(":")[0];
      const requestBody =
        await c.req.json<GeminiGenerateContentRequest>();

      logger.debug(
        `streamGenerateContent for model ${modelId}:`,
        JSON.stringify(requestBody)
      );

      const openAIPayload = translateGeminiToOpenAI(modelId, requestBody);
      openAIPayload.stream = true;

      const clientHeaders = extractClientHeaders(c);
      const response = await createChatCompletions(openAIPayload, clientHeaders);
      const ip = getClientIp(c);

      if (isNonStreaming(response)) {
        // Fallback: return as non-streaming
        const geminiResponse = translateOpenAIToGemini(
          response,
          modelId
        );
        logUsage({
          ip,
          model: modelId,
          endpoint: "gemini",
          prompt_tokens: response.usage?.prompt_tokens ?? 0,
          completion_tokens: response.usage?.completion_tokens ?? 0,
          total_tokens: response.usage?.total_tokens ?? 0,
          stream: false,
          duration_ms: Date.now() - startTime,
          ttfb_ms: Date.now() - startTime,
        });
        return c.json(geminiResponse, 200);
      }

      return streamSSE(c, async (stream) => {
        let lastUsage: ChatCompletionChunk["usage"] | undefined;
        let ttfb = 0;
        for await (const rawEvent of response) {
          if (!rawEvent.data) continue;
          if (!ttfb) ttfb = Date.now() - startTime;

          const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk;
          if (chunk.usage) lastUsage = chunk.usage;
          const geminiChunk = translateOpenAIChunkToGemini(chunk, modelId);

          await stream.writeSSE({
            data: JSON.stringify(geminiChunk),
          });
        }
        logUsage({
          ip,
          model: modelId,
          endpoint: "gemini",
          prompt_tokens: lastUsage?.prompt_tokens ?? 0,
          completion_tokens: lastUsage?.completion_tokens ?? 0,
          total_tokens: lastUsage?.total_tokens ?? 0,
          stream: true,
          duration_ms: Date.now() - startTime,
          ttfb_ms: ttfb,
        });
      });
    } catch (error) {
      logger.error("Gemini streamGenerateContent failed:", error);
      return await forwardError(c, error);
    }
  }
);

// POST /v1beta/models/{model}:countTokens
geminiRoutes.post(
  "/v1beta/models/:modelWithMethod{.+\\:countTokens}",
  async (c) => {
    try {
      const { modelWithMethod } = c.req.param();
      const modelId = modelWithMethod.split(":")[0];
      const requestBody =
        await c.req.json<GeminiGenerateContentRequest>();

      const openAIPayload = translateGeminiToOpenAI(modelId, requestBody);

      // Simple token estimation
      const jsonStr = JSON.stringify(openAIPayload.messages);
      const estimatedTokens = Math.ceil(jsonStr.length / 4);

      return c.json({ totalTokens: estimatedTokens }, 200);
    } catch (error) {
      logger.error("Gemini countTokens failed:", error);
      return await forwardError(c, error);
    }
  }
);

function isNonStreaming(
  response: ChatCompletionResponse | AsyncIterable<{ data: string }>
): response is ChatCompletionResponse {
  return Object.hasOwn(response as object, "choices");
}
