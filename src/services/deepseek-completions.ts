import { logger } from "../lib/logger.js";
import { state } from "../lib/state.js";

const DEEPSEEK_DEFAULT_HOST = "https://api.deepseek.com";
const ANTHROPIC_VERSION = "2023-06-01";

export type DeepseekEndpoint =
  | "/v1/messages"
  | "/v1/chat/completions"
  | "/v1/responses";

function getDeepseekHost(): string {
  return process.env.DEEPSEEK_HOST || DEEPSEEK_DEFAULT_HOST;
}

export function isDeepseekModel(model: string): boolean {
  return model.toLowerCase().startsWith("deepseek");
}

/**
 * Forward a DeepSeek request to the same API endpoint used by the client.
 * The payload and streaming event format are preserved without translation.
 */
export async function createDeepseekCompletion(
  endpoint: DeepseekEndpoint,
  payload: Record<string, unknown>
): Promise<Response> {
  if (!state.deepseekApiKey) {
    throw new Error("DeepSeek API key not configured");
  }

  const host = getDeepseekHost();
  const url = `${host}${endpoint}`;
  const isMessagesApi = endpoint === "/v1/messages";

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(isMessagesApi
      ? {
          "x-api-key": state.deepseekApiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        }
      : { authorization: `Bearer ${state.deepseekApiKey}` }),
  };

  logger.debug(`DeepSeek request → ${url} model=${payload.model}`);

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    logger.error("DeepSeek API error:", response.status);
  }

  return response;
}
