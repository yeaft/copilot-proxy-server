import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

export interface LokiTokenSource {
  getToken(forceRefresh?: boolean): Promise<string>;
}

export type LokiEnvironment = "prod" | "msit" | "sdf";

export interface LokiModel {
  id: string;
  name: string;
  metadata: Record<string, unknown>;
}

export class LokiUpstreamError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "LokiUpstreamError";
  }
}

interface LokiProviderOptions {
  tokens: LokiTokenSource;
  environment: LokiEnvironment;
  baseUrl?: string;
  catalogTtlMs?: number;
  idleTimeoutMs?: number;
}

const bases: Record<LokiEnvironment, string> = {
  prod: "https://loki.delve.office.com/api/v1/llmapi/",
  msit: "https://msit.loki.delve.office.com/api/v1/llmapi/",
  sdf: "https://df.loki.delve.office.com/api/v1/llmapi/",
};

const routes = {
  "/v1/chat/completions": "chat/completions",
  "/v1/responses": "responses",
  "/v1/messages": "v1/messages",
  "/v1/messages/count_tokens": "v1/messages/count_tokens",
} as const;

type LokiEndpoint = keyof typeof routes;

const hopByHop = new Set([
  "connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);
const credentials = new Set([
  "authorization", "api-key", "x-api-key", "cookie", "cookie2", "set-cookie", "set-cookie2",
  "ocp-apim-subscription-key",
]);
const clientAddress = new Set([
  "forwarded", "via", "x-real-ip", "client-ip", "x-client-ip", "true-client-ip",
  "cf-connecting-ip", "fastly-client-ip", "x-cluster-client-ip", "x-envoy-external-address",
]);

function connectionFields(headers: Headers): Set<string> {
  return new Set((headers.get("connection") ?? "").toLowerCase().split(",").map((name) => name.trim()));
}

function isCredential(name: string): boolean {
  return credentials.has(name) || /(?:^|-)(?:api-?key|token|secret|authorization)(?:$|-)/.test(name);
}

function requestHeaders(source: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  const connection = connectionFields(source);
  source.forEach((value, name) => {
    if (hopByHop.has(name) || connection.has(name) || isCredential(name) || clientAddress.has(name)
      || name.startsWith("x-forwarded-") || name.startsWith("x-original-")) return;
    headers[name] = value;
  });
  // The caller provided a JSON object, not the original encoded request body.
  delete headers["content-encoding"];
  headers["content-type"] = "application/json";
  headers["accept-encoding"] = "identity";
  return headers;
}

function nativeHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "x-clienttype": "GitHub",
    "x-clientversion": "1.0.101",
    "x-clientscenario": "Code",
    "x-clientfeature": "LlmApiProxy",
    "x-llm-api-version": "2026-09-28",
    "x-clientcorrelationid": randomUUID(),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModels(value: unknown): LokiModel[] {
  const items = Array.isArray(value) ? value : isObject(value) ? value.data ?? value.models : undefined;
  if (!Array.isArray(items)) throw new LokiUpstreamError(502, "Loki returned an invalid model catalog.");
  return items.map((item: unknown) => {
    if (!isObject(item) || typeof item.id !== "string" || !item.id) {
      throw new LokiUpstreamError(502, "Loki returned an invalid model catalog entry.");
    }
    return { id: item.id, name: typeof item.name === "string" ? item.name : item.id, metadata: item };
  });
}

function normalizedModel(id: string): string {
  return id.toLowerCase().replace(/[.-]/g, "");
}

function sessionGuid(session: string): string {
  const hex = createHash("sha256").update(session).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function conversationId(headers: Record<string, string>, payload: Record<string, unknown>): string {
  for (const header of ["x-session-id", "session_id", "x-client-session-id", "x-conversation-id"]) {
    if (headers[header]) return sessionGuid(headers[header]);
  }
  if (isObject(payload.metadata) && typeof payload.metadata.user_id === "string") {
    const user = payload.metadata.user_id;
    if (user.startsWith("{")) {
      try {
        const metadata: unknown = JSON.parse(user);
        if (isObject(metadata) && typeof metadata.session_id === "string" && metadata.session_id) {
          return sessionGuid(metadata.session_id);
        }
      } catch {
        // Opaque user IDs are not necessarily session identifiers.
      }
    }
    const session = /(?:^|_)session_([a-zA-Z0-9-]+)$/.exec(user)?.[1];
    if (session) return sessionGuid(session);
  }
  return randomUUID();
}

function cancelled(): LokiUpstreamError {
  return new LokiUpstreamError(499, "Loki request was cancelled.");
}

// Cancel a caller's wait without cancelling a catalog refresh shared by other callers.
function withAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export class LokiProvider {
  private readonly base: URL;
  private readonly tokens: LokiTokenSource;
  private readonly catalogTtlMs: number;
  private readonly idleTimeoutMs: number;
  private catalog: LokiModel[] | undefined;
  private catalogAt = 0;
  private loading: Promise<LokiModel[]> | undefined;

  constructor(options: LokiProviderOptions) {
    try {
      this.base = new URL(options.baseUrl ?? bases[options.environment]);
      if (!["http:", "https:"].includes(this.base.protocol) || this.base.username || this.base.password
        || this.base.search || this.base.hash) throw new Error("Invalid base URL");
      if (!this.base.pathname.endsWith("/")) this.base.pathname += "/";
    } catch {
      throw new LokiUpstreamError(500, "Invalid Loki upstream configuration.");
    }
    this.tokens = options.tokens;
    this.catalogTtlMs = options.catalogTtlMs ?? 300_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
    if (!Number.isFinite(this.catalogTtlMs) || this.catalogTtlMs < 0
      || !Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs <= 0) {
      throw new LokiUpstreamError(500, "Invalid Loki timeout configuration.");
    }
  }

  async getModels(): Promise<LokiModel[]> {
    if (this.catalog === undefined) return this.refreshCatalog();
    if (Date.now() - this.catalogAt >= this.catalogTtlMs) {
      void this.refreshCatalog().catch(() => { /* Keep serving the last successful catalog. */ });
    }
    return this.catalog;
  }

  private refreshCatalog(): Promise<LokiModel[]> {
    this.loading ??= this.loadModels().then((models) => {
      this.catalog = models;
      this.catalogAt = Date.now();
      return models;
    }).finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async loadModels(): Promise<LokiModel[]> {
    const response = await this.authenticatedRequest(new URL("models", this.base), "GET", {});
    if (!response.ok) {
      await response.body?.cancel();
      throw new LokiUpstreamError(response.status, `Loki model discovery failed (HTTP ${response.status}).`);
    }
    try {
      return parseModels(await response.json());
    } catch (error) {
      if (error instanceof LokiUpstreamError) throw error;
      throw new LokiUpstreamError(502, "Loki returned an invalid model catalog.");
    }
  }

  async forward(
    endpoint: LokiEndpoint,
    payload: Record<string, unknown>,
    headers: Headers = new Headers(),
    signal?: AbortSignal,
    search = "",
  ): Promise<Response> {
    if (signal?.aborted) throw cancelled();
    if (!Object.hasOwn(routes, endpoint)) throw new LokiUpstreamError(404, "Unknown Loki endpoint.");
    if (typeof payload.model !== "string" || !payload.model) {
      throw new LokiUpstreamError(400, "A Loki model ID is required.");
    }
    if (search && !search.startsWith("?")) throw new LokiUpstreamError(400, "Invalid Loki query string.");
    let catalog: LokiModel[] = [];
    try {
      catalog = await withAbort(this.getModels(), signal);
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      // Discovery is an optimization for aliases, not a dependency of the native APIs.
      if (error instanceof LokiUpstreamError && error.status === 401) throw error;
    }
    if (signal?.aborted) throw cancelled();
    let model = payload.model;
    if (!catalog.some((entry) => entry.id === model)) {
      const matches = catalog.filter((entry) => normalizedModel(entry.id) === normalizedModel(model));
      if (matches.length === 1) model = matches[0].id;
    }
    let body: Buffer;
    try {
      body = Buffer.from(JSON.stringify({ ...payload, model }));
    } catch {
      throw new LokiUpstreamError(400, "Expected a JSON-compatible Loki payload.");
    }
    const outgoing = requestHeaders(headers);
    outgoing["content-length"] = String(body.length);
    outgoing["x-conversationid"] ??= conversationId(outgoing, payload);
    outgoing["x-clientcallid"] ??= randomUUID();
    outgoing["x-initiator"] ??= "user";
    outgoing["x-interaction-type"] ??= "conversation-user";
    const target = new URL(routes[endpoint], this.base);
    target.search = search;
    return this.authenticatedRequest(target, "POST", outgoing, body, signal);
  }

  private async authenticatedRequest(
    target: URL,
    method: "GET" | "POST",
    headers: Record<string, string>,
    body?: Buffer,
    signal?: AbortSignal,
  ): Promise<Response> {
    for (const forceRefresh of [false, true]) {
      if (signal?.aborted) throw cancelled();
      let token: string;
      try {
        token = await withAbort(this.tokens.getToken(forceRefresh), signal);
      } catch {
        if (signal?.aborted) throw cancelled();
        throw new LokiUpstreamError(401, "Microsoft Loki authentication failed.");
      }
      if (signal?.aborted) throw cancelled();
      const response = await this.request(target, method, {
        ...headers, ...nativeHeaders(token), "accept-encoding": "identity",
      }, body, signal);
      if (response.status !== 401 || forceRefresh) return response;
      // Dispose even an unbounded rejection body before acquiring a new MS token.
      await response.body?.cancel();
    }
    throw new LokiUpstreamError(401, "Microsoft Loki authentication failed.");
  }

  private request(
    target: URL,
    method: "GET" | "POST",
    headers: Record<string, string>,
    body?: Buffer,
    signal?: AbortSignal,
  ): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      let request: ClientRequest | undefined;
      let incoming: IncomingMessage | undefined;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let resolved = false;
      let finished = false;
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const stop = () => {
        finished = true;
        cleanup();
        incoming?.destroy();
        request?.destroy();
      };
      const fail = (error: LokiUpstreamError) => {
        if (finished) return;
        stop();
        if (resolved) controller?.error(error);
        else reject(error);
      };
      const abort = () => fail(cancelled());
      const touch = () => {
        if (finished) return;
        clearTimeout(timer);
        // An inactivity watchdog, not a total lifetime limit: active SSE may run indefinitely.
        timer = setTimeout(() => fail(new LokiUpstreamError(504, "Loki upstream idle timeout.")), this.idleTimeoutMs);
        timer.unref();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      touch(); // Covers connection establishment and waiting for response headers as well as the body.
      try {
        request = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method, headers }, (response) => {
          incoming = response;
          if (finished) { response.destroy(); return; }
          touch();
          const status = response.statusCode ?? 502;
          // Never follow redirects with the Microsoft token, including same-origin redirects.
          if (status >= 300 && status < 400) {
            fail(new LokiUpstreamError(502, "Loki upstream redirects are not allowed."));
            return;
          }
          const source = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined) source.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          const connection = connectionFields(source);
          const outgoing = new Headers();
          source.forEach((value, name) => {
            if (!hopByHop.has(name) && !connection.has(name) && !isCredential(name)) outgoing.set(name, value);
          });
          response.on("error", () => fail(new LokiUpstreamError(502, "Loki upstream stream failed.")));
          response.on("aborted", () => fail(new LokiUpstreamError(502, "Loki upstream stream ended unexpectedly.")));
          response.on("end", () => {
            if (finished) return;
            finished = true;
            cleanup();
            controller?.close();
          });
          if (status === 204 || status === 205) {
            resolved = true;
            resolve(new Response(null, { status, headers: outgoing }));
            response.resume();
            return;
          }
          // Node HTTP does not decompress. Preserve content-encoding alongside the exact bytes,
          // but remove content-length/transfer-encoding because the downstream reframes this stream.
          const stream = new ReadableStream<Uint8Array>({
            start: (destination) => {
              controller = destination;
              response.pause();
              response.on("data", (chunk: Buffer) => {
                if (finished) return;
                touch();
                destination.enqueue(new Uint8Array(chunk));
                if ((destination.desiredSize ?? 0) <= 0) response.pause();
              });
            },
            pull: () => { if (!finished) response.resume(); },
            cancel: () => { if (!finished) stop(); },
          });
          resolved = true;
          resolve(new Response(stream, { status, headers: outgoing }));
        });
        request.on("error", () => fail(new LokiUpstreamError(502, "Loki upstream connection failed.")));
        request.once("finish", touch);
        request.end(body);
      } catch {
        fail(new LokiUpstreamError(502, "Loki upstream connection failed."));
      }
    });
  }
}
