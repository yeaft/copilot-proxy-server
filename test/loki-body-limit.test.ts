import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { lokiRouting } from "../src/routes/loki.js";
import { state } from "../src/lib/state.js";
import type { LokiProvider } from "../src/services/loki.js";

const maxSize = 32 * 1024 * 1024;
const endpoints = ["/v1/chat/completions", "/chat/completions", "/v1/responses", "/responses", "/v1/messages", "/v1/messages/count_tokens"];

function sizedBody(model: string, size: number): string {
  // Whitespace counts even though reserializing this payload would be tiny.
  // Multibyte text ensures byte length, not JS string length, determines limits.
  const payload = JSON.stringify({ model, input: "界" });
  return payload + " ".repeat(size - Buffer.byteLength(payload));
}

test("only Loki requests enforce the exact 32 MiB UTF-8 body boundary on every native endpoint", async () => {
  const original = { loki: state.loki, copilotEnabled: state.copilotEnabled };
  let forwarded = 0;
  const app = new Hono();
  app.use("*", lokiRouting);
  app.post("*", (c) => c.json({ legacy: true }));
  state.loki = { forward: async (_endpoint: string, payload: Record<string, unknown>) => {
    forwarded++;
    assert.deepEqual(payload, { model: "offline", input: "界" });
    return Response.json({ native: true });
  } } as unknown as LokiProvider;
  try {
    for (const size of [maxSize - 1, maxSize, maxSize + 1]) {
      const body = sizedBody("loki/offline", size);
      assert.equal(Buffer.byteLength(body), size);
      for (const endpoint of endpoints) {
        const before = forwarded;
        const response = await app.request(endpoint, { method: "POST", body });
        assert.equal(response.status, size <= maxSize ? 200 : 413, `${endpoint}: ${size} bytes`);
        assert.equal(forwarded, before + (size <= maxSize ? 1 : 0));
        if (size > maxSize) assert.match(await response.text(), /exceeds 32 MiB/);
        else await response.text();
      }
    }
    // A UTF-8 BOM is removed by text decoding but still counts on the wire.
    const bomResponse = await app.request("/v1/responses", { method: "POST",
      body: "\uFEFF" + sizedBody("loki/offline", maxSize - 2) });
    assert.equal(bomResponse.status, 413);
    await bomResponse.text();
    // Do not trust declared size in either direction when actual bytes differ.
    for (const [size, declared, expected] of [[maxSize, maxSize + 1, 200], [maxSize + 1, 1, 413]]) {
      const response = await app.request("/v1/responses", { method: "POST", body: sizedBody("loki/offline", size),
        headers: { "content-length": String(declared) } });
      assert.equal(response.status, expected);
      await response.text();
    }
  } finally { Object.assign(state, original); }
});

test("oversized Copilot and DeepSeek bodies still reach unchanged legacy handlers with Loki enabled or disabled", async () => {
  const original = { loki: state.loki, copilotEnabled: state.copilotEnabled };
  const app = new Hono();
  app.use("*", lokiRouting);
  app.post("*", async (c) => {
    const payload = await c.req.json();
    assert.deepEqual(payload, { model: payload.model, input: "界" });
    assert.equal(Buffer.byteLength(await c.req.text()), maxSize + 1, "original cached bytes survive routing");
    return c.json({ legacy: payload.model });
  });
  try {
    for (const enabled of [false, true]) {
      state.loki = enabled ? { forward: async () => { throw new Error("must not forward"); } } as unknown as LokiProvider : undefined;
      for (const model of ["gpt-4.1", "deepseek-v4-pro"]) {
        state.copilotEnabled = model === "gpt-4.1";
        const body = sizedBody(model, maxSize + 1);
        for (const endpoint of endpoints) {
          const response = await app.request(endpoint, { method: "POST", body });
          assert.equal(response.status, 200, `${model}, Loki enabled=${enabled}, ${endpoint}`);
          assert.deepEqual(await response.json(), { legacy: model });
        }
      }
    }
  } finally { Object.assign(state, original); }
});
