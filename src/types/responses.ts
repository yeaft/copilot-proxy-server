// OpenAI Responses API types used by the Copilot wire format.

// --- Request ---

export interface ResponsesPayload {
  model: string;
  input: string | Array<ResponseInputItem>;
  instructions?: string | null;
  max_output_tokens?: number | null;
  temperature?: number | null;
  top_p?: number | null;
  stream?: boolean | null;
  tools?: Array<ResponseTool> | null;
  tool_choice?: "none" | "auto" | "required" | null;
  parallel_tool_calls?: boolean | null;
  reasoning?: {
    effort?: "low" | "medium" | "high" | "xhigh";
    summary?: "auto" | "concise" | "detailed" | null;
  } | null;
  include?: Array<"reasoning.encrypted_content" | string> | null;
  prompt_cache_key?: string | null;
  previous_response_id?: string | null;
  store?: boolean | null;
  metadata?: Record<string, string> | null;
  truncation?: "auto" | "disabled" | null;
  text?: { format?: { type: "text" | "json_object" } } | null;
}

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseReasoningItem
  | ResponseFunctionCall
  | ResponseFunctionCallOutput;

export interface ResponseInputMessage {
  role: "user" | "assistant" | "system" | "developer";
  content: string | Array<ResponseContentPart>;
}

export interface ResponseContentPart {
  type: "input_text" | "input_image";
  text?: string;
  image_url?: string;
  detail?: "low" | "high" | "auto";
}

export interface ResponseReasoningItem {
  type: "reasoning";
  id?: string;
  encrypted_content?: string;
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
  output: string;
  status?: "in_progress" | "completed" | "incomplete";
}

export interface ResponseTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

// --- Non-streaming Response ---

export interface ResponsesResult {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  status: "completed" | "failed" | "in_progress" | "incomplete";
  output: Array<ResponseOutputItem>;
  output_text?: string | null;
  usage: ResponsesUsage | null;
  incomplete_details?: unknown | null;
  instructions?: string | null;
  max_output_tokens?: number | null;
  temperature?: number | null;
  top_p?: number | null;
  reasoning?: { effort?: string; summary?: unknown | null } | null;
  tool_choice?: unknown;
  tools?: Array<ResponseTool>;
  parallel_tool_calls?: boolean;
  error?: unknown | null;
}

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseReasoningItem
  | ResponseFunctionCall;

export interface ResponseOutputMessage {
  type: "message";
  id: string;
  role: "assistant";
  status: "completed" | "in_progress" | "incomplete";
  content: Array<ResponseOutputContent>;
  phase?: string;
}

export interface ResponseOutputContent {
  type: "output_text";
  text: string;
  annotations: unknown[];
}

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
  response?: ResponsesResult;
  item?: ResponseOutputItem;
  content_index?: number;
  output_index?: number;
}
