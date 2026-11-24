import type {
  ChatCompletionsPayload,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Message,
  Tool,
  ContentPart,
} from "../../types/openai.js";
import type {
  GeminiGenerateContentRequest,
  GeminiGenerateContentResponse,
  GeminiContent,
  GeminiFunctionResponse,
  GeminiPart,
  GeminiTool,
} from "./gemini-types.js";
import { toolImageReader } from "./tool-images.js";

// === Request translation (Gemini -> OpenAI) ===

// Copilot exposes these native Gemini thinking levels as Chat Completions effort.
// https://aistudio.google.com/docs/openai#thinking
const geminiReasoningModels = new Set([
  "gemini-4-carbon", "gemini-4-argon", "gemini-4-neon", "gemini-4-hydrogen", "gemini-3.8-flash",
]);

function geminiReasoningEffort(modelId: string, level: unknown): ChatCompletionsPayload["reasoning_effort"] {
  if (!geminiReasoningModels.has(modelId) || typeof level !== "string") return undefined;
  const effort = level.toLowerCase();
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  if (effort === "xhigh" && (modelId === "gemini-4-neon" || modelId === "gemini-4-hydrogen")) return effort;
  return undefined;
}

export function translateGeminiToOpenAI(
  modelId: string,
  request: GeminiGenerateContentRequest
): ChatCompletionsPayload {
  const messages: Message[] = [];

  // System instruction
  if (request.systemInstruction) {
    const text = extractTextFromParts(request.systemInstruction.parts);
    if (text) {
      messages.push({ role: "system", content: text });
    }
  }

  // Keep consecutive tool results together. Chat Completions expects every
  // tool message in the batch before any user message (including attachments).
  const readToolImage = toolImageReader();
  let attachments: ContentPart[] = [];
  let followUps: Message[] = [];
  const flushToolImagesAndInput = () => {
    if (attachments.length > 0) messages.push({ role: "user", content: attachments });
    messages.push(...followUps);
    attachments = [];
    followUps = [];
  };
  for (const content of request.contents ?? []) {
    const responses = content.parts.filter(
      (part): part is { functionResponse: GeminiFunctionResponse } => "functionResponse" in part
    );
    if (responses.length === 0) {
      flushToolImagesAndInput();
      messages.push(...convertGeminiContentToOpenAI(content));
      continue;
    }
    for (const { functionResponse } of responses) {
      const id = functionResponse.id || functionResponse.name;
      messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(functionResponse.response) });
      if (!Array.isArray(functionResponse.parts)) continue;
      let labeled = false;
      for (const part of functionResponse.parts) {
        const image = readToolImage(part);
        if (!image) continue;
        if (!labeled) {
          attachments.push({ type: "text", text: `Image(s) from tool result ${id}:` });
          labeled = true;
        }
        attachments.push(image);
      }
    }
    // Gemini may combine tool results and follow-up user input in one content.
    const userInput = content.parts.filter((part) => "text" in part || "inlineData" in part);
    if (userInput.length > 0) {
      followUps.push(...convertGeminiContentToOpenAI({ role: "user", parts: userInput }));
    }
  }
  flushToolImagesAndInput();

  const payload: ChatCompletionsPayload = {
    model: modelId,
    messages,
    temperature: request.generationConfig?.temperature,
    top_p: request.generationConfig?.topP,
    max_tokens: request.generationConfig?.maxOutputTokens,
    stop: request.generationConfig?.stopSequences,
    n: request.generationConfig?.candidateCount,
  };

  const reasoningEffort = geminiReasoningEffort(modelId, request.generationConfig?.thinkingConfig?.thinkingLevel);
  if (reasoningEffort !== undefined) payload.reasoning_effort = reasoningEffort;

  // Tools
  if (request.tools) {
    payload.tools = translateGeminiToolsToOpenAI(request.tools);
  }

  // Tool config
  if (request.toolConfig?.functionCallingConfig?.mode) {
    const mode = request.toolConfig.functionCallingConfig.mode;
    if (mode === "AUTO") payload.tool_choice = "auto";
    else if (mode === "NONE") payload.tool_choice = "none";
    else if (mode === "ANY") payload.tool_choice = "required";
  }

  return payload;
}

