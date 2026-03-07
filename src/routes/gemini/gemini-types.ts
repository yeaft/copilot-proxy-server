// Gemini API Types (simplified for proxy use)

export interface GeminiGenerateContentRequest {
  contents?: Array<GeminiContent>;
  tools?: Array<GeminiTool>;
  toolConfig?: {
    functionCallingConfig?: {
      mode?: "AUTO" | "ANY" | "NONE";
      allowedFunctionNames?: string[];
    };
  };
  systemInstruction?: GeminiContent;
  generationConfig?: GeminiGenerationConfig;
}

export interface GeminiContent {
  parts: Array<GeminiPart>;
  role?: "user" | "model" | "function";
}

export type GeminiPart =
  | { text: string }
  | { functionCall: { id?: string; name: string; args: Record<string, unknown> } }
  | { functionResponse: { id?: string; name: string; response: Record<string, unknown> } }
  | { inlineData: { mimeType: string; data: string } };

export interface GeminiTool {
  functionDeclarations?: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
}

export interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  candidateCount?: number;
}

export interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
    index?: number;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  modelVersion?: string;
}
