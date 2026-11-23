import { UpstreamHeadersTimeoutError } from "./error.js";

const UPSTREAM_HEADERS_TIMEOUT_MS = 120_000;

/** Bound the wait for upstream headers without timing out the response body. */
export async function fetchModelUpstream(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => {
    controller.abort(new UpstreamHeadersTimeoutError(UPSTREAM_HEADERS_TIMEOUT_MS));
  }, UPSTREAM_HEADERS_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal });
  } finally {
    // fetch resolves at headers. Do not abort a body (including SSE) after this point.
    clearTimeout(timer);
  }
}
