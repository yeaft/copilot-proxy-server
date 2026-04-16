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
import type {
  ResponsesPayload,
  ResponsesResult,
  ResponseStreamEvent,
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

// ---------------------------------------------------------------------------
// Codex / Responses API support
// ---------------------------------------------------------------------------

/** Models that only support the /responses endpoint (not /chat/completions) */
export function isResponsesOnlyModel(model: string): boolean {
  return model.includes("-codex");
}

/**
 * Send a request to the upstream /responses endpoint.
 * Returns either a parsed ResponsesResult (non-streaming) or an async iterable
 * of raw SSE events with { event, data } for streaming.
 */
export async function createResponses(
  payload: ResponsesPayload,
  clientHeaders?: Record<string, string>
): Promise<ResponsesResult | AsyncIterable<{ event: string; data: string }>> {
  if (!state.copilotToken) {
    throw new Error("Copilot token not found");
  }

  const headers: Record<string, string> = {
    ...filterClientHeaders(clientHeaders),
    ...copilotHeaders(state),
    "X-Initiator": "user",
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

// ---------------------------------------------------------------------------
// Chat Completions ↔ Responses API translation
// ---------------------------------------------------------------------------

/** Convert a ChatCompletionsPayload into a ResponsesPayload */
export function chatToResponsesPayload(
  payload: ChatCompletionsPayload
): ResponsesPayload {
  // Build input from messages — Responses API accepts message array
  const input = payload.messages.map((msg) => {
    const role = msg.role === "tool" ? "user" as const : msg.role as "user" | "assistant" | "system" | "developer";
    const content =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
          ? msg.content
              .filter((p): p is { type: "text"; text: string } => p.type === "text")
              .map((p) => p.text)
              .join("")
          : "";
    return { role, content };
  });

  // Extract system message as instructions if first message is system
  let instructions: string | undefined;
  const inputMessages = [...input];
  if (inputMessages.length > 0 && inputMessages[0].role === "system") {
    instructions = inputMessages[0].content as string;
    inputMessages.shift();
  }

  const responsesPayload: ResponsesPayload = {
    model: payload.model,
    input: inputMessages,
    stream: payload.stream ?? undefined,
    ...(instructions && { instructions }),
  };

  // Map token limits
  const maxTokens = payload.max_completion_tokens ?? payload.max_tokens;
  if (maxTokens != null) {
    responsesPayload.max_output_tokens = maxTokens;
  }

  // Pass through common parameters
  if (payload.temperature != null) responsesPayload.temperature = payload.temperature;
  if (payload.top_p != null) responsesPayload.top_p = payload.top_p;

  // Convert tools
  if (payload.tools?.length) {
    responsesPayload.tools = payload.tools.map((t) => ({
      type: "function" as const,
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  }

  // Convert tool_choice
  if (payload.tool_choice != null) {
    if (typeof payload.tool_choice === "string") {
      responsesPayload.tool_choice = payload.tool_choice as "none" | "auto" | "required";
    }
    // Object form (specific function) is not directly supported, default to auto
  }

  // Response format
  if (payload.response_format?.type === "json_object") {
    responsesPayload.text = { format: { type: "json_object" } };
  }

  return responsesPayload;
}

/** Convert a non-streaming ResponsesResult into ChatCompletionResponse format */
export function responsesToChatResponse(
  result: ResponsesResult,
  model: string
): ChatCompletionResponse {
  // Extract text from output
  const text = result.output
    ?.flatMap((item) => item.content)
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("") ?? "";

  return {
    id: result.id,
    object: "chat.completion",
    created: result.created_at,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
        },
        logprobs: null,
        finish_reason: result.status === "completed" ? "stop" : "length",
      },
    ],
    usage: result.usage
      ? {
          prompt_tokens: result.usage.input_tokens,
          completion_tokens: result.usage.output_tokens,
          total_tokens: result.usage.total_tokens,
        }
      : undefined,
  };
}

/**
 * Convert a streaming Responses API event stream into a chat completions
 * chunk stream (AsyncIterable<{ data: string }>).
 */
export async function* responsesStreamToChatStream(
  stream: AsyncIterable<{ event: string; data: string }>,
  model: string
): AsyncIterable<{ data: string }> {
  let chunkId = "";

  for await (const sse of stream) {
    const parsed = JSON.parse(sse.data) as ResponseStreamEvent;

    if (sse.event === "response.created" || sse.event === "response.in_progress") {
      if (parsed.response?.id) chunkId = parsed.response.id;
      continue;
    }

    if (sse.event === "response.output_text.delta" && parsed.delta != null) {
      const chunk: ChatCompletionChunk = {
        id: chunkId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: { content: parsed.delta },
            finish_reason: null,
            logprobs: null,
          },
        ],
      };
      yield { data: JSON.stringify(chunk) };
    }

    if (sse.event === "response.completed" && parsed.response) {
      // Send final chunk with finish_reason and usage
      const chunk: ChatCompletionChunk = {
        id: chunkId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: parsed.response.usage
          ? {
              prompt_tokens: parsed.response.usage.input_tokens,
              completion_tokens: parsed.response.usage.output_tokens,
              total_tokens: parsed.response.usage.total_tokens,
            }
          : undefined,
      };
      yield { data: JSON.stringify(chunk) };
    }
  }
}
