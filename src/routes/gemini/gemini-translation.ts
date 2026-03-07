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
  GeminiPart,
  GeminiTool,
} from "./gemini-types.js";

// === Request translation (Gemini -> OpenAI) ===

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

  // Contents
  if (request.contents) {
    for (const content of request.contents) {
      const converted = convertGeminiContentToOpenAI(content);
      messages.push(...converted);
    }
  }

  const payload: ChatCompletionsPayload = {
    model: modelId,
    messages,
    temperature: request.generationConfig?.temperature,
    top_p: request.generationConfig?.topP,
    max_tokens: request.generationConfig?.maxOutputTokens,
    stop: request.generationConfig?.stopSequences,
    n: request.generationConfig?.candidateCount,
  };

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

  // Check for function responses (tool results)
  const functionResponses = content.parts.filter(
    (p): p is { functionResponse: { id?: string; name: string; response: Record<string, unknown> } } =>
      "functionResponse" in p
  );

  if (functionResponses.length > 0) {
    for (const fr of functionResponses) {
      messages.push({
        role: "tool",
        tool_call_id: fr.functionResponse.id || fr.functionResponse.name,
        content: JSON.stringify(fr.functionResponse.response),
      });
    }
    return messages;
  }

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
            parameters: fn.parameters || {},
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
