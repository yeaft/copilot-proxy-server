// OpenAI API Types (also used as Copilot wire format)

export interface ChatCompletionsPayload {
  messages: Array<Message>;
  model: string;
  temperature?: number | null;
  top_p?: number | null;
  max_tokens?: number | null;
  stop?: string | Array<string> | null;
  n?: number | null;
  stream?: boolean | null;
  frequency_penalty?: number | null;
  presence_penalty?: number | null;
  logit_bias?: Record<string, number> | null;
  logprobs?: boolean | null;
  response_format?: { type: "json_object" } | null;
  seed?: number | null;
  tools?: Array<Tool> | null;
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null;
  user?: string | null;
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer";
  content: string | Array<ContentPart> | null;
  name?: string;
  tool_calls?: Array<ToolCall>;
  tool_call_id?: string;
}

export interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
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

export type ContentPart = TextPart | ImagePart;

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
}

// Streaming types

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<StreamChoice>;
  system_fingerprint?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens: number;
    };
    completion_tokens_details?: {
      accepted_prediction_tokens: number;
      rejected_prediction_tokens: number;
    };
  };
}

interface StreamDelta {
  content?: string | null;
  role?: "user" | "assistant" | "system" | "tool";
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

interface StreamChoice {
  index: number;
  delta: StreamDelta;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  logprobs: object | null;
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<NonStreamChoice>;
  system_fingerprint?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens: number;
    };
  };
}

interface ResponseMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: Array<ToolCall>;
}

interface NonStreamChoice {
  index: number;
  message: ResponseMessage;
  logprobs: object | null;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter";
}
