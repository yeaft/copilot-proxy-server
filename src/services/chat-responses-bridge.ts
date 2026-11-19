/**
 * Chat Completions ⇄ Responses API bridge.
 *
 * Copilot serves GPT-5.x/6.x, Codex, Grok and MAI-1.1 only on `/responses`.
 * This module lets `/v1/chat/completions` clients use those models with the
 * Chat Completions contract intact: function and custom tools, tool_choice,
 * structured outputs, image/file input, reasoning controls, logprobs, usage
 * details, and finish reasons for truncated or filtered output.
 *
 * Pure translation only — HTTP lives in copilot-completions.ts.
 */

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ChatCompletionUsage,
  ChoiceLogprobs,
  ContentPart,
  CopilotUsage,
  FinishReason,
  Message,
  MessageToolCall,
  StreamDelta,
  TokenLogprob,
  Tool,
  ToolChoice,
  UrlCitationAnnotation,
} from "../types/openai.js";
import type {
  ResponseContentPart,
  ResponseCustomToolCall,
  ResponseFunctionCall,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponsesPayload,
  ResponsesResult,
  ResponsesUsage,
  ResponseStreamEvent,
  ResponseTool,
  ResponseToolChoice,
  ResponseToolOutputPart,
} from "../types/responses.js";

/** Joins text from separate assistant output messages (e.g. a preamble and the final answer). */
const MESSAGE_SEPARATOR = "\n\n";

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/**
 * A Chat Completions parameter the client explicitly set, whose effect the
 * Responses API cannot deliver. Rejected with 400 rather than silently dropped,
 * so the client never gets a response that quietly ignores what it asked for.
 */
export class UnsupportedChatParameterError extends Error {
  constructor(
    readonly param: string,
    message: string
  ) {
    super(message);
    this.name = "UnsupportedChatParameterError";
  }
}

