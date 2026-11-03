import type { INetworkModule, NetworkRequestOptions, NetworkResponse } from "@azure/msal-node";
import { LokiAuthError } from "./loki-errors.js";

const identityOrigin = "https://login.microsoftonline.com";
const requestDeadline = 15_000;
const maximumBody = 1024 * 1024;
type RequestOptions = NetworkRequestOptions & { signal?: AbortSignal };

/** A deadline covers BOTH fetch (headers) and streaming/decoding the body, including POST. */
export class LokiNetworkClient implements INetworkModule {
  constructor(
    private readonly deadline = requestDeadline,
    // Transport injection is for offline tests; it does not relax the URL policy.
    private readonly transport: typeof fetch = fetch,
  ) {
    if (!Number.isSafeInteger(deadline) || deadline <= 0 || deadline > requestDeadline) {
      throw new LokiAuthError("Invalid sign-in network deadline.");
    }
  }

  sendGetRequestAsync<T>(url: string, options?: RequestOptions, timeout?: number): Promise<NetworkResponse<T>> {
    return this.request<T>(url, "GET", options, timeout);
  }

  sendPostRequestAsync<T>(url: string, options?: RequestOptions): Promise<NetworkResponse<T>> {
    return this.request<T>(url, "POST", options);
  }

  private async request<T>(url: string, method: "GET" | "POST", options?: RequestOptions, timeout?: number): Promise<NetworkResponse<T>> {
    // Never follow tenant metadata or redirects to another identity host, send
    // credentials over HTTP, or let a caller override the TLS/HTTP authority.
    let target: URL;
    try { target = new URL(url); }
    catch { throw new LokiAuthError("Untrusted sign-in network URL."); }
    if (target.origin !== identityOrigin || target.username || target.password || target.hash
      || Object.keys(options?.headers ?? {}).some((key) => ["host", ":authority"].includes(key.toLowerCase()))) {
      throw new LokiAuthError("Untrusted sign-in network URL or authority.");
    }

    const controller = new AbortController();
    const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const budget = timeout !== undefined && Number.isFinite(timeout) && timeout > 0
      ? Math.min(timeout, this.deadline) : this.deadline;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, budget);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.transport(target, {
        method, headers: options?.headers, body: method === "POST" ? options?.body ?? "" : undefined,
        redirect: "error", signal,
      });
      // Reject oversized declared bodies before buffering; also count decoded
      // stream bytes, so chunked/compressed responses cannot bypass the limit.
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) > maximumBody) throw new Error("body limit");
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > maximumBody) throw new Error("body limit");
          chunks.push(part.value);
        }
      }
      const body = JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as T;
      return { status: response.status, headers: Object.fromEntries(response.headers), body };
    } catch {
      // No URLs, request/response bodies, account identifiers, SDK diagnostics or
      // abort reasons cross this boundary (nor are they retained as Error.cause).
      throw new LokiAuthError(timedOut
        ? "Sign-in network request timed out. Check the network connection and retry."
        : "Sign-in network request failed or was cancelled. Check the network connection and retry.");
    } finally {
      clearTimeout(timer);
      // Abort on errors as well as timeouts: stop reading oversized/invalid
      // bodies and release the underlying socket, not just the caller's promise.
      controller.abort();
      reader?.releaseLock();
    }
  }
}
