// OpenAI Responses API Types (used by codex models like gpt-5.x-codex)

import type { Message, Tool } from "./openai.js";

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
  reasoning?: { effort?: "low" | "medium" | "high" | "xhigh" } | null;
  text?: { format?: { type: "text" | "json_object" } } | null;
  previous_response_id?: string | null;
  store?: boolean | null;
  metadata?: Record<string, string> | null;
  truncation?: "auto" | "disabled" | null;
}

// Input can be messages in OpenAI format
export type ResponseInputItem =
  | { role: "user"; content: string | Array<ResponseContentPart> }
  | { role: "assistant"; content: string }
  | { role: "system"; content: string }
  | { role: "developer"; content: string };

export interface ResponseContentPart {
  type: "input_text" | "input_image";
  text?: string;
  image_url?: string;
  detail?: "low" | "high" | "auto";
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
  output_text: string | null;
  usage: ResponsesUsage | null;
  incomplete_details: unknown | null;
  instructions: string | null;
  max_output_tokens: number | null;
  temperature: number;
  top_p: number;
  reasoning: { effort: string; summary: unknown | null } | null;
  tool_choice: string;
  tools: Array<ResponseTool>;
  parallel_tool_calls: boolean;
  error: unknown | null;
}

export interface ResponseOutputItem {
  type: "message";
  id: string;
  role: "assistant";
  status: "completed" | "in_progress";
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
  input_tokens_details?: { cached_tokens: number };
  output_tokens_details?: { reasoning_tokens: number };
}

// --- Streaming Events ---

export interface ResponseStreamEvent {
  type: string;
  sequence_number: number;
  // Varies by event type; we care about these:
  delta?: string; // response.output_text.delta
  response?: ResponsesResult; // response.completed, response.created
  item?: ResponseOutputItem; // response.output_item.done
  content_index?: number;
  output_index?: number;
}
