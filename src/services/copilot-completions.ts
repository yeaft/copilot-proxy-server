import { EventSourceParserStream } from "eventsource-parser/stream";

import { copilotBaseUrl, copilotHeaders } from "../auth/api-config.js";
import { HTTPError } from "../lib/error.js";
import { logger } from "../lib/logger.js";
import { state } from "../lib/state.js";
import type {
  ChatCompletionsPayload,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from "../types/openai.js";

// Headers that should NOT be forwarded from client to upstream
const BLOCKED_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "origin",
  "referer",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
]);

function filterClientHeaders(
  headers?: Record<string, string>
): Record<string, string> {
  if (!headers) return {};
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!BLOCKED_HEADERS.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export async function createChatCompletions(
  payload: ChatCompletionsPayload,
  clientHeaders?: Record<string, string>
): Promise<ChatCompletionResponse | AsyncIterable<{ data: string }>> {
  if (!state.copilotToken) {
    throw new Error("Copilot token not found");
  }

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string" &&
      Array.isArray(x.content) &&
      x.content?.some((part) => part.type === "image_url")
  );

  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role)
  );

  // Merge headers: client headers first, then copilot headers override auth/identity
  const headers: Record<string, string> = {
    ...filterClientHeaders(clientHeaders),
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  };

  const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    logger.error("Failed to create chat completions:", response.status);
    throw new HTTPError("Failed to create chat completions", response);
  }

  if (payload.stream) {
    return parseSSEStream(response);
  }

  return (await response.json()) as ChatCompletionResponse;
}

async function* parseSSEStream(
  response: Response
): AsyncIterable<{ data: string }> {
  if (!response.body) {
    throw new Error("Response body is null");
  }

  const parser = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(
    new EventSourceParserStream()
  );

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

export function isNonStreamingResponse(
  response: ChatCompletionResponse | AsyncIterable<{ data: string }>
): response is ChatCompletionResponse {
  return "choices" in response && !Symbol.asyncIterator;
}
