import { Hono } from "hono";

import { forwardError } from "../../lib/error.js";
import { logger } from "../../lib/logger.js";
import { state } from "../../lib/state.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { extractClientHeaders } from "../../lib/headers.js";
import {
  chatUsage,
  observeModelRequest,
  streamObserved,
} from "../../lib/request-observation.js";
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

// POST /models/{model}:generateContent (mounted under /v1 and /v1beta)
geminiRoutes.post(
  "/:modelWithMethod{.+\\:generateContent}",
  (c) => observeModelRequest(c, "gemini", async (observation) => {
    await checkRateLimit(state);

    const { modelWithMethod } = c.req.param();
    const modelId = modelWithMethod.split(":")[0];
    observation.identify(modelId);
    const requestBody =
      await c.req.json<GeminiGenerateContentRequest>();
    observation.request(modelId, false);

    logger.debug(
      `generateContent for model ${modelId}:`,
      () => JSON.stringify(requestBody)
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
    logger.debug("generateContent response:", () => JSON.stringify(geminiResponse));
    if (response.usage) observation.reportUsage(chatUsage(response.usage));

    return c.json(geminiResponse, 200);
  })
);

// POST /models/{model}:streamGenerateContent
geminiRoutes.post(
  "/:modelWithMethod{.+\\:streamGenerateContent}",
  (c) => observeModelRequest(c, "gemini", async (observation) => {
    await checkRateLimit(state);

    const { modelWithMethod } = c.req.param();
    const modelId = modelWithMethod.split(":")[0];
    observation.identify(modelId);
    const requestBody =
      await c.req.json<GeminiGenerateContentRequest>();
    observation.request(modelId, true);

    logger.debug(
      `streamGenerateContent for model ${modelId}:`,
      () => JSON.stringify(requestBody)
    );

    const openAIPayload = translateGeminiToOpenAI(modelId, requestBody);
    openAIPayload.stream = true;

    const clientHeaders = extractClientHeaders(c);
    const response = await createChatCompletions(openAIPayload, clientHeaders);

    if (isNonStreaming(response)) {
      // Fallback: return as non-streaming
      const geminiResponse = translateOpenAIToGemini(
        response,
        modelId
      );
      if (response.usage) observation.reportUsage(chatUsage(response.usage));
      return c.json(geminiResponse, 200);
    }

    return streamObserved(c, observation, async (stream) => {
      for await (const rawEvent of response) {
        if (!rawEvent.data) continue;

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk;
        observation.chatChunk(chunk);
        const geminiChunk = translateOpenAIChunkToGemini(chunk, modelId);

        await stream.writeSSE({
          data: JSON.stringify(geminiChunk),
        });
      }
    });
  })
);

// POST /models/{model}:countTokens
geminiRoutes.post(
  "/:modelWithMethod{.+\\:countTokens}",
  async (c) => {
    try {
      const { modelWithMethod } = c.req.param();
      const modelId = modelWithMethod.split(":")[0];
      const requestBody =
        await c.req.json<GeminiGenerateContentRequest>();

      const openAIPayload = translateGeminiToOpenAI(modelId, requestBody);

      // Keep the existing text estimate, but never serialize image transport for counting.
      // The proxy does not know the upstream model's image tokenization rules.
      let imageCount = 0;
      const messages = openAIPayload.messages.map((message) => {
        if (!Array.isArray(message.content)) return message;
        const content = message.content.filter((part) => {
          if (part.type !== "image_url") return true;
          imageCount++;
          return false;
        });
        return { ...message, content };
      });
      const estimatedTokens = Math.ceil(JSON.stringify(messages).length / 4) + 256 * imageCount;

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
