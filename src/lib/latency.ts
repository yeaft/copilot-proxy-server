import type { ChatCompletionChunk } from "../types/openai.js";

/** True when a chat-completions chunk contains the first user-visible output. */
export function hasChatOutput(chunk: ChatCompletionChunk): boolean {
  return chunk.choices.some((choice) => {
    const { delta } = choice;
    if (typeof delta.content === "string" && delta.content.length > 0) return true;
    return delta.tool_calls?.some((toolCall) =>
      Boolean(
        toolCall.id ||
        toolCall.function?.name ||
        toolCall.function?.arguments
      )
    ) ?? false;
  });
}

/** True when a Responses API event contains an output delta rather than metadata. */
export function hasResponsesOutput(event: string, delta: unknown): boolean {
  return (
    (event === "response.output_text.delta" ||
      event === "response.function_call_arguments.delta") &&
    typeof delta === "string" &&
    delta.length > 0
  );
}
