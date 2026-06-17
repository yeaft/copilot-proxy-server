import { EventSourceParserStream } from "eventsource-parser/stream";

import { HTTPError } from "../lib/error.js";
import { logger } from "../lib/logger.js";
import { state } from "../lib/state.js";

const DEEPSEEK_DEFAULT_HOST = "https://api.deepseek.com";
const ANTHROPIC_VERSION = "2023-06-01";

function getDeepseekHost(): string {
  return process.env.DEEPSEEK_HOST || DEEPSEEK_DEFAULT_HOST;
}

/**
 * Forward an Anthropic-formatted Messages API request to DeepSeek.
 * DeepSeek's endpoint is Anthropic-compatible so no translation is needed.
 * Supports both streaming and non-streaming responses.
 */
export async function createDeepseekMessages(
  payload: Record<string, unknown>
): Promise<Response | AsyncIterable<{ data: string }>> {
  if (!state.deepseekApiKey) {
    throw new Error("DeepSeek API key not configured");
  }

  const host = getDeepseekHost();
  const url = `${host}/v1/messages`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": state.deepseekApiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };

  logger.debug(`DeepSeek request → ${url} model=${payload.model}`);

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    logger.error("DeepSeek API error:", response.status);
    let errorBody = "";
    try {
      errorBody = await response.text();
      logger.error("DeepSeek error body:", errorBody.slice(0, 500));
    } catch {
      // ignore
    }
    throw new HTTPError(
      `DeepSeek API error: ${response.status}`,
      response
    );
  }

  if (payload.stream) {
    return parseSSEStream(response);
  }

  return response;
}

async function* parseSSEStream(
  response: Response
): AsyncIterable<{ data: string }> {
  if (!response.body) {
    throw new Error("Response body is null");
  }

  const parser = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream());

  const reader = parser.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value.data === "[DONE]") {
        break;
      }

      yield { data: value.data };
    }
  } finally {
    reader.releaseLock();
  }
}