function assertBridgeable(payload: ChatCompletionsPayload): void {
  const reject = (param: string, what: string): never => {
    throw new UnsupportedChatParameterError(
      param,
      `${what} is not supported for model '${payload.model}', which Copilot serves only through the Responses API.`
    );
  };

  if (payload.n != null && payload.n > 1) reject("n", "'n' greater than 1");
  if (payload.functions != null) reject("functions", "Deprecated 'functions' (use 'tools')");
  if (payload.function_call != null) {
    reject("function_call", "Deprecated 'function_call' (use 'tool_choice')");
  }
  if (payload.audio != null || payload.modalities?.includes("audio")) {
    reject("modalities", "Audio output");
  }
  if (payload.web_search_options != null) reject("web_search_options", "'web_search_options'");
  if (payload.moderation != null) reject("moderation", "'moderation'");

  payload.messages.forEach((message, i) => {
    if (message.role === "function") {
      reject(`messages[${i}].role`, "Deprecated 'function' role messages (use 'tool')");
    }
    if (Array.isArray(message.content)) {
      message.content.forEach((part, j) => {
        if (part.type === "input_audio") reject(`messages[${i}].content[${j}]`, "Audio input");
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Reasoning state round-trip
// ---------------------------------------------------------------------------

/**
 * `reasoning_opaque` is Copilot's Chat Completions extension for carrying a
 * model's reasoning state to the next turn. Responses models need their own
 * encrypted reasoning items back and reject ciphertext they did not issue
 * (a Gemini `reasoning_opaque` gets HTTP 400). The prefix marks state this
 * bridge produced, so foreign values are dropped and clients can switch models
 * mid-conversation.
 */
const REASONING_OPAQUE_PREFIX = "copilot-proxy.responses.v1:";

export function encodeReasoningOpaque(encrypted: Array<string>): string | undefined {
  return encrypted.length > 0
    ? REASONING_OPAQUE_PREFIX + JSON.stringify(encrypted)
    : undefined;
}

export function decodeReasoningOpaque(value: string | null | undefined): Array<string> {
  if (!value?.startsWith(REASONING_OPAQUE_PREFIX)) return [];
  try {
    const parsed: unknown = JSON.parse(value.slice(REASONING_OPAQUE_PREFIX.length));
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

export interface BridgeRequestOptions {
  /** Whether the model accepts `reasoning` settings (from Copilot model metadata). */
  reasoning?: boolean;
}

/** Models that outright reject temperature/top_p (codex family). */
function isCodexModel(model: string): boolean {
  return model.includes("-codex");
}

/**
 * Convert a Chat Completions request into a Responses request.
 * @throws UnsupportedChatParameterError for parameters that cannot be honoured.
 */
export function chatToResponsesPayload(
  payload: ChatCompletionsPayload,
  options: BridgeRequestOptions = {}
): ResponsesPayload {
  assertBridgeable(payload);
  const reasoning = options.reasoning ?? true;

  const out: ResponsesPayload = {
    model: payload.model,
    input: toResponsesInput(payload.messages),
    stream: payload.stream ?? undefined,
    // Chat Completions is stateless and Copilot rejects store=true on /responses.
    store: false,
  };

  const include: Array<string> = [];
  if (reasoning) {
    // Summaries surface as `reasoning_text`; encrypted state as `reasoning_opaque`.
    out.reasoning = {
      summary: "auto",
      ...(payload.reasoning_effort != null && { effort: payload.reasoning_effort }),
    };
    include.push("reasoning.encrypted_content");
  }
  if (payload.logprobs) {
    include.push("message.output_text.logprobs");
    if (payload.top_logprobs != null) out.top_logprobs = payload.top_logprobs;
  }
  if (include.length > 0) out.include = include;

  const maxTokens = payload.max_completion_tokens ?? payload.max_tokens;
  if (maxTokens != null) out.max_output_tokens = maxTokens;

  if (!isCodexModel(payload.model)) {
    if (payload.temperature != null) out.temperature = payload.temperature;
    if (payload.top_p != null) out.top_p = payload.top_p;
  }

  if (payload.tools?.length) out.tools = payload.tools.map(toResponsesTool);
  if (payload.tool_choice != null) out.tool_choice = toResponsesToolChoice(payload.tool_choice);
  if (payload.parallel_tool_calls != null) out.parallel_tool_calls = payload.parallel_tool_calls;

  const format = payload.response_format;
  if (format || payload.verbosity) {
    out.text = {};
    if (format) {
      out.text.format = format.type === "json_schema"
        // As with tools, Responses treats an omitted `strict` as true and then
        // rejects ordinary schemas (optional fields) that Chat Completions accepts.
        ? { type: "json_schema", ...format.json_schema, strict: format.json_schema.strict ?? false }
        : { type: format.type };
    }
    if (payload.verbosity) out.text.verbosity = payload.verbosity;
  }

  if (payload.metadata != null) out.metadata = payload.metadata;
  if (payload.prompt_cache_key != null) out.prompt_cache_key = payload.prompt_cache_key;
  if (payload.prompt_cache_options != null) out.prompt_cache_options = payload.prompt_cache_options;
  if (payload.prompt_cache_retention != null) {
    out.prompt_cache_retention = payload.prompt_cache_retention;
  }
  if (payload.safety_identifier != null) out.safety_identifier = payload.safety_identifier;
  if (payload.user != null) out.user = payload.user;

  // Not forwarded (no Responses equivalent; best-effort hints in Chat
  // Completions): stop, seed, logit_bias, frequency/presence_penalty,
  // prediction, service_tier, store, stream_options.include_obfuscation.
  return out;
}

function toResponsesInput(messages: Array<Message>): Array<ResponseInputItem> {
  const items: Array<ResponseInputItem> = [];
  // Tool results must use the output item type matching their call.
  const customCallIds = new Set<string>();

  for (const message of messages) {
    switch (message.role) {
      case "system":
      case "developer":
      case "user":
        items.push({ type: "message", role: message.role, content: toInputContent(message.content) });
        break;
      case "assistant":
        items.push(...assistantToItems(message, customCallIds));
        break;
      case "tool": {
        const callId = message.tool_call_id ?? "";
        const output = toToolOutput(message.content);
        items.push(
          customCallIds.has(callId)
            ? { type: "custom_tool_call_output", call_id: callId, output }
            : { type: "function_call_output", call_id: callId, output }
        );
        break;
      }
    }
  }
  return items;
}

function assistantToItems(
  message: Message,
  customCallIds: Set<string>
): Array<ResponseInputItem> {
  const items: Array<ResponseInputItem> = [];

  for (const encrypted of decodeReasoningOpaque(message.reasoning_opaque)) {
    items.push({ type: "reasoning", encrypted_content: encrypted, summary: [] });
  }

  const parts: Array<ResponseContentPart> = [];
  if (typeof message.content === "string") {
    if (message.content) parts.push({ type: "output_text", text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "text" && part.text) parts.push({ type: "output_text", text: part.text });
      else if (part.type === "refusal") parts.push({ type: "refusal", refusal: part.refusal });
    }
  }
  if (message.refusal) parts.push({ type: "refusal", refusal: message.refusal });
  if (parts.length > 0) items.push({ type: "message", role: "assistant", content: parts });

  for (const call of message.tool_calls ?? []) {
    if (call.type === "custom") {
      customCallIds.add(call.id);
      items.push({ type: "custom_tool_call", call_id: call.id, name: call.custom.name, input: call.custom.input });
    } else {
      items.push({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
  }
  return items;
}

function toInputContent(
  content: string | Array<ContentPart> | null | undefined
): string | Array<ResponseContentPart> {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content.flatMap((part): Array<ResponseContentPart> => {
    const converted = toInputPart(part);
    return converted ? [converted] : [];
  });
}

function toToolOutput(
  content: string | Array<ContentPart> | null | undefined
): string | Array<ResponseToolOutputPart> {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content.flatMap((part): Array<ResponseToolOutputPart> => {
    const converted = toInputPart(part);
    return converted ? [converted] : [];
  });
}

function toInputPart(part: ContentPart): ResponseToolOutputPart | undefined {
  const breakpoint = "prompt_cache_breakpoint" in part && part.prompt_cache_breakpoint
    ? { prompt_cache_breakpoint: part.prompt_cache_breakpoint }
    : {};
  switch (part.type) {
    case "text":
      return { type: "input_text", text: part.text, ...breakpoint };
    case "image_url":
      return {
        type: "input_image",
        image_url: part.image_url.url,
        detail: part.image_url.detail ?? "auto",
        ...breakpoint,
      };
    case "file":
      return { type: "input_file", ...part.file, ...breakpoint };
    default:
      // refusal parts only belong to assistant messages; input_audio is rejected upfront.
      return undefined;
  }
}

function toResponsesTool(tool: Tool): ResponseTool {
  if (tool.type === "custom") {
    const { name, description, format } = tool.custom;
    return {
      type: "custom",
      name,
      ...(description != null && { description }),
      ...(format && {
        format: format.type === "grammar"
          ? { type: "grammar" as const, syntax: format.grammar.syntax, definition: format.grammar.definition }
          : { type: "text" as const },
      }),
    };
  }
  const fn = tool.function;
  return {
    type: "function",
    name: fn.name,
    ...(fn.description != null && { description: fn.description }),
    parameters: fn.parameters ?? null,
    // Chat Completions defaults to non-strict; Responses defaults to strict,
    // which would silently change optional-parameter semantics.
    strict: fn.strict ?? false,
  };
}

function toResponsesToolChoice(choice: ToolChoice): ResponseToolChoice {
  if (typeof choice === "string") return choice;
  switch (choice.type) {
    case "function":
      return { type: "function", name: choice.function.name };
    case "custom":
      return { type: "custom", name: choice.custom.name };
    case "allowed_tools":
      return {
        type: "allowed_tools",
        mode: choice.allowed_tools.mode,
        tools: choice.allowed_tools.tools.map(toAllowedToolRef),
      };
  }
}

/** Chat nests the name (`{type:"function", function:{name}}`); Responses flattens it. */
function toAllowedToolRef(ref: Record<string, unknown>): Record<string, unknown> {
  const type = ref.type;
  const nested = typeof type === "string" ? ref[type] : undefined;
  if (nested && typeof nested === "object" && "name" in nested) {
    return { type, name: (nested as { name: unknown }).name };
  }
  return ref;
}

// ---------------------------------------------------------------------------
// Response translation (shared)
// ---------------------------------------------------------------------------

export function toChatUsage(usage: ResponsesUsage): ChatCompletionUsage {
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens;
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
    prompt_tokens_details: {
      cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0,
      ...(cacheWrite != null && { cache_write_tokens: cacheWrite }),
    },
    ...(reasoningTokens != null && {
      completion_tokens_details: { reasoning_tokens: reasoningTokens },
    }),
  };
}

function toFinishReason(
  result: Pick<ResponsesResult, "status" | "incomplete_details">,
  hasToolCalls: boolean
): FinishReason {
  if (result.status === "incomplete") {
    return result.incomplete_details?.reason === "content_filter" ? "content_filter" : "length";
  }
  return hasToolCalls ? "tool_calls" : "stop";
}

function toChatToolCall(item: ResponseFunctionCall | ResponseCustomToolCall): MessageToolCall {
  return item.type === "custom_tool_call"
    ? { id: item.call_id, type: "custom", custom: { name: item.name, input: item.input ?? "" } }
    : { id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments ?? "" } };
}

function isToolCallItem(
  item: ResponseOutputItem
): item is ResponseFunctionCall | ResponseCustomToolCall {
  return item.type === "function_call" || item.type === "custom_tool_call";
}

function encryptedReasoning(output: Array<ResponseOutputItem>): Array<string> {
  return output
    .filter((item): item is ResponseReasoningItem => item.type === "reasoning")
    .flatMap((item) => (item.encrypted_content ? [item.encrypted_content] : []));
}

// ---------------------------------------------------------------------------
// Non-streaming response
// ---------------------------------------------------------------------------

export function responsesToChatResponse(
  result: ResponsesResult,
  model: string
): ChatCompletionResponse {
  const output = result.output ?? [];
  let content = "";
  let refusal = "";
  const annotations: Array<UrlCitationAnnotation> = [];
  const logprobs: Array<TokenLogprob> = [];
  const summaries: Array<string> = [];
  const toolCalls: Array<MessageToolCall> = [];

  for (const item of output) {
    if (item.type === "reasoning") {
      for (const part of (item as ResponseReasoningItem).summary ?? []) {
        if (part.text) summaries.push(part.text);
      }
    } else if (item.type === "message") {
      let separator = content ? MESSAGE_SEPARATOR : "";
      for (const part of (item as ResponseOutputMessage).content ?? []) {
        if (part.type === "refusal") {
          refusal += part.refusal;
          continue;
        }
        if (part.type !== "output_text" || !part.text) continue;
        const offset = content.length + separator.length;
        content += separator + part.text;
        separator = "";
        for (const annotation of part.annotations ?? []) {
          if (annotation.type !== "url_citation" || !("url" in annotation)) continue;
          annotations.push({
            type: "url_citation",
            url_citation: {
              start_index: annotation.start_index + offset,
              end_index: annotation.end_index + offset,
              title: annotation.title,
              url: annotation.url,
            },
          });
        }
        logprobs.push(...(part.logprobs ?? []));
      }
    } else if (isToolCallItem(item)) {
      toolCalls.push(toChatToolCall(item));
    }
  }

  const reasoningOpaque = encodeReasoningOpaque(encryptedReasoning(output));
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
          content: content || null,
          refusal: refusal || null,
          ...(annotations.length > 0 && { annotations }),
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
          ...(summaries.length > 0 && { reasoning_text: summaries.join(MESSAGE_SEPARATOR) }),
          ...(reasoningOpaque && { reasoning_opaque: reasoningOpaque }),
        },
        logprobs: logprobs.length > 0 ? { content: logprobs, refusal: null } : null,
        finish_reason: toFinishReason(result, toolCalls.length > 0),
      },
    ],
    ...(result.service_tier != null && { service_tier: result.service_tier }),
    ...(result.usage && { usage: toChatUsage(result.usage) }),
    ...(result.copilot_usage && { copilot_usage: result.copilot_usage }),
  };
}

// ---------------------------------------------------------------------------
// Streaming response
// ---------------------------------------------------------------------------

export interface ChatStreamOptions {
  /** `stream_options.include_usage`: emit the spec's trailing usage chunk. */
  includeUsage?: boolean;
}

interface ToolStreamState {
  index: number;
  kind: "function" | "custom";
  headerSent: boolean;
  /** Argument/input text already sent to the client. */
  sent: string;
}

/**
 * Convert a Responses SSE stream into Chat Completions chunks, ending with
 * `[DONE]` on normal completion. Upstream failures end the stream with an
 * `{"error": …}` chunk and no `[DONE]`, so clients can tell it was cut short.
 */
export async function* responsesStreamToChatStream(
  stream: AsyncIterable<{ event: string; data: string }>,
  model: string,
  options: ChatStreamOptions = {}
): AsyncIterable<{ data: string }> {
  let id = "";
  let created = Math.floor(Date.now() / 1000);
  let serviceTier: string | null | undefined;
  let started = false;
  const tools = new Map<number, ToolStreamState>();
  let lastTextItem: number | undefined;
  let lastSummaryKey: string | undefined;

  const makeChunk = (
    delta: StreamDelta,
    finishReason: FinishReason | null = null,
    logprobs: ChoiceLogprobs | null = null
  ): ChatCompletionChunk => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs }],
    ...(serviceTier != null && { service_tier: serviceTier }),
    // Spec: with include_usage, every chunk but the last carries `usage: null`.
    ...(options.includeUsage && { usage: null }),
  });
  const chunk = (
    delta: StreamDelta,
    finishReason: FinishReason | null = null,
    logprobs: ChoiceLogprobs | null = null
  ): string => JSON.stringify(makeChunk(delta, finishReason, logprobs));

  for await (const sse of stream) {
    const event = JSON.parse(sse.data) as ResponseStreamEvent;
    const type = event.type || sse.event;
    const out: Array<string> = [];

    if (event.response) {
      id ||= event.response.id;
      created = event.response.created_at ?? created;
      serviceTier = event.response.service_tier ?? serviceTier;
    }
    if (!started && type !== "error" && type !== "response.failed") {
      started = true;
      out.push(chunk({ role: "assistant", content: "" }));
    }
    const outputIndex = event.output_index ?? -1;

    switch (type) {
      case "response.output_item.added": {
        const item = event.item;
        if (item && isToolCallItem(item)) {
          const tool = toolState(tools, outputIndex, item.type);
          if (item.call_id && item.name) {
            out.push(chunk({ tool_calls: [toolHeader(tool, item, "")] }));
            tool.headerSent = true;
          }
        }
        break;
      }

      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta": {
        const tool = tools.get(outputIndex);
        if (!event.delta || !tool?.headerSent) break; // flushed in full at output_item.done
        tool.sent += event.delta;
        out.push(chunk({ tool_calls: [toolDelta(tool, event.delta)] }));
        break;
      }

      case "response.output_item.done": {
        const item = event.item;
        if (!item || !isToolCallItem(item)) break;
        const tool = toolState(tools, outputIndex, item.type);
        const full = (item.type === "custom_tool_call" ? item.input : item.arguments) ?? "";
        if (!tool.headerSent) {
          out.push(chunk({ tool_calls: [toolHeader(tool, item, full)] }));
          tool.headerSent = true;
          tool.sent = full;
        } else if (full.length > tool.sent.length && full.startsWith(tool.sent)) {
          const rest = full.slice(tool.sent.length);
          tool.sent = full;
          out.push(chunk({ tool_calls: [toolDelta(tool, rest)] }));
        }
        break;
      }

      case "response.output_text.delta": {
        if (!event.delta) break;
        const separator = lastTextItem !== undefined && lastTextItem !== outputIndex
          ? MESSAGE_SEPARATOR
          : "";
        lastTextItem = outputIndex;
        const logprobs = event.logprobs?.length ? { content: event.logprobs, refusal: null } : null;
        out.push(chunk({ content: separator + event.delta }, null, logprobs));
        break;
      }

      case "response.refusal.delta":
        if (event.delta) out.push(chunk({ refusal: event.delta }));
        break;

      case "response.reasoning_summary_text.delta": {
        if (!event.delta) break;
        const key = `${outputIndex}:${event.summary_index ?? 0}`;
        const separator = lastSummaryKey !== undefined && lastSummaryKey !== key
          ? MESSAGE_SEPARATOR
          : "";
        lastSummaryKey = key;
        out.push(chunk({ reasoning_text: separator + event.delta }));
        break;
      }

      case "response.completed":
      case "response.incomplete": {
        const result = event.response;
        if (!result) break;
        const reasoningOpaque = encodeReasoningOpaque(encryptedReasoning(result.output ?? []));
        if (reasoningOpaque) out.push(chunk({ reasoning_opaque: reasoningOpaque }));

        const hasToolCalls = tools.size > 0 || (result.output ?? []).some(isToolCallItem);
        const finish = makeChunk({}, toFinishReason(result, hasToolCalls));
        const usage = result.usage ? toChatUsage(result.usage) : undefined;
        const copilotUsage: CopilotUsage | undefined = event.copilot_usage ?? result.copilot_usage;

        if (options.includeUsage) {
          out.push(JSON.stringify(finish));
          out.push(JSON.stringify({
            ...finish,
            choices: [],
            usage: usage ?? null,
            ...(copilotUsage && { copilot_usage: copilotUsage }),
          }));
        } else {
          // Without include_usage, usage rides on the finish chunk — what Copilot's
          // native /chat/completions does and what existing clients already read.
          out.push(JSON.stringify({
            ...finish,
            ...(usage && { usage }),
            ...(copilotUsage && { copilot_usage: copilotUsage }),
          }));
        }
        out.push("[DONE]");
        for (const data of out) yield { data };
        return;
      }

      case "response.failed":
      case "error": {
        const error = event.response?.error ?? { code: event.code ?? undefined, message: event.message };
        out.push(JSON.stringify({
          error: {
            message: error.message || "Upstream response failed",
            type: "upstream_error",
            code: error.code ?? null,
            ...(event.param != null && { param: event.param }),
          },
        }));
        for (const data of out) yield { data };
        return;
      }
    }

    for (const data of out) yield { data };
  }

  yield {
    data: JSON.stringify({
      error: {
        message: "Upstream stream ended before the response completed",
        type: "upstream_error",
        code: null,
      },
    }),
  };
}

function toolState(
  tools: Map<number, ToolStreamState>,
  outputIndex: number,
  itemType: string
): ToolStreamState {
  let tool = tools.get(outputIndex);
  if (!tool) {
    tool = {
      index: tools.size,
      kind: itemType === "custom_tool_call" ? "custom" : "function",
      headerSent: false,
      sent: "",
    };
    tools.set(outputIndex, tool);
  }
  return tool;
}

function toolHeader(
  tool: ToolStreamState,
  item: ResponseFunctionCall | ResponseCustomToolCall,
  body: string
): NonNullable<StreamDelta["tool_calls"]>[number] {
  return tool.kind === "custom"
    ? { index: tool.index, id: item.call_id, type: "custom", custom: { name: item.name, input: body } }
    : { index: tool.index, id: item.call_id, type: "function", function: { name: item.name, arguments: body } };
}

function toolDelta(
  tool: ToolStreamState,
  text: string
): NonNullable<StreamDelta["tool_calls"]>[number] {
  return tool.kind === "custom"
    ? { index: tool.index, custom: { input: text } }
    : { index: tool.index, function: { arguments: text } };
}
