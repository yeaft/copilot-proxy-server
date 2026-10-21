import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { brotliCompressSync, constants, createGzip, deflateSync, gzipSync } from "node:zlib";
import * as zlib from "node:zlib";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { state } from "../src/lib/state.js";
import { completionRoutes } from "../src/routes/chat-completions/route.js";
import { messageRoutes } from "../src/routes/messages/route.js";
import { responsesRoutes } from "../src/routes/responses/route.js";
import { createDeepseekCompletion } from "../src/services/deepseek-completions.js";

const endpoints = ["/v1/chat/completions", "/v1/messages", "/v1/responses"] as const;
const encodings = ["br", "gzip", "x-gzip", "deflate", "gzip, br", "identity"] as const;
const originalHost = process.env.DEEPSEEK_HOST;
const originalKey = state.deepseekApiKey;
let upstream: Server;
let proxy: ReturnType<typeof serve>;
let proxyUrl: string;
let lastRequest: { path: string; payload: unknown; auth?: string };
let finishStream: (() => void) | undefined;

function encodeBody(body: Buffer, encoding: string): Buffer {
  switch (encoding) {
    case "br": return brotliCompressSync(body);
    case "gzip":
    case "x-gzip": return gzipSync(body);
    case "deflate": return deflateSync(body);
    case "gzip, br": return brotliCompressSync(gzipSync(body));
    case "zstd": return zlib.zstdCompressSync(body);
    default: return body;
  }
}

function responseText(stream: boolean, status = 200): string {
  if (status !== 200) return JSON.stringify({ error: { message: "Rate limited" } });
  return stream
    ? 'event: response.completed\ndata: {"type":"response.completed","text":"OK"}\n\n'
    : JSON.stringify({ id: "test-response", text: "OK" });
}

