import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";

import { state } from "../src/lib/state.js";
import { fetchModelUpstream } from "../src/lib/upstream-fetch.js";
import { app } from "../src/server.js";

async function startUpstream(t: TestContext, handler: RequestListener): Promise<URL> {
  const server = createServer(handler);
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}

// Control only the proxy's deadline; faking every timer also affects Undici's sockets.
function controlHeadersDeadline(t: TestContext) {
  const schedule = globalThis.setTimeout;
  const timers = t.mock.method(globalThis, "setTimeout", (callback: () => void, delay?: number, ...args: unknown[]) => {
    const timer = schedule(callback, delay, ...args);
    return delay === 120_000 ? timer.unref() : timer;
  });
  const clears = t.mock.method(globalThis, "clearTimeout");

  function deadline() {
    const call = timers.mock.calls.find(({ arguments: [, delay] }) => delay === 120_000);
    assert.ok(call, "the proxy must arm a 120-second headers deadline");
    return call;
  }

  return {
    expire: () => deadline().arguments[0](),
    isCleared: () => {
      const handle = deadline().result;
      return clears.mock.calls.some(({ arguments: [timer] }) => timer === handle);
    },
  };
}

const messages = [{ role: "user", content: "Reply OK." }];
const chat = (model: string) => ({ model, messages, stream: true });

for (const [path, body, upstreamPath] of [
  ["/v1/chat/completions", chat("gpt-4.1"), "/chat/completions"],
  ["/v1/chat/completions", chat("gpt-5-codex"), "/responses"],
  ["/v1/responses", { model: "gpt-5", input: "Reply OK." }, "/responses"],
  ["/v1/messages", { ...chat("claude-sonnet-4.6"), max_tokens: 32 }, "/chat/completions"],
  ["/v1/models/gemini-4-carbon:streamGenerateContent", {
    contents: [{ role: "user", parts: [{ text: "Reply OK." }] }],
  }, "/chat/completions"],
  ["/v1/chat/completions", chat("deepseek-flash"), "/v1/chat/completions"],
] as const) {
  test(`${path} (${"model" in body ? body.model : "Gemini"}) returns 504 if upstream sends no headers`, { timeout: 5000 }, async (t) => {
    const received = Promise.withResolvers<string>();
    const disconnected = Promise.withResolvers<void>();
    const upstream = await startUpstream(t, (req, res) => {
      req.resume();
      received.resolve(req.url!);
      res.on("close", disconnected.resolve);
    });
    const { copilotToken, deepseekApiKey } = state;
    t.after(() => Object.assign(state, { copilotToken, deepseekApiKey }));
    state.copilotToken = "test-copilot-token";
    state.deepseekApiKey = "test-deepseek-key";

    const realFetch = globalThis.fetch;
    const fetch = t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) =>
      realFetch(new URL(new URL(url).pathname, upstream), init)
    );
    const deadline = controlHeadersDeadline(t);

    const pending = app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(await received.promise, upstreamPath);
    assert.equal(fetch.mock.calls[0].arguments[1].signal?.aborted, false);
    deadline.expire();

    const response = await pending;
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), {
      error: {
        message: "Upstream did not send response headers within 120 seconds.",
        type: "upstream_error",
        code: "upstream_headers_timeout",
      },
    });
    await disconnected.promise;
    assert.ok(deadline.isCleared());
    assert.equal(fetch.mock.callCount(), 1);
  });
}

test("receiving headers disarms the timeout even when the response body has not started", { timeout: 5000 }, async (t) => {
  const finish = Promise.withResolvers<() => void>();
  const upstream = await startUpstream(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    finish.resolve(() => res.end("data: OK\n\n"));
  });
  const deadline = controlHeadersDeadline(t);

  const response = await fetchModelUpstream(upstream.href, {});
  assert.equal(response.status, 200);
  assert.ok(deadline.isCleared(), "the deadline must be cleared before the body is read");
  (await finish.promise)();
  assert.equal(await response.text(), "data: OK\n\n");
});
