// OpenAI Chat Completions API types (latest spec, openai-node `chat/completions`)
// plus the Copilot wire extensions (`reasoning_text`, `reasoning_opaque`, `copilot_usage`).

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface JsonSchemaFormat {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
  strict?: boolean | null;
}

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchemaFormat };

export interface StreamOptions {
  include_usage?: boolean;
  include_obfuscation?: boolean;
}

export interface PromptCacheBreakpoint {
  mode: "explicit";
  ttl?: "30m" | "12h";
}

export interface PromptCacheOptions {
  mode?: "implicit" | "explicit";
  ttl?: "30m";
}

export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } }
  | { type: "custom"; custom: { name: string } }
  | {
      type: "allowed_tools";
      allowed_tools: {
        mode: "auto" | "required";
        tools: Array<Record<string, unknown>>;
      };
    };

export interface ChatCompletionsPayload {
  messages: Array<Message>;
  model: string;
  temperature?: number | null;
  top_p?: number | null;
  max_tokens?: number | null;
  max_completion_tokens?: number | null;
  stop?: string | Array<string> | null;
  n?: number | null;
  stream?: boolean | null;
  stream_options?: StreamOptions | null;
  frequency_penalty?: number | null;
  presence_penalty?: number | null;
  logit_bias?: Record<string, number> | null;
  logprobs?: boolean | null;
  top_logprobs?: number | null;
  response_format?: ResponseFormat | null;
  seed?: number | null;
  tools?: Array<Tool> | null;
  tool_choice?: ToolChoice | null;
  parallel_tool_calls?: boolean | null;
  reasoning_effort?: ReasoningEffort | null;
  verbosity?: "low" | "medium" | "high" | null;
  store?: boolean | null;
  metadata?: Record<string, string> | null;
  prompt_cache_key?: string | null;
  prompt_cache_options?: PromptCacheOptions | null;
  prompt_cache_retention?: "in_memory" | "24h" | null;
  safety_identifier?: string | null;
  service_tier?: string | null;
  user?: string | null;
  prediction?: unknown;
  // Spec fields with no Responses-API equivalent on Copilot. Typed so the
  // Responses bridge can reject them explicitly instead of silently dropping.
  modalities?: Array<"text" | "audio"> | null;
  audio?: unknown;
  web_search_options?: unknown;
  moderation?: unknown;
  /** @deprecated Use `tools`. */
  functions?: unknown;
  /** @deprecated Use `tool_choice`. */
  function_call?: unknown;
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer" | "function";
  content?: string | Array<ContentPart> | null;
  refusal?: string | null;
  name?: string;
  tool_calls?: Array<MessageToolCall>;
  tool_call_id?: string;
  /** Copilot extension: human-readable reasoning summary. */
  reasoning_text?: string | null;
  /** Copilot extension: opaque reasoning state to echo back on the next turn. */
  reasoning_opaque?: string | null;
}

export type Tool = FunctionTool | CustomTool;

export interface FunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean | null;
  };
}

export interface CustomTool {
  type: "custom";
  custom: {
    name: string;
    description?: string;
    format?:
      | { type: "text" }
      | { type: "grammar"; grammar: { definition: string; syntax: "lark" | "regex" } };
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface CustomToolCall {
  id: string;
  type: "custom";
  custom: {
    name: string;
    input: string;
  };
}

export type MessageToolCall = ToolCall | CustomToolCall;

export type ContentPart =
  | TextPart
  | ImagePart
  | InputAudioPart
  | FilePart
  | RefusalPart;

export interface TextPart {
  type: "text";
  text: string;
  prompt_cache_breakpoint?: PromptCacheBreakpoint;
}

export interface ImagePart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "low" | "high" | "auto" | "original";
  };
  prompt_cache_breakpoint?: PromptCacheBreakpoint;
}

export interface InputAudioPart {
  type: "input_audio";
  input_audio: { data: string; format: "wav" | "mp3" };
  prompt_cache_breakpoint?: PromptCacheBreakpoint;
}

export interface FilePart {
  type: "file";
  file: {
    file_id?: string;
    filename?: string;
    file_data?: string;
  };
  prompt_cache_breakpoint?: PromptCacheBreakpoint;
}

export interface RefusalPart {
  type: "refusal";
  refusal: string;
}

export interface TokenLogprob {
  token: string;
  logprob: number;
  bytes: Array<number> | null;
  top_logprobs: Array<{ token: string; logprob: number; bytes: Array<number> | null }>;
}

export interface ChoiceLogprobs {
  content: Array<TokenLogprob> | null;
  refusal: Array<TokenLogprob> | null;
}

export interface UrlCitationAnnotation {
  type: "url_citation";
  url_citation: {
    start_index: number;
    end_index: number;
    title: string;
    url: string;
  };
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Copilot extension seen on native /chat/completions responses. */
  reasoning_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    accepted_prediction_tokens?: number;
    rejected_prediction_tokens?: number;
  };
}

export interface CopilotTokenDetail {
  batch_size: number;
  cost_per_batch: number;
  model: string;
  token_count: number;
  token_type: "input" | "output" | "cache_read" | "cache_write" | string;
}

export interface CopilotUsage {
  token_details?: Array<CopilotTokenDetail>;
  total_nano_aiu?: number;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

// Streaming types

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<StreamChoice>;
  system_fingerprint?: string;
  service_tier?: string | null;
  usage?: ChatCompletionUsage | null;
  copilot_usage?: CopilotUsage;
}

export interface StreamToolCallDelta {
  index: number;
  id?: string;
  type?: "function" | "custom";
  function?: {
    name?: string;
    arguments?: string;
  };
  custom?: {
    name?: string;
    input?: string;
  };
}

export interface StreamDelta {
  content?: string | null;
  refusal?: string | null;
  role?: "user" | "assistant" | "system" | "tool" | "developer";
  reasoning_text?: string | null;
  reasoning_opaque?: string | null;
  tool_calls?: Array<StreamToolCallDelta>;
}

export interface StreamChoice {
  index: number;
  delta: StreamDelta;
  finish_reason: FinishReason | null;
  logprobs: ChoiceLogprobs | null;
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<NonStreamChoice>;
  system_fingerprint?: string;
  service_tier?: string | null;
  usage?: ChatCompletionUsage;
  copilot_usage?: CopilotUsage;
}

export interface ResponseMessage {
  role: "assistant";
  content: string | null;
  refusal?: string | null;
  annotations?: Array<UrlCitationAnnotation>;
  reasoning_text?: string | null;
  reasoning_opaque?: string | null;
  tool_calls?: Array<MessageToolCall>;
}

export interface NonStreamChoice {
  index: number;
  message: ResponseMessage;
  logprobs: ChoiceLogprobs | null;
  finish_reason: FinishReason;
}
