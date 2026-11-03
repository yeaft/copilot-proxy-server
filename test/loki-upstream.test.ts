import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";

import { LokiProvider, LokiUpstreamError, type LokiTokenSource } from "../src/services/loki.js";

const routes = {
  "/v1/chat/completions": "chat/completions",
  "/v1/responses": "responses",
  "/v1/messages": "v1/messages",
  "/v1/messages/count_tokens": "v1/messages/count_tokens",
} as const;
const catalog = [{ id: "Claude-Opus-4.6", name: "Opus", capabilities: { tools: true } }];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "condition did not become true");
    await delay(5);
  }
}

async function fixture(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  options: { catalogTtlMs?: number; idleTimeoutMs?: number; tokens?: LokiTokenSource } = {},
) {
  const requests: { path: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> }[] = [];
  const refreshes: boolean[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({ path: req.url!, headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {} });
      await handler(req, res);
    } catch {
      res.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/llmapi/`;
  const provider = new LokiProvider({
    environment: "prod", baseUrl,
    tokens: options.tokens ?? { getToken: async (force = false) => {
      refreshes.push(force);
      return force ? "mock-renewed-ms-token" : "mock-ms-token";
    } },
    ...options,
  });
  return { provider, requests, refreshes, baseUrl };
}

function models(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.url !== "/api/v1/llmapi/models") return false;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ data: catalog }));
  return true;
}

for (const [endpoint, path] of Object.entries(routes)) {
  test(`Loki forwards ${endpoint} natively without changing protocol fields`, async (t) => {
    const { provider, requests } = await fixture(t, (req, res) => {
      if (models(req, res)) return;
      res.setHeader("content-type", "application/json");
      res.end('{"type":"native-result","usage":{"input_tokens":3},"opaque":[1,null]}');
    });
    const payload = {
      model: "Claude-Opus-4.6", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      input: [{ role: "user", content: "keep responses input" }], max_tokens: 17,
      max_output_tokens: 19, stream: false, tools: [{ type: "custom", nested: { untouched: true } }],
      metadata: { trace: "opaque", model: "not-an-alias" }, unknown_future_field: { enabled: true },
    };
    const response = await provider.forward(endpoint as keyof typeof routes, payload, undefined, undefined, "?api-version=next&x=1&x=2");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"type":"native-result","usage":{"input_tokens":3},"opaque":[1,null]}');
    assert.equal(requests.at(-1)!.path, `/api/v1/llmapi/${path}?api-version=next&x=1&x=2`);
    assert.deepEqual(requests.at(-1)!.body, payload);
    assert.equal(payload.model, "Claude-Opus-4.6");
  });
}

test("Loki catalog is singleflight, retains metadata, and serves stale while revalidating", async (t) => {
  let hits = 0;
  let completeRefresh: (() => void) | undefined;
  const { provider } = await fixture(t, async (_req, res) => {
    hits++;
    if (hits === 1) await delay(20);
    else await new Promise<void>((resolve) => { completeRefresh = resolve; });
    res.end(JSON.stringify({ models: hits === 1 ? catalog : [{ id: "new-model" }] }));
  }, { catalogTtlMs: 40 });
  const initial = await Promise.all(Array.from({ length: 12 }, () => provider.getModels()));
  assert.equal(hits, 1);
  assert.deepEqual(initial[0], [{ id: catalog[0].id, name: "Opus", metadata: catalog[0] }]);
  await provider.getModels();
  assert.equal(hits, 1);
  await delay(50);
  const stale = await Promise.all(Array.from({ length: 12 }, () => provider.getModels()));
  assert.equal(stale[0][0].id, "Claude-Opus-4.6");
  await until(() => hits === 2);
  assert.equal(hits, 2);
  completeRefresh!();
  await until(asyncFlag(() => provider.getModels(), (value) => value[0]?.id === "new-model"));
});

// A synchronous polling predicate for an asynchronous cache read.
function asyncFlag<T>(read: () => Promise<T>, check: (value: T) => boolean): () => boolean {
  let done = false;
  let pending = false;
  return () => {
    if (!pending && !done) {
      pending = true;
      void read().then((value) => { done = check(value); }).finally(() => { pending = false; });
    }
    return done;
  };
}

test("Loki default catalog TTL is five minutes and an empty catalog is cached", async (t) => {
  let hits = 0;
  const { provider } = await fixture(t, (_req, res) => { hits++; res.end("[]"); });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  assert.deepEqual(await provider.getModels(), []);
  now += 299_999;
  assert.deepEqual(await provider.getModels(), []);
  assert.equal(hits, 1);
  now += 1;
  assert.deepEqual(await provider.getModels(), []);
  await until(() => hits === 2);
});

test("Loki alias normalization rewrites only a unique match and never mutates the payload", async (t) => {
  const { provider, requests } = await fixture(t, (req, res) => {
    if (req.url!.endsWith("/models")) {
      res.end(JSON.stringify([...catalog, { id: "ambig-1.0" }, { id: "ambig1-0" }]));
    } else res.end("{}");
  });
  for (const [input, expected] of [
    ["claude.opus4-6", "Claude-Opus-4.6"], ["ambig1.0", "ambig1.0"],
    ["ambig-1.0", "ambig-1.0"], ["unknown", "unknown"], ["claude_opus4_6", "claude_opus4_6"],
  ]) {
    const payload = { model: input, nested: { model: "claude.opus4-6" } };
    await (await provider.forward("/v1/messages", payload)).text();
    assert.equal(requests.at(-1)!.body.model, expected);
    assert.deepEqual(requests.at(-1)!.body.nested, payload.nested);
    assert.equal(payload.model, input);
  }
});

test("Loki catalog failure keeps stale models and cold forwarding degrades to the original ID", async (t) => {
  let fail = false;
  let hits = 0;
  const { provider } = await fixture(t, (req, res) => {
    if (req.url!.endsWith("/models")) {
      hits++;
      if (fail) { res.writeHead(503); res.end("private-upstream-error mock-ms-token"); }
      else res.end(JSON.stringify(catalog));
    } else res.end("{}");
  }, { catalogTtlMs: 15 });
  await provider.getModels();
  fail = true;
  await delay(25);
  assert.equal((await provider.getModels())[0].id, catalog[0].id);
  await until(() => hits >= 2);
  await delay(10);
  assert.equal((await provider.getModels())[0].id, catalog[0].id);
  const cold = await fixture(t, (_req, res) => { res.writeHead(503); res.end("private-data"); });
  await assert.rejects(cold.provider.getModels(), (error: unknown) => error instanceof LokiUpstreamError && error.status === 503 && !error.message.includes("private"));
  const fallback = await fixture(t, (req, res) => {
    if (req.url!.endsWith("/models")) { res.writeHead(503); res.end("private-data"); }
    else res.end("native-body");
  });
  assert.equal(await (await fallback.provider.forward("/v1/responses", { model: "opaque.model" })).text(), "native-body");
  assert.equal(fallback.requests.at(-1)!.body.model, "opaque.model");
});

for (const invalid of ['{"data":[{"name":"missing ID"}]}', '{"unexpected":[]}', 'not JSON']) {
  test(`Loki rejects invalid catalog safely: ${invalid}`, async (t) => {
    const { provider } = await fixture(t, (_req, res) => { res.end(invalid); });
    await assert.rejects(provider.getModels(), (error: unknown) => error instanceof LokiUpstreamError && !error.message.includes(invalid));
  });
}

for (const resource of ["catalog", "forward"] as const) {
  for (const finalStatus of [200, 401]) {
    test(`Loki ${resource} cleans 401 and force-refreshes only once (final ${finalStatus})`, async (t) => {
      let attempts = 0;
      let firstClosed = false;
      const { provider, refreshes, requests } = await fixture(t, (req, res) => {
        if (resource === "forward" && models(req, res)) return;
        attempts++;
        if (attempts === 1 || finalStatus === 401) {
          res.writeHead(401);
          res.flushHeaders();
          res.write("never-ending rejected body");
          res.once("close", () => { firstClosed = true; });
          if (attempts > 1) res.end();
        } else res.end(resource === "catalog" ? JSON.stringify(catalog) : "native-success");
      }, { tokens: { getToken: async (force = false) => {
        refreshes.push(force);
        if (force) await until(() => firstClosed);
        return force ? "mock-renewed-ms-token" : "mock-ms-token";
      } } });
      if (resource === "catalog") {
        if (finalStatus === 401) await assert.rejects(provider.getModels(), (error: unknown) => error instanceof LokiUpstreamError && error.status === 401);
        else assert.equal((await provider.getModels())[0].id, catalog[0].id);
      } else {
        const result = await provider.forward("/v1/messages", { model: catalog[0].id });
        assert.equal(result.status, finalStatus);
        await result.text();
      }
      assert.equal(attempts, 2);
      assert.deepEqual(refreshes.filter(Boolean), [true]);
      assert.equal(requests.at(-1)!.headers.authorization, "Bearer mock-renewed-ms-token");
    });
  }
}

test("Loki strips client credentials, routing/IP and hop headers but preserves Anthropic protocol headers", async (t) => {
  const { provider, requests } = await fixture(t, (req, res) => {
    if (models(req, res)) return;
    res.writeHead(200, {
      connection: "keep-alive, x-response-hop", "x-response-hop": "remove", "set-cookie": "session=secret",
      "content-length": "2", "x-request-id": "preserve-me", "content-type": "application/json",
    });
    res.end("{}");
  });
  const sensitive = ["api-key", "x-api-key", "x-goog-api-key", "x-auth-token", "cookie", "cookie2", "proxy-authorization", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "client-ip", "x-client-ip", "true-client-ip", "cf-connecting-ip", "x-original-host", "via"];
  const headers = new Headers({
    authorization: "Bearer client-secret", connection: "keep-alive, x-custom-hop", "x-custom-hop": "remove",
    "proxy-connection": "keep-alive", "keep-alive": "timeout=10", te: "trailers", trailer: "x-trailer",
    "transfer-encoding": "chunked", upgrade: "websocket", host: "untrusted.invalid", "content-length": "999",
    "accept-encoding": "gzip, br", "content-encoding": "gzip", "anthropic-beta": "tools-2026-01-01",
    "anthropic-version": "2023-06-01", "x-safe-feature": "keep", "x-session-id": "stable-session",
    "x-clienttype": "untrusted", "x-clientcorrelationid": "untrusted",
  });
  for (const name of sensitive) headers.set(name, "private-client-data");
  const response = await provider.forward("/v1/messages/count_tokens", { model: catalog[0].id }, headers);
  assert.equal(await response.text(), "{}");
  const sent = requests.at(-1)!.headers;
  assert.equal(sent.authorization, "Bearer mock-ms-token");
  for (const name of [...sensitive, "x-custom-hop", "proxy-connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "content-encoding"]) assert.equal(sent[name], undefined, name);
  assert.notEqual(sent.host, "untrusted.invalid");
  assert.equal(sent["content-length"], String(Buffer.byteLength(JSON.stringify({ model: catalog[0].id }))));
  assert.equal(sent["accept-encoding"], "identity");
  assert.equal(sent["content-type"], "application/json");
  assert.equal(sent["anthropic-beta"], "tools-2026-01-01");
  assert.equal(sent["anthropic-version"], "2023-06-01");
  assert.equal(sent["x-safe-feature"], "keep");
  assert.equal(sent["x-clienttype"], "GitHub");
  assert.equal(sent["x-clientversion"], "1.0.101");
  assert.equal(sent["x-clientscenario"], "Code");
  assert.equal(sent["x-clientfeature"], "LlmApiProxy");
  assert.equal(sent["x-llm-api-version"], "2026-09-28");
  for (const name of ["x-clientcorrelationid", "x-clientcallid", "x-conversationid"]) assert.match(String(sent[name]), /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
  assert.equal(sent["x-initiator"], "user");
  assert.equal(sent["x-interaction-type"], "conversation-user");
  for (const name of ["connection", "keep-alive", "x-response-hop", "set-cookie", "content-length", "transfer-encoding"]) assert.equal(response.headers.get(name), null);
  assert.equal(response.headers.get("x-request-id"), "preserve-me");
  await (await provider.forward("/v1/messages", { model: catalog[0].id }, headers)).text();
  assert.equal(requests.at(-1)!.headers["x-conversationid"], sent["x-conversationid"]);
  assert.notEqual(requests.at(-1)!.headers["x-clientcallid"], sent["x-clientcallid"]);
});

test("Loki preserves incremental SSE bytes, including split UTF-8 and event boundaries", async (t) => {
  let finish: (() => void) | undefined;
  const bytes = Buffer.from('event: message_start\r\ndata: {"text":"你好🌍"}\r\n\r\n: heartbeat\n\ndata: [DONE]\n\n');
  const { provider } = await fixture(t, async (req, res) => {
    if (models(req, res)) return;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(bytes.subarray(0, 42));
    await new Promise<void>((resolve) => { finish = resolve; });
    for (let i = 42; i < bytes.length; i += 3) { res.write(bytes.subarray(i, i + 3)); await delay(1); }
    res.end();
  });
  const response = await provider.forward("/v1/messages", { model: catalog[0].id, stream: true });
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.deepEqual(Buffer.from(first.value!), bytes.subarray(0, 42));
  finish!();
  const chunks = [Buffer.from(first.value!)];
  for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
  assert.deepEqual(Buffer.concat(chunks), bytes);
});

test("Loki keeps compressed bytes and encoding paired while removing response framing", async (t) => {
  const compressed = gzipSync(Buffer.from("data: native-event\n\n"));
  const { provider } = await fixture(t, (req, res) => {
    if (models(req, res)) return;
    res.writeHead(200, { "content-encoding": "gzip", "content-length": String(compressed.length), "content-type": "text/event-stream" });
    res.end(compressed);
  });
  const response = await provider.forward("/v1/responses", { model: catalog[0].id });
  assert.equal(response.headers.get("content-encoding"), "gzip");
  assert.equal(response.headers.get("content-length"), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), compressed);
});

for (const mechanism of ["signal", "body.cancel"] as const) {
  test(`Loki ${mechanism} cancels the upstream stream`, async (t) => {
    let closed = false;
    const { provider } = await fixture(t, (req, res) => {
      if (models(req, res)) return;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      res.once("close", () => { closed = true; });
    });
    const abort = new AbortController();
    const response = await provider.forward("/v1/messages", { model: catalog[0].id }, undefined, abort.signal);
    if (mechanism === "signal") {
      abort.abort(new Error("client-secret abort reason"));
      await assert.rejects(response.text(), (error: unknown) => error instanceof LokiUpstreamError && !error.message.includes("client-secret"));
    } else await response.body!.cancel();
    await until(() => closed);
  });
}

test("Loki cancellation before response headers closes upstream and does not retry", async (t) => {
  let closed = false;
  let arrived = false;
  const { provider, requests } = await fixture(t, (req, res) => {
    if (models(req, res)) return;
    arrived = true;
    res.once("close", () => { closed = true; });
  });
  await provider.getModels();
  const abort = new AbortController();
  const pending = provider.forward("/v1/messages", { model: catalog[0].id }, undefined, abort.signal);
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof LokiUpstreamError && error.status === 499);
  await until(() => arrived);
  abort.abort();
  await rejected;
  await until(() => closed);
  assert.equal(requests.filter((req) => !req.path.endsWith("/models")).length, 1);
});

test("Loki a pre-aborted client makes no catalog, token, or upstream request", async (t) => {
  let tokenCalls = 0;
  const { provider, requests } = await fixture(t, (_req, res) => { res.end("[]"); }, { tokens: { getToken: async () => { tokenCalls++; return "mock"; } } });
  await assert.rejects(provider.forward("/v1/responses", { model: "test" }, undefined, AbortSignal.abort()), (error: unknown) => error instanceof LokiUpstreamError && error.status === 499);
  assert.equal(tokenCalls, 0);
  assert.equal(requests.length, 0);
});

test("Loki abort while awaiting a shared catalog does not block or cancel other callers", async (t) => {
  let requested = false;
  let finish: (() => void) | undefined;
  const { provider, requests } = await fixture(t, async (_req, res) => {
    requested = true;
    await new Promise<void>((resolve) => { finish = resolve; });
    res.end(JSON.stringify(catalog));
  });
  const abort = new AbortController();
  const pending = provider.forward("/v1/messages", { model: catalog[0].id }, undefined, abort.signal);
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof LokiUpstreamError && error.status === 499);
  const shared = provider.getModels();
  await until(() => requested);
  abort.abort();
  await rejected;
  finish!();
  assert.equal((await shared)[0].id, catalog[0].id);
  assert.equal(requests.length, 1);
});

test("Loki abort during forced token refresh prevents the second upstream attempt", async (t) => {
  let refreshing = false;
  let complete: (() => void) | undefined;
  const { provider, requests } = await fixture(t, (req, res) => {
    if (models(req, res)) return;
    res.writeHead(401);
    res.end("unauthorized");
  }, { tokens: { getToken: async (force = false) => {
    if (force) {
      refreshing = true;
      await new Promise<void>((resolve) => { complete = resolve; });
    }
    return "mock-token";
  } } });
  const abort = new AbortController();
  const pending = provider.forward("/v1/messages", { model: catalog[0].id }, undefined, abort.signal);
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof LokiUpstreamError && error.status === 499);
  await until(() => refreshing);
  abort.abort();
  await rejected;
  complete!();
  await delay(10);
  assert.equal(requests.filter((req) => !req.path.endsWith("/models")).length, 1);
});

for (const phase of ["headers", "body"] as const) {
  test(`Loki idle timeout covers ${phase} and closes upstream`, async (t) => {
    let closed = false;
    const { provider } = await fixture(t, (req, res) => {
      if (models(req, res)) return;
      if (phase === "body") { res.writeHead(200); res.write("data: first\n\n"); }
      res.once("close", () => { closed = true; });
    }, { idleTimeoutMs: 70 });
    await assert.rejects(async () => {
      const response = await provider.forward("/v1/messages", { model: catalog[0].id });
      await response.text();
    }, (error: unknown) => error instanceof LokiUpstreamError && error.status === 504 && /idle/i.test(error.message));
    await until(() => closed);
  });
}

test("Loki catalog discovery also enforces idle timeout while reading a partial JSON body", async (t) => {
  let closed = false;
  const { provider } = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"data":[');
    res.once("close", () => { closed = true; });
  }, { idleTimeoutMs: 70 });
  await assert.rejects(provider.getModels(), (error: unknown) => error instanceof LokiUpstreamError && error.status === 504);
  await until(() => closed);
});

test("Loki upstream disconnect after headers errors the Web stream without leaking details", async (t) => {
  let disconnect: (() => void) | undefined;
  const { provider } = await fixture(t, (req, res) => {
    if (models(req, res)) return;
    res.writeHead(200);
    res.write("data: first\n\n");
    disconnect = () => res.destroy(new Error("private-ms-token"));
  });
  const response = await provider.forward("/v1/messages", { model: catalog[0].id });
  const pending = assert.rejects(response.text(), (error: unknown) => error instanceof LokiUpstreamError && error.status === 502 && !error.message.includes("private"));
  disconnect!();
  await pending;
});

for (const status of [204, 205]) {
  test(`Loki preserves bodyless HTTP ${status} responses`, async (t) => {
    const { provider } = await fixture(t, (req, res) => {
      if (models(req, res)) return;
      res.writeHead(status);
      res.end();
    });
    const response = await provider.forward("/v1/responses", { model: catalog[0].id });
    assert.equal(response.status, status);
    assert.equal(response.body, null);
  });
}

test("Loki active streaming can exceed the idle timeout many times", async (t) => {
  const { provider } = await fixture(t, async (req, res) => {
    if (models(req, res)) return;
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < 12; i++) { res.write(`data: ${i}\n\n`); await delay(25); }
    res.end("data: [DONE]\n\n");
  }, { idleTimeoutMs: 100 });
  const response = await provider.forward("/v1/chat/completions", { model: catalog[0].id, stream: true });
  const text = await response.text();
  assert.ok(text.includes("data: 11\n\n"));
  assert.ok(text.endsWith("data: [DONE]\n\n"));
});

test("Loki rejects redirects without visiting their target or exposing the token", async (t) => {
  let redirected = 0;
  const sink = await fixture(t, (_req, res) => { redirected++; res.end("leaked"); });
  const { provider } = await fixture(t, (req, res) => {
    if (models(req, res)) return;
    res.writeHead(307, { location: `${sink.baseUrl}?token=private-redirect` });
    res.end("private-upstream-error");
  });
  await assert.rejects(provider.forward("/v1/messages", { model: catalog[0].id }), (error: unknown) => error instanceof LokiUpstreamError && error.status === 502 && !error.message.includes("private"));
  assert.equal(redirected, 0);
  const redirectedCatalog = await fixture(t, (_req, res) => { res.writeHead(302, { location: sink.baseUrl }); res.end(); });
  await assert.rejects(redirectedCatalog.provider.getModels(), LokiUpstreamError);
  assert.equal(redirected, 0);
});

test("Loki sanitizes token source failures and transport disconnect errors", async (t) => {
  const auth = await fixture(t, (_req, res) => { res.end("[]"); }, { tokens: { getToken: async () => { throw new Error("mock-ms-token private-auth-URL"); } } });
  await assert.rejects(auth.provider.getModels(), (error: unknown) => error instanceof LokiUpstreamError && !/mock-ms-token|private-auth/.test(error.message));
  const transport = await fixture(t, (req, res) => {
    if (models(req, res)) return;
    res.destroy(new Error("mock-ms-token private-upstream-URL"));
  });
  await assert.rejects(transport.provider.forward("/v1/responses", { model: catalog[0].id }), (error: unknown) => error instanceof LokiUpstreamError && error.status === 502 && !/mock-ms-token|private-upstream/.test(error.message));
});