before(async () => {
  upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    lastRequest = {
      path: req.url!,
      payload,
      auth: req.url === "/v1/messages" ? String(req.headers["x-api-key"]) : req.headers.authorization,
    };
    const status = payload.test_status ?? 200;
    const text = Buffer.from(responseText(payload.stream, status));
    const encoding = payload.test_encoding ?? "br";
    const body = encodeBody(text, encoding);
    res.writeHead(status, {
      "content-type": payload.stream && status === 200 ? "text/event-stream" : "application/json",
      ...(encoding !== "identity" ? { "content-encoding": encoding } : {}),
      ...(payload.stream ? {} : { "content-length": String(body.length) }),
      connection: "keep-alive, x-upstream-hop",
      "keep-alive": "timeout=5",
      "x-upstream-hop": "must-not-be-forwarded",
      "x-request-id": "deepseek-test-request",
      "cache-control": "no-cache",
      ...(status === 429 ? { "retry-after": "10" } : {}),
    });
    if (payload.test_incremental) {
      const compressor = createGzip();
      compressor.pipe(res);
      res.on("close", () => compressor.destroy());
      finishStream = () => compressor.end("data: last chunk\n\n");
      compressor.write("data: first chunk\n\n");
      compressor.flush(constants.Z_SYNC_FLUSH);
      return;
    }
    res.end(body);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  process.env.DEEPSEEK_HOST = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  state.deepseekApiKey = "test-deepseek-key";

  const app = new Hono();
  app.route("/v1/chat/completions", completionRoutes);
  app.route("/v1/messages", messageRoutes);
  app.route("/v1/responses", responsesRoutes);
  await new Promise<void>((resolve) => {
    proxy = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve());
  });
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

after(async () => {
  if (originalHost === undefined) delete process.env.DEEPSEEK_HOST;
  else process.env.DEEPSEEK_HOST = originalHost;
  state.deepseekApiKey = originalKey;
  for (const server of [proxy, upstream]) {
    if (!server) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});

for (const endpoint of endpoints) {
  for (const encoding of encodings) {
    for (const stream of [true, false]) {
      test(`DeepSeek ${endpoint} forwards ${encoding} ${stream ? "SSE" : "JSON"} without double decompression`, async () => {
        const payload = {
          model: "deepseek-flash",
          ...(endpoint === "/v1/responses"
            ? { input: "Reply OK" }
            : { messages: [{ role: "user", content: "Reply OK" }] }),
          stream,
          test_encoding: encoding,
        };
        const response = await fetch(`${proxyUrl}${endpoint}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000),
        });

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-encoding"), null);
        assert.equal(response.headers.get("x-upstream-hop"), null);
        assert.equal(response.headers.get("x-request-id"), "deepseek-test-request");
        assert.equal(response.headers.get("cache-control"), "no-cache");
        assert.equal(response.headers.get("content-type"), stream ? "text/event-stream" : "application/json");
        assert.equal(await response.text(), responseText(stream));
        assert.deepEqual(lastRequest, {
          path: endpoint,
          payload,
          auth: endpoint === "/v1/messages" ? "test-deepseek-key" : "Bearer test-deepseek-key",
        });
      });
    }
  }

  for (const stream of [true, false]) {
    test(`DeepSeek ${endpoint} preserves compressed JSON errors for stream=${stream}`, async () => {
      const response = await fetch(`${proxyUrl}${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "deepseek-flash", stream, test_status: 429 }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "10");
      assert.equal(response.headers.get("content-encoding"), null);
      assert.equal(response.headers.get("content-type"), "application/json");
      assert.equal(await response.text(), responseText(false, 429));
    });
  }

  test(`DeepSeek ${endpoint} delivers compressed SSE before the upstream closes`, async (t) => {
    t.after(() => { finishStream?.(); finishStream = undefined; });
    const response = await fetch(`${proxyUrl}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-flash", stream: true, test_encoding: "gzip", test_incremental: true }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), null);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("data: first chunk\n\n")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "stream ended before delivering its first event");
      text += decoder.decode(chunk.value, { stream: true });
    }
    assert.equal(text, "data: first chunk\n\n");
    assert.ok(finishStream);
    finishStream();
    finishStream = undefined;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    assert.equal(text, "data: first chunk\n\ndata: last chunk\n\n");
    reader.releaseLock();
  });
}

for (const encoding of ["x-custom", "gzip, x-custom", "x-custom, br"]) {
  test(`DeepSeek preserves unsupported encoding chain ${encoding} and its raw body`, async () => {
    const payload = { model: "deepseek-flash", stream: false, test_encoding: encoding };
    const response = await createDeepseekCompletion("/v1/responses", payload);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), encoding);
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(await response.text(), responseText(false));
  });
}

test("DeepSeek zstd headers match the runtime's fetch decoding behavior", { skip: typeof zlib.zstdCompressSync !== "function" }, async () => {
  const response = await createDeepseekCompletion("/v1/responses", {
    model: "deepseek-flash", stream: false, test_encoding: "zstd",
  });
  const fetchDecodesZstd = Number(process.versions.undici?.split(".")[0]) >= 7;
  assert.equal(response.headers.get("content-encoding"), fetchDecodesZstd ? null : "zstd");
  const actual = Buffer.from(await response.arrayBuffer());
  const plain = Buffer.from(responseText(false));
  assert.deepEqual(actual, fetchDecodesZstd ? plain : zlib.zstdCompressSync(plain));
});

test("DeepSeek forwarding strips upstream framing without buffering the response body", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  t.after(() => { controller.close(); });
  const upstreamResponse = new Response(body, {
    status: 202,
    statusText: "Accepted",
    headers: {
      "content-encoding": "br",
      "content-length": "123",
      "transfer-encoding": "chunked",
      connection: "keep-alive, x-upstream-hop",
      "keep-alive": "timeout=5",
      "x-upstream-hop": "remove",
      trailer: "x-checksum",
      "content-type": "text/event-stream",
      "x-request-id": "stream-test",
    },
  });
  globalThis.fetch = async () => upstreamResponse;

  const response = await createDeepseekCompletion("/v1/responses", { model: "deepseek-flash", stream: true });
  assert.strictEqual(response.body, upstreamResponse.body);
  assert.equal(response.status, 202);
  assert.equal(response.statusText, "Accepted");
  for (const header of ["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "x-upstream-hop", "trailer"]) {
    assert.equal(response.headers.get(header), null, header);
  }
  assert.equal(response.headers.get("x-request-id"), "stream-test");
  // Cleaning the forwarded headers must not mutate the original response.
  assert.equal(upstreamResponse.headers.get("content-encoding"), "br");

  controller.enqueue(new TextEncoder().encode("data: first chunk\n\n"));
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), "data: first chunk\n\n");
  reader.releaseLock();
});
