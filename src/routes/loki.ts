import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { LokiSignInRequired, LokiAuthError } from "../auth/loki-auth.js";
import { LokiUpstreamError } from "../services/loki.js";
import { isDeepseekModel } from "../services/deepseek-completions.js";
import { state } from "../lib/state.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { getClientIp } from "../lib/ip.js";
import { logUsage } from "../lib/db.js";
import { observeLokiUsage } from "../lib/loki-usage.js";
import { logger } from "../lib/logger.js";
import { forwardError } from "../lib/error.js";

const endpoints = {
  "/v1/chat/completions": "/v1/chat/completions",
  "/chat/completions": "/v1/chat/completions",
  "/v1/responses": "/v1/responses",
  "/responses": "/v1/responses",
  "/v1/messages": "/v1/messages",
  "/v1/messages/count_tokens": "/v1/messages/count_tokens",
} as const;

export function isLokiModel(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("loki/");
}

export function lokiError(c: Context, error: unknown): Response {
  const status = error instanceof LokiSignInRequired ? 401
    : error instanceof LokiUpstreamError ? error.status
    : error instanceof LokiAuthError ? 503 : 502;
  const message = error instanceof LokiSignInRequired || error instanceof LokiAuthError
    || error instanceof LokiUpstreamError ? error.message : "Loki upstream request failed.";
  // Never log arbitrary MSAL/network errors: they can contain credentials or user identifiers.
  logger.warn(`Loki request failed (HTTP ${status}).`);
  return c.json({ type: "error", error: {
    type: status === 401 ? "authentication_error" : "api_error", message,
  } }, status as ContentfulStatusCode);
}

// Run after client API-key authentication and before any Copilot protocol conversion.
// Hono caches the original body, so existing handlers can still read non-Loki bodies.
export const lokiRouting: MiddlewareHandler = async (c, next) => {
  const endpoint = endpoints[c.req.path as keyof typeof endpoints];
  if (c.req.method !== "POST" || !endpoint) return next();
  let payload: Record<string, unknown>;
  let bodySize: number;
  try {
    bodySize = (await c.req.arrayBuffer()).byteLength;
    const value: unknown = await c.req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    payload = value as Record<string, unknown>;
  } catch {
    c.res = c.json({ error: { message: "Expected a JSON object request body." } }, 400);
    return;
  }
  if (!isLokiModel(payload.model)) {
    if (!state.copilotEnabled && !(typeof payload.model === "string" && isDeepseekModel(payload.model))) {
      c.res = c.json({ error: { message: "Copilot provider is disabled. Use a loki/<model-id> model." } }, 503);
      return;
    }
    await next();
    return;
  }
  // Count original cached bytes (including whitespace/BOM), not reserialized
  // JSON or an untrusted Content-Length header. Non-Loki providers retain their
  // existing body-size behavior.
  if (bodySize > 32 * 1024 * 1024) {
    c.res = c.json({ error: { message: "Request body exceeds 32 MiB." } }, 413);
    return;
  }
  if (!payload.model.slice(5)) {
    c.res = c.json({ error: { message: "A model ID after loki/ is required." } }, 400);
    return;
  }
  if (!state.loki) {
    c.res = c.json({ error: { message: "Loki provider is disabled. Set LOKI_ENABLED=true." } }, 503);
    return;
  }
  const encoding = c.req.header("content-encoding");
  if (encoding && encoding !== "identity") {
    c.res = c.json({ error: { message: "Compressed request bodies are not supported." } }, 415);
    return;
  }
  try { await checkRateLimit(state); }
  catch (error) { c.res = await forwardError(c, error); return; }
  const startTime = Date.now();
  const context = { model: payload.model, endpoint: `loki-${endpoint.split("/").at(-1)}`,
    ip: getClientIp(c), startTime, stream: payload.stream === true };
  try {
    const response = await state.loki.forward(endpoint, { ...payload, model: payload.model.slice(5) },
      c.req.raw.headers, c.req.raw.signal, new URL(c.req.url).search);
    // count_tokens is not a generation request and must not inflate usage/cost statistics.
    c.res = endpoint.endsWith("/count_tokens") ? response : observeLokiUsage(response, context);
  } catch (error) {
    if (!endpoint.endsWith("/count_tokens")) logUsage({ ...context,
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, usage_known: false,
      duration_ms: Date.now() - startTime, ttfb_ms: 0 });
    c.res = lokiError(c, error);
  }
};
