import type { Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";

import { logUsage, type RequestOutcome, type TokenUsage } from "./db.js";
import { forwardError, HTTPError, UpstreamHeadersTimeoutError } from "./error.js";
import { getClientIp } from "./ip.js";
import { hasChatOutput, hasResponsesOutput } from "./latency.js";
import { isUpstreamBodyTimeoutError } from "./upstream-fetch.js";
import type { ChatCompletionChunk, ChatCompletionUsage } from "../types/openai.js";
import type { ResponsesUsage, ResponseStreamEvent } from "../types/responses.js";

/** Model recorded when a request fails before its body names one (llm-proxy's convention). */
const UNRESOLVED_MODEL = "(unresolved)";
/** nginx's status for a client that closed the connection before the response completed. */
const CLIENT_CLOSED_STATUS = 499;

export function chatUsage(usage: ChatCompletionUsage): TokenUsage {
  return {
    input: usage.prompt_tokens ?? 0,
    output: usage.completion_tokens ?? 0,
    cacheRead: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWrite: usage.prompt_tokens_details?.cache_write_tokens ?? 0,
    reasoning: usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? 0,
  };
}

export function responsesUsage(usage: ResponsesUsage): TokenUsage {
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.input_tokens_details?.cached_tokens ?? 0,
    cacheWrite: usage.input_tokens_details?.cache_write_tokens ?? 0,
    reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

/** Parse an SSE data payload, or undefined when it is not JSON. */
export function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/**
 * Analytics for one proxied model request. Writes exactly one usage row: when the
 * handler returns, or, for streamed responses (which outlive the handler), when the
 * stream ends.
 */
export class RequestObservation {
  readonly startedAt = Date.now();
  /** Recorded endpoint label; DeepSeek passthrough requests relabel themselves. */
  endpoint: string;
  private model = UNRESOLVED_MODEL;
  private parsed = false;
  private stream = false;
  private streaming = false;
  private usage: TokenUsage | null = null;
  private firstTokenMs: number | null = null;
  private terminal = false;
  private failed = false;
  private readFailed = false;
  private readTimedOut = false;
  private closedAt: number | null = null;
  private recorded = false;

  constructor(private readonly ip: string, endpoint: string) {
    this.endpoint = endpoint;
  }

  /** Record the model before the body is parsed (Gemini names it in the URL). */
  identify(model: unknown): void {
    if (typeof model === "string" && model) this.model = model;
  }

  /** Call once the request body is parsed; failures before this count as rejected requests. */
  request(model: unknown, stream: boolean): void {
    this.identify(model);
    this.stream = stream;
    this.parsed = true;
  }

  get requestParsed(): boolean {
    return this.parsed;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  reportUsage(usage: TokenUsage | null | undefined): void {
    if (usage) this.usage = usage;
  }

  /** Observe one upstream Chat Completions chunk (already parsed). */
  chatChunk(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const chunk = value as Partial<ChatCompletionChunk> & { error?: unknown };
    if (chunk.error) {
      this.failed = true;
      return;
    }
    if (chunk.usage) this.usage = chatUsage(chunk.usage);
    if (!Array.isArray(chunk.choices)) return;
    if (hasChatOutput(chunk as ChatCompletionChunk)) this.firstToken();
    if (chunk.choices.some((choice) => choice?.finish_reason)) this.terminal = true;
  }

  private firstToken(): void {
    // The usage table stores 0 for "not observed", so a measured time is at least 1 ms.
    this.firstTokenMs ??= Math.max(1, Date.now() - this.startedAt);
  }

  /** The Chat Completions `[DONE]` sentinel. */
  done(): void {
    this.terminal = true;
  }

  /** Observe one upstream Responses API event (data already parsed). */
  responsesEvent(event: string, value: unknown): void {
    const data = (value && typeof value === "object" ? value : {}) as Partial<ResponseStreamEvent>;
    const type = event || (typeof data.type === "string" ? data.type : "");
    if (hasResponsesOutput(type, data.delta)) this.firstToken();
    if (data.response?.usage) this.usage = responsesUsage(data.response.usage);
    // Same terminal and failure events as llm-proxy: an incomplete response was cut short.
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      this.terminal = true;
    }
    if (type === "error" || type === "response.failed" || type === "response.incomplete") {
      this.failed = true;
    }
  }

  /** Reading the upstream stream failed; the relay reported it to the client itself. */
  streamReadFailed(timedOut = false): void {
    this.readFailed = true;
    if (timedOut) this.readTimedOut = true;
  }

  /** The client disconnected. A response that already reached its terminal event still completed. */
  clientClosed(): void {
    if (!this.terminal && this.closedAt === null) this.closedAt = Date.now();
  }

  /** The response body is a stream recorded by `endStream`, not when the handler returns. */
  beginStream(): void {
    this.streaming = true;
    this.stream = true;
  }

  endStream(threw: boolean): void {
    const outcome: RequestOutcome =
      this.closedAt !== null ? "cancelled"
      : this.readTimedOut ? "timeout"
      : threw || this.readFailed ? "upstream_error"
      : this.failed ? "stream_error"
      : this.terminal ? "ok"
      : "incomplete";
    this.write(outcome, outcome === "cancelled" ? CLIENT_CLOSED_STATUS : 200, this.closedAt ?? Date.now());
  }

  finish(outcome: RequestOutcome, status: number): void {
    this.write(outcome, status, Date.now());
  }

  private write(outcome: RequestOutcome, status: number, endedAt: number): void {
    if (this.recorded) return;
    this.recorded = true;
    logUsage({
      ip: this.ip,
      model: this.model,
      endpoint: this.endpoint,
      status,
      outcome,
      stream: this.stream,
      duration_ms: endedAt - this.startedAt,
      first_token_ms: this.stream ? this.firstTokenMs : null,
      usage: this.usage,
    });
  }
}

function outcomeForStatus(status: number): RequestOutcome {
  if (status < 400) return "ok";
  return status < 500 ? "rejected" : "upstream_error";
}

function outcomeForError(error: unknown, requestParsed: boolean): RequestOutcome {
  if (error instanceof UpstreamHeadersTimeoutError) return "timeout";
  if (error instanceof HTTPError) return "http_error";
  return requestParsed ? "upstream_error" : "rejected";
}

/**
 * Run a model endpoint handler and record its outcome. Errors become the same
 * client responses as before (`forwardError`); streamed responses record themselves.
 */
export async function observeModelRequest(
  c: Context,
  endpoint: string,
  handle: (observation: RequestObservation) => Promise<Response>
): Promise<Response> {
  const observation = new RequestObservation(getClientIp(c), endpoint);
  try {
    const response = await handle(observation);
    if (!observation.isStreaming) observation.finish(outcomeForStatus(response.status), response.status);
    return response;
  } catch (error) {
    if (c.req.raw.signal?.aborted === true) {
      observation.finish("cancelled", CLIENT_CLOSED_STATUS);
      return c.body(null, CLIENT_CLOSED_STATUS as never);
    }
    const response = await forwardError(c, error);
    observation.finish(outcomeForError(error, observation.requestParsed), response.status);
    return response;
  }
}

/**
 * `streamSSE` that records the observation when the relay ends. Relay errors keep
 * propagating to Hono exactly as before (except client disconnects, which already
 * terminated the response stream and should not log spurious upstream errors).
 */
export function streamObserved(
  c: Context,
  observation: RequestObservation,
  relay: (stream: SSEStreamingApi) => Promise<void>
): Response {
  observation.beginStream();
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => observation.clientClosed());
    let threw = false;
    try {
      await relay(stream);
    } catch (error) {
      if (c.req.raw.signal?.aborted) {
        observation.clientClosed();
        return;
      }
      if (isUpstreamBodyTimeoutError(error)) {
        observation.streamReadFailed(true);
      }
      threw = true;
      throw error;
    } finally {
      observation.endStream(threw);
    }
  });
}
