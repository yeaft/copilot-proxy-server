import * as zlib from "node:zlib";

import { logger } from "../lib/logger.js";
import { state } from "../lib/state.js";

const DEEPSEEK_DEFAULT_HOST = "https://api.deepseek.com";
const ANTHROPIC_VERSION = "2023-06-01";
const FETCH_DECODED_ENCODINGS = new Set(["br", "gzip", "x-gzip", "deflate"]);
// Node 24's bundled Undici 7 also decodes zstd; Node 22's Undici 6 does not,
// even when the runtime exposes the zlib zstd APIs.
if (Number(process.versions.undici?.split(".")[0]) >= 7 && typeof zlib.createZstdDecompress === "function") {
  FETCH_DECODED_ENCODINGS.add("zstd");
}

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

  // Node fetch decodes supported compression but keeps the original headers.
  // Only remove the encoding when the entire chain was decoded; Node 22 leaves
  // bodies with any unknown coding untouched. The downstream owns HTTP framing.
  const responseHeaders = new Headers(response.headers);
  const contentEncodings = responseHeaders.get("content-encoding")?.toLowerCase().split(",");
  if (contentEncodings?.every((coding) => FETCH_DECODED_ENCODINGS.has(coding.trim()))) {
    responseHeaders.delete("content-encoding");
  }
  const connectionHeaders = responseHeaders.get("connection")?.split(",") ?? [];
  for (const header of [
    ...connectionHeaders.map((header) => header.trim()),
    "content-length",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    if (header) responseHeaders.delete(header);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
