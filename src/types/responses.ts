// OpenAI Responses API types used by the Copilot wire format.

import type {
  CopilotUsage,
  PromptCacheBreakpoint,
  PromptCacheOptions,
  ReasoningEffort,
  TokenLogprob,
} from "./openai.js";

// --- Request ---

export type ResponseTextFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      name: string;
      description?: string;
      schema?: Record<string, unknown>;
      strict?: boolean | null;
    };

export type ResponseToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; name: string }
  | { type: "custom"; name: string }
  | {
      type: "allowed_tools";
      mode: "auto" | "required";
      tools: Array<Record<string, unknown>>;
    };

export interface ResponsesPayload {
  model: string;
  input: string | Array<ResponseInputItem>;
  instructions?: string | null;
  max_output_tokens?: number | null;
  temperature?: number | null;
  top_p?: number | null;
  top_logprobs?: number | null;
  stream?: boolean | null;
  tools?: Array<ResponseTool> | null;
  tool_choice?: ResponseToolChoice | null;
  parallel_tool_calls?: boolean | null;
  reasoning?: {
    effort?: ReasoningEffort;
    summary?: "auto" | "concise" | "detailed" | null;
  } | null;
  include?: Array<"reasoning.encrypted_content" | string> | null;
  prompt_cache_key?: string | null;
  prompt_cache_options?: PromptCacheOptions | null;
  prompt_cache_retention?: "in_memory" | "24h" | null;
  previous_response_id?: string | null;
  store?: boolean | null;
  metadata?: Record<string, string> | null;
  truncation?: "auto" | "disabled" | null;
  text?: {
    format?: ResponseTextFormat;
    verbosity?: "low" | "medium" | "high" | null;
  } | null;
  safety_identifier?: string | null;
  service_tier?: string | null;
  user?: string | null;
}

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseReasoningItem
  | ResponseFunctionCall
  | ResponseFunctionCallOutput
  | ResponseCustomToolCall
  | ResponseCustomToolCallOutput;

export interface ResponseInputMessage {
  type?: "message";
  role: "user" | "assistant" | "system" | "developer";
  content: string | Array<ResponseContentPart>;
}

export type ResponseContentPart =
  | ResponseInputTextPart
  | ResponseInputImagePart
  | ResponseInputFilePart
  | ResponseOutputTextPart
  | ResponseRefusalPart;

export type ResponseToolOutputPart =
  | ResponseInputTextPart
  | ResponseInputImagePart
  | ResponseInputFilePart;

export interface ResponseInputTextPart {
  type: "input_text";
  text: string;
  prompt_cache_breakpoint?: PromptCacheBreakpoint;
}

export interface ResponseInputImagePart {
  type: "input_image";
  image_url: string;
  detail?: "low" | "high" | "auto" | "original";
  prompt_cache_breakpoint?: PromptCacheBreakpoint;
}

export interface ResponseInputFilePart {
  type: "input_file";
  file_id?: string;
  filename?: string;
  file_data?: string;
  prompt_cache_breakpoint?: PromptCacheBreakpoint;
}

export interface ResponseOutputTextPart {
  type: "output_text";
  text: string;
  annotations?: unknown[];
}

export interface ResponseRefusalPart {
  type: "refusal";
  refusal: string;
}

export interface ResponseReasoningItem {
  type: "reasoning";
  id?: string;
  encrypted_content?: string | null;
  summary?: Array<{ type: "summary_text"; text: string }>;
}

export interface ResponseFunctionCall {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: "in_progress" | "completed" | "incomplete";
}

export interface ResponseFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string | Array<ResponseToolOutputPart>;
  status?: "in_progress" | "completed" | "incomplete";
}

export interface ResponseCustomToolCall {
  type: "custom_tool_call";
  id?: string;
  call_id: string;
  name: string;
  input: string;
  status?: "in_progress" | "completed" | "incomplete";
}

export interface ResponseCustomToolCallOutput {
  type: "custom_tool_call_output";
  call_id: string;
  output: string | Array<ResponseToolOutputPart>;
}

export type ResponseTool = ResponseFunctionTool | ResponseCustomTool;

export interface ResponseFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown> | null;
  strict?: boolean | null;
}

export interface ResponseCustomTool {
  type: "custom";
  name: string;
  description?: string;
  format?:
    | { type: "text" }
    | { type: "grammar"; syntax: "lark" | "regex"; definition: string };
}

// --- Non-streaming Response ---

export interface ResponsesIncompleteDetails {
  reason?: "max_output_tokens" | "content_filter" | string;
}

export interface ResponsesResult {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  status: "completed" | "failed" | "in_progress" | "incomplete" | "cancelled" | "queued";
  output: Array<ResponseOutputItem>;
  output_text?: string | null;
  usage: ResponsesUsage | null;
  copilot_usage?: CopilotUsage;
  incomplete_details?: ResponsesIncompleteDetails | null;
  instructions?: string | null;
  max_output_tokens?: number | null;
  temperature?: number | null;
  top_p?: number | null;
  reasoning?: { effort?: string; summary?: unknown | null } | null;
  service_tier?: string | null;
  tool_choice?: unknown;
  tools?: Array<ResponseTool>;
  parallel_tool_calls?: boolean;
  error?: { code?: string; message?: string } | null;
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseReasoningItem
  | ResponseFunctionCall
  | ResponseCustomToolCall
  | { type: string; [key: string]: unknown };

export interface ResponseOutputMessage {
  type: "message";
  id: string;
  role: "assistant";
  status: "completed" | "in_progress" | "incomplete";
  content: Array<ResponseOutputContent>;
  phase?: string;
}

export interface ResponseUrlCitation {
  type: "url_citation";
  start_index: number;
  end_index: number;
  title: string;
  url: string;
}

export type ResponseOutputContent =
  | {
      type: "output_text";
      text: string;
      annotations?: Array<ResponseUrlCitation | { type: string }>;
      logprobs?: Array<TokenLogprob>;
    }
  | {
      type: "refusal";
      refusal: string;
    };

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  output_tokens_details?: { reasoning_tokens?: number };
}

// --- Streaming Events ---

export interface ResponseStreamEvent {
  type: string;
  sequence_number: number;
  delta?: string;
  arguments?: string;
  input?: string;
  text?: string;
  refusal?: string;
  name?: string;
  item_id?: string;
  response?: ResponsesResult;
  item?: ResponseOutputItem;
  part?: ResponseOutputContent | { type: "summary_text"; text: string };
  content_index?: number;
  output_index?: number;
  summary_index?: number;
  logprobs?: Array<TokenLogprob>;
  copilot_usage?: CopilotUsage;
  // `error` events
  code?: string | null;
  message?: string;
  param?: string | null;
}