function convertGeminiContentToOpenAI(content: GeminiContent): Message[] {
  const role = content.role === "model" ? "assistant" : content.role === "function" ? "tool" : "user";
  const messages: Message[] = [];

  // Check for function calls (tool calls from assistant)
  const functionCalls = content.parts.filter(
    (p): p is { functionCall: { id?: string; name: string; args: Record<string, unknown> } } =>
      "functionCall" in p
  );

  if (functionCalls.length > 0) {
    const textParts = content.parts.filter((p): p is { text: string } => "text" in p);
    const textContent = textParts.map((p) => p.text).join("\n\n") || null;

    messages.push({
      role: "assistant",
      content: textContent,
      tool_calls: functionCalls.map((fc, i) => ({
        id: fc.functionCall.id || `call_${i}`,
        type: "function" as const,
        function: {
          name: fc.functionCall.name,
          arguments: JSON.stringify(fc.functionCall.args),
        },
      })),
    });
    return messages;
  }

  // Regular content (text + images)
  const hasImage = content.parts.some((p) => "inlineData" in p);

  if (hasImage) {
    const contentParts: ContentPart[] = [];
    for (const part of content.parts) {
      if ("text" in part) {
        contentParts.push({ type: "text", text: part.text });
      } else if ("inlineData" in part) {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
          },
        });
      }
    }
    messages.push({ role, content: contentParts });
  } else {
    const text = extractTextFromParts(content.parts);
    messages.push({ role, content: text || "" });
  }

  return messages;
}

function extractTextFromParts(parts: GeminiPart[]): string {
  return parts
    .filter((p): p is { text: string } => "text" in p)
    .map((p) => p.text)
    .join("\n\n");
}

function translateGeminiToolsToOpenAI(tools: GeminiTool[]): Tool[] {
  const result: Tool[] = [];
  for (const tool of tools) {
    if (tool.functionDeclarations) {
      for (const fn of tool.functionDeclarations) {
        result.push({
          type: "function",
          function: {
            name: fn.name,
            description: fn.description,
            parameters: fn.parametersJsonSchema ?? fn.parameters ?? { type: "object", properties: {} },
          },
        });
      }
    }
  }
  return result;
}

// === Response translation (OpenAI -> Gemini) ===

export function translateOpenAIToGemini(
  response: ChatCompletionResponse,
  modelId: string
): GeminiGenerateContentResponse {
  const candidates = response.choices.map((choice) => {
    const parts: GeminiPart[] = [];

    if (choice.message.content) {
      parts.push({ text: choice.message.content });
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        if (tc.type === "custom") continue; // this route only sends function tools
        parts.push({
          functionCall: {
            id: tc.id,
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
          },
        });
      }
    }

    return {
      content: {
        parts,
        role: "model" as const,
      },
      finishReason: mapOpenAIFinishToGemini(choice.finish_reason),
      index: choice.index,
    };
  });

  return {
    candidates,
    usageMetadata: {
      promptTokenCount: response.usage?.prompt_tokens ?? 0,
      candidatesTokenCount: response.usage?.completion_tokens ?? 0,
      totalTokenCount: response.usage?.total_tokens ?? 0,
    },
    modelVersion: modelId,
  };
}

export function translateOpenAIChunkToGemini(
  chunk: ChatCompletionChunk,
  modelId: string
): GeminiGenerateContentResponse {
  const choice = chunk.choices[0];
  if (!choice) {
    return {
      candidates: [{ finishReason: "STOP", index: 0 }],
      usageMetadata: {
        promptTokenCount: chunk.usage?.prompt_tokens ?? 0,
        candidatesTokenCount: chunk.usage?.completion_tokens ?? 0,
        totalTokenCount: chunk.usage?.total_tokens ?? 0,
      },
      modelVersion: modelId,
    };
  }

  const parts: GeminiPart[] = [];

  if (choice.delta.content) {
    parts.push({ text: choice.delta.content });
  }

  if (choice.delta.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      if (tc.function?.name) {
        parts.push({
          functionCall: {
            id: tc.id,
            name: tc.function.name,
            args: tc.function.arguments
              ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
              : {},
          },
        });
      }
    }
  }

  const candidate: GeminiGenerateContentResponse["candidates"] = [
    {
      ...(parts.length > 0
        ? { content: { parts, role: "model" as const } }
        : {}),
      ...(choice.finish_reason
        ? { finishReason: mapOpenAIFinishToGemini(choice.finish_reason) }
        : {}),
      index: choice.index,
    },
  ];

  const result: GeminiGenerateContentResponse = { candidates: candidate };

  // Add usage on final chunk
  if (choice.finish_reason && chunk.usage) {
    result.usageMetadata = {
      promptTokenCount: chunk.usage.prompt_tokens,
      candidatesTokenCount: chunk.usage.completion_tokens,
      totalTokenCount: chunk.usage.total_tokens,
    };
    result.modelVersion = modelId;
  }

  return result;
}

function mapOpenAIFinishToGemini(
  reason: "stop" | "length" | "tool_calls" | "content_filter"
): string {
  const map: Record<string, string> = {
    stop: "STOP",
    length: "MAX_TOKENS",
    tool_calls: "STOP",
    content_filter: "SAFETY",
  };
  return map[reason] || "OTHER";
}
