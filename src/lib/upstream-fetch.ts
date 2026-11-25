import { Agent, EnvHttpProxyAgent, type Dispatcher } from "undici";

import { UpstreamHeadersTimeoutError } from "./error.js";

export const UPSTREAM_HEADERS_TIMEOUT_MS = 120_000;
/**
 * Per-chunk body silence ceiling for upstream model streams (15 minutes).
 * Node's built-in fetch uses Undici's default 300s bodyTimeout, which cuts off
 * healthy streams from models that buffer large tool-call arguments before
 * emitting a single SSE chunk. 900s clears nginx's 600s read timeout and
 * aligns with downstream clients' max idle ceiling while still reaping truly
 * wedged sockets when no client abort arrives.
 */
export const UPSTREAM_BODY_TIMEOUT_MS = 900_000;

export type UpstreamRequestInit = RequestInit & { dispatcher?: Dispatcher };

let cachedDispatcher: Dispatcher | null = null;
let cachedEnvProxyKey: string | null = null;

function envProxyCacheKey(): string {
  const useEnvProxy =
    process.env.NODE_USE_ENV_PROXY === "1" || process.execArgv.includes("--use-env-proxy");
  if (!useEnvProxy) return "direct";
  return [
    "env",
    process.env.http_proxy ?? "",
    process.env.HTTP_PROXY ?? "",
    process.env.https_proxy ?? "",
    process.env.HTTPS_PROXY ?? "",
    process.env.no_proxy ?? "",
    process.env.NO_PROXY ?? "",
  ].join("\0");
}

/**
 * Create an Undici dispatcher for upstream model requests.
 * Headers timeout is disabled here because `fetchModelUpstream` enforces
 * `UPSTREAM_HEADERS_TIMEOUT_MS` explicitly via AbortController so callers
 * always receive `UpstreamHeadersTimeoutError`.
 */
export function createUpstreamDispatcher(bodyTimeoutMs = UPSTREAM_BODY_TIMEOUT_MS): Dispatcher {
  const options = {
    headersTimeout: 0,
    bodyTimeout: bodyTimeoutMs,
  };
  const useEnvProxy =
    process.env.NODE_USE_ENV_PROXY === "1" || process.execArgv.includes("--use-env-proxy");
  return useEnvProxy ? new EnvHttpProxyAgent(options) : new Agent(options);
}

function getUpstreamDispatcher(): Dispatcher {
  const key = envProxyCacheKey();
  if (cachedDispatcher && cachedEnvProxyKey === key) {
    return cachedDispatcher;
  }
  const previous = cachedDispatcher;
  cachedDispatcher = createUpstreamDispatcher(UPSTREAM_BODY_TIMEOUT_MS);
  cachedEnvProxyKey = key;
  if (previous) {
    void previous.close().catch(() => {});
  }
  return cachedDispatcher;
}

/** Detect Undici's body-silence timeout anywhere in an error's cause chain. */
export function isUpstreamBodyTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const candidate = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (candidate.code === "UND_ERR_BODY_TIMEOUT" || candidate.name === "BodyTimeoutError") {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/** Bound the wait for upstream headers without timing out the response body at 300s. */
export async function fetchModelUpstream(
  url: string,
  init: UpstreamRequestInit
): Promise<Response> {
  const controller = new AbortController();
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => {
    controller.abort(new UpstreamHeadersTimeoutError(UPSTREAM_HEADERS_TIMEOUT_MS));
  }, UPSTREAM_HEADERS_TIMEOUT_MS);
  const dispatcher = init.dispatcher ?? getUpstreamDispatcher();

  try {
    return await fetch(url, { ...init, signal, dispatcher } as RequestInit);
  } finally {
    // fetch resolves at headers. Do not abort a body (including SSE) after this point.
    clearTimeout(timer);
  }
}
