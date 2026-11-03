import { logUsage } from "./db.js";
import { hasResponsesOutput } from "./latency.js";

interface LokiUsageContext {
  model: string;
  endpoint: string;
  ip: string;
  startTime: number;
  stream: boolean;
}

type JsonObject = Record<string, unknown>;

// Limits apply only to the observational copy, never to the forwarded body.
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_SSE_FRAME_CHARS = 256 * 1024;
const DECODE_SLICE_BYTES = 4096;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function tokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function nonempty(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

/** Same output semantics as latency.ts, with validation for untrusted native chunks. */
function hasNativeOutput(value: JsonObject, event: string): boolean {
  if (hasResponsesOutput(event, value.delta)) return true;
  if (Array.isArray(value.choices) && value.choices.some((choice) => {
    const delta = object(object(choice)?.delta);
    if (!delta) return false;
    if (nonempty(delta.content)) return true;
    return Array.isArray(delta.tool_calls) && delta.tool_calls.some((call) => {
      const tool = object(call);
      const fn = object(tool?.function);
      return nonempty(tool?.id) || nonempty(fn?.name) || nonempty(fn?.arguments);
    });
  })) return true;

  if (event === "content_block_delta") {
    const delta = object(value.delta);
    return nonempty(delta?.text) || nonempty(delta?.thinking) || nonempty(delta?.partial_json);
  }
  if (event === "content_block_start") {
    const block = object(value.content_block);
    return nonempty(block?.text) || nonempty(block?.thinking) ||
      (block?.type === "tool_use" && (nonempty(block.id) || nonempty(block.name)));
  }
  return false;
}

/** A bounded SSE observer. An oversized frame is skipped, then parsing resumes. */
function sseObserver(visit: (data: string, event: string) => void) {
  const decoder = new TextDecoder();
  let line = "";
  let lineNonempty = false;
  let data = "";
  let event = "";
  let frameChars = 0;
  let oversized = false;
  let skipLf = false;

  function endLine() {
    if (!lineNonempty) {
      if (!oversized && data) visit(data.slice(0, -1), event);
      data = "";
      event = "";
      frameChars = 0;
      oversized = false;
    } else if (!oversized) {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data += `${value}\n`;
      if (field === "event") event = value;
    }
    line = "";
    lineNonempty = false;
  }

  function feed(text: string) {
    for (const char of text) {
      if (skipLf && char === "\n") { skipLf = false; continue; }
      skipLf = char === "\r";
      if (++frameChars > MAX_SSE_FRAME_CHARS) {
        oversized = true;
        line = "";
        data = "";
        event = "";
      }
      if (char === "\r" || char === "\n") endLine();
      else {
        lineNonempty = true;
        if (!oversized) line += char;
      }
    }
  }

  return {
    push(chunk: Uint8Array) {
      // Do not decode an arbitrarily large upstream chunk into a second huge string.
      for (let offset = 0; offset < chunk.byteLength; offset += DECODE_SLICE_BYTES) {
        feed(decoder.decode(chunk.subarray(offset, offset + DECODE_SLICE_BYTES), { stream: true }));
      }
    },
    end() {
      feed(decoder.decode());
      if (lineNonempty) endLine();
      if (!oversized && data) visit(data.slice(0, -1), event);
    },
  };
}

/**
 * Observe native usage without rewriting bytes, headers or status. Reads are driven
 * solely by the downstream consumer (no tee, eager drain, or background buffering).
 * Missing/incomplete usage stays unknown, including on cancellation or body errors.
 */
export function observeLokiUsage(response: Response, context: LokiUsageContext): Response {
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  let cacheWrite = 0;
  let total = 0;
  let known = false;
  let anthropicInput = false;
  let anthropicOutput = false;
  let firstOutput: number | undefined;
  let finished = false;

  function finish() {
    if (finished) return;
    finished = true;
    logUsage({
      ip: context.ip,
      model: context.model,
      endpoint: context.endpoint,
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total,
      cached_prompt_tokens: cached,
      cache_write_prompt_tokens: cacheWrite,
      usage_known: known,
      stream: context.stream,
      duration_ms: Math.max(0, Date.now() - context.startTime),
      ttfb_ms: firstOutput ?? 0,
    });
  }

  let anthropicBaseInput = 0;
  function readAnthropic(usage: JsonObject, input: boolean, output: boolean) {
    const inputTokens = tokens(usage.input_tokens);
    const outputTokens = tokens(usage.output_tokens);
    if (input && inputTokens !== undefined) {
      anthropicBaseInput = inputTokens;
      anthropicInput = true;
    }
    // These are cumulative snapshots, not increments; never add a repeated event twice.
    cached = tokens(usage.cache_read_input_tokens) ?? cached;
    cacheWrite = tokens(usage.cache_creation_input_tokens) ?? cacheWrite;
    if (output && outputTokens !== undefined) {
      completion = outputTokens;
      anthropicOutput = true;
    }
    // Anthropic input_tokens excludes both cache buckets; our prompt column includes them.
    prompt = anthropicBaseInput + cached + cacheWrite;
    total = prompt + completion;
    known = anthropicInput && anthropicOutput;
  }

  function visit(text: string, sseEvent = "", streaming = false) {
    try {
      const value = object(JSON.parse(text));
      if (!value) return;
      const event = typeof value.type === "string" ? value.type : sseEvent;
      if (streaming && context.stream && firstOutput === undefined && hasNativeOutput(value, event)) {
        firstOutput = Math.max(0, Date.now() - context.startTime);
      }
      if (event === "message_start") {
        const usage = object(object(value.message)?.usage);
        if (usage) readAnthropic(usage, true, false);
        return;
      }
      if (event === "message_delta") {
        const usage = object(value.usage);
        if (usage) readAnthropic(usage, true, true);
        return;
      }
      const usage = object(event === "response.completed"
        ? object(value.response)?.usage
        : value.usage);
      if (!usage) return;
      if (event === "message" || "cache_read_input_tokens" in usage || "cache_creation_input_tokens" in usage) {
        readAnthropic(usage, true, true);
        return;
      }
      const input = tokens(usage.prompt_tokens) ?? tokens(usage.input_tokens);
      const output = tokens(usage.completion_tokens) ?? tokens(usage.output_tokens);
      if (input === undefined || output === undefined) return;
      const details = object(usage.prompt_tokens_details) ?? object(usage.input_tokens_details);
      prompt = input;
      completion = output;
      cached = tokens(details?.cached_tokens) ?? 0;
      cacheWrite = tokens(details?.cache_write_tokens) ?? 0;
      total = tokens(usage.total_tokens) ?? prompt + completion;
      known = true;
    } catch { /* Invalid/unsupported payloads must not affect response delivery. */ }
  }

  if (!response.body) {
    finish();
    return response;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const isSse = contentType.includes("text/event-stream") || (context.stream && !contentType);
  // Small non-SSE bodies can be JSON even when the native server omits/mislabels
  // Content-Type. Parsing still happens only after EOF and within the same cap.
  const isJson = !isSse;
  const sse = isSse ? sseObserver((data, event) => visit(data, event, true)) : undefined;
  const decoder = new TextDecoder();
  let json = "";
  let jsonBytes = 0;

  function observe(chunk: Uint8Array) {
    if (sse) sse.push(chunk);
    else if (isJson) {
      jsonBytes += chunk.byteLength;
      if (jsonBytes <= MAX_JSON_BYTES) json += decoder.decode(chunk, { stream: true });
      else json = "";
    }
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); }
  catch {
    finish();
    return response;
  }
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (cancelled) return;
        if (done) {
          if (sse) sse.end();
          else if (isJson && jsonBytes <= MAX_JSON_BYTES) visit(json + decoder.decode());
          json = "";
          finish();
          reader.releaseLock();
          controller.close();
        } else {
          observe(value);
          controller.enqueue(value);
        }
      } catch (error) {
        json = "";
        finish();
        reader.releaseLock();
        if (!cancelled) controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      json = "";
      finish();
      try { await reader.cancel(reason); }
      finally { reader.releaseLock(); }
    },
  }, { highWaterMark: 0 });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
