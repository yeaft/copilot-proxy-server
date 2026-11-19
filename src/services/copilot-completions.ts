import { EventSourceParserStream } from "eventsource-parser/stream";

import { copilotBaseUrl, copilotHeaders } from "../auth/api-config.js";
import { HTTPError } from "../lib/error.js";
import { logger } from "../lib/logger.js";
import { state } from "../lib/state.js";
import type {
  ChatCompletionsPayload,
  ChatCompletionResponse,
  Message,
} from "../types/openai.js";
import type {
  ResponsesPayload,
  ResponsesResult,
} from "../types/responses.js";

// Headers that should NOT be forwarded from client to upstream
const BLOCKED_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "authorization",
  "x-api-key",
  "x-goog-api-key",
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

/** Whether any message carries an image, which Copilot gates behind a vision header. */
export function hasImageInput(messages: Array<Message>): boolean {
  return messages.some(
    (x) => Array.isArray(x.content) && x.content.some((part) => part.type === "image_url")
  );
}

/** Copilot's X-Initiator: conversations with assistant/tool turns count as agent calls. */
export function initiatorFor(messages: Array<Message>): "agent" | "user" {
  return messages.some((msg) => msg.role === "assistant" || msg.role === "tool")
    ? "agent"
    : "user";
}

export interface ChatCompletionsOptions {
  /** Yield the upstream `[DONE]` sentinel instead of swallowing it. */
  forwardDone?: boolean;
}

export async function createChatCompletions(
  payload: ChatCompletionsPayload,
  clientHeaders?: Record<string, string>,
  options: ChatCompletionsOptions = {}
): Promise<ChatCompletionResponse | AsyncIterable<{ data: string }>> {
  if (!state.copilotToken) {
    throw new Error("Copilot token not found");
  }

  // Merge headers: client headers first, then copilot headers override auth/identity
  const headers: Record<string, string> = {
    ...filterClientHeaders(clientHeaders),
    ...copilotHeaders(state, hasImageInput(payload.messages)),
    "X-Initiator": initiatorFor(payload.messages),
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
    return parseSSEStream(response, options.forwardDone ?? false);
  }

  return (await response.json()) as ChatCompletionResponse;
}

async function* parseSSEStream(
  response: Response,
  forwardDone: boolean
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
        if (forwardDone) yield { data: value.data };
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

// ---------------------------------------------------------------------------
// Codex / Responses API support
// ---------------------------------------------------------------------------

/**
 * Determine whether a model should route through the /responses endpoint.
 * Prefers /responses whenever the upstream model advertises support for it
 * (even when /chat/completions is also available).
 * Falls back to a name-based heuristic (codex models) when model metadata
 * isn't cached yet.
 */
export function shouldUseResponsesApi(model: string): boolean {
  const m = state.models?.data.find((x) => x.id === model);
  if (m?.supported_endpoints && m.supported_endpoints.length > 0) {
    return m.supported_endpoints.includes("/responses");
  }
  // Fallback heuristic when model metadata is unavailable
  return model.includes("-codex");
}

/**
 * Whether a model accepts `reasoning` settings. Every /responses chat model
 * Copilot lists today advertises `reasoning_effort`; unknown models are assumed
 * to, matching the name-based routing fallback above.
 */
export function modelSupportsReasoning(model: string): boolean {
  const m = state.models?.data.find((x) => x.id === model);
  if (!m) return true;
  return (m.capabilities.supports.reasoning_effort?.length ?? 0) > 0;
}

export interface ResponsesRequestOptions {
  /** Send Copilot's vision header (required when the input contains images). */
  vision?: boolean;
  /** Copilot X-Initiator header; defaults to "user". */
  initiator?: "agent" | "user";
}

/**
 * Send a request to the upstream /responses endpoint.
 * Returns either a parsed ResponsesResult (non-streaming) or an async iterable
 * of raw SSE events with { event, data } for streaming.
 */
export async function createResponses(
  payload: ResponsesPayload,
  clientHeaders?: Record<string, string>,
  options: ResponsesRequestOptions = {}
): Promise<ResponsesResult | AsyncIterable<{ event: string; data: string }>> {
  if (!state.copilotToken) {
    throw new Error("Copilot token not found");
  }

  const headers: Record<string, string> = {
    ...filterClientHeaders(clientHeaders),
    ...copilotHeaders(state, options.vision ?? false),
    "X-Initiator": options.initiator ?? "user",
  };

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    logger.error("Failed to create responses:", response.status);
    throw new HTTPError("Failed to create responses", response);
  }

  if (payload.stream) {
    return parseSSEStreamWithEvent(response);
  }

  return (await response.json()) as ResponsesResult;
}

/** Parse SSE stream preserving event type (needed for Responses API) */
async function* parseSSEStreamWithEvent(
  response: Response
): AsyncIterable<{ event: string; data: string }> {
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

      if (value.data === "[DONE]") break;

      yield { event: value.event || "", data: value.data };
    }
  } finally {
    reader.releaseLock();
  }
}
