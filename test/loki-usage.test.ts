import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { getDb, initDatabase } from "../src/lib/db.js";
import { observeLokiUsage } from "../src/lib/loki-usage.js";

let dataDir: string;
let sequence = 0;
before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "loki-usage-test-"));
  await initDatabase(dataDir);
});
after(async () => {
  // logUsage batches its disk writes. Keep the temporary directory until flushed.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  getDb().close();
  await rm(dataDir, { recursive: true, force: true });
});

function context(stream = false) {
  return {
    model: "loki/gpt-5.4",
    endpoint: "openai",
    ip: `test-${++sequence}`,
    startTime: Date.now() - 50,
    stream,
  };
}

async function records(ip: string) {
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stmt = getDb().prepare("SELECT * FROM usage_logs WHERE ip = ?");
  stmt.bind([ip]);
  const rows: Array<Record<string, unknown>> = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function bytesResponse(bytes: Uint8Array, contentType: string, stride = bytes.byteLength) {
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) controller.close();
      else {
        controller.enqueue(bytes.subarray(offset, offset + stride));
        offset += stride;
      }
    },
  }, { highWaterMark: 0 }), { headers: { "content-type": contentType } });
}

const encoder = new TextEncoder();
function sse(data: unknown, event = "", newline = "\n") {
  return `${event ? `event: ${event}${newline}` : ""}data: ${JSON.stringify(data)}${newline}${newline}`;
}

test("JSON is byte-for-byte transparent with status/headers and OpenAI cache usage", async () => {
  const ctx = context();
  const raw = ' { "choices":[], "usage": { "prompt_tokens":12, "completion_tokens":3, "total_tokens":15, "prompt_tokens_details":{"cached_tokens":5,"cache_write_tokens":2} } }\n';
  const response = new Response(raw, {
    status: 201,
    statusText: "Native Result",
    headers: { "content-type": "application/json; charset=utf-8", "x-native": "preserved" },
  });
  const observed = observeLokiUsage(response, ctx);
  assert.equal(observed.status, 201);
  assert.equal(observed.statusText, "Native Result");
  assert.deepEqual([...observed.headers], [...response.headers]);
  assert.equal(await observed.text(), raw);
  const rows = await records(ctx.ip);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usage_known, 1);
  assert.equal(rows[0].prompt_tokens, 12);
  assert.equal(rows[0].completion_tokens, 3);
  assert.equal(rows[0].total_tokens, 15);
  assert.equal(rows[0].cached_prompt_tokens, 5);
  assert.equal(rows[0].cache_write_prompt_tokens, 2);
  assert.equal(rows[0].ttfb_ms, 0);
});

test("Responses JSON input/output usage and missing totals", async () => {
  const ctx = context();
  const raw = JSON.stringify({ object: "response", usage: {
    input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 4 },
  } });
  assert.equal(await observeLokiUsage(new Response(raw, {
    headers: { "content-type": "application/json" },
  }), ctx).text(), raw);
  const [row] = await records(ctx.ip);
  assert.equal(row.usage_known, 1);
  assert.equal(row.total_tokens, 12);
  assert.equal(row.cached_prompt_tokens, 3);
  assert.equal(row.cache_write_prompt_tokens, 4);
});

test("absent, malformed, incomplete and oversized JSON usage is unknown, not known zero", async () => {
  for (const raw of [
    '{"choices":[]}',
    '{"error":{"message":"native failure"}}',
    '{invalid',
    '{"usage":{"prompt_tokens":4}}',
    '{"usage":{"prompt_tokens":-1,"completion_tokens":0}}',
    JSON.stringify({ padding: "x".repeat(1024 * 1024), usage: { prompt_tokens: 7, completion_tokens: 1 } }),
  ]) {
    const ctx = context();
    const input = encoder.encode(raw);
    const output = await observeLokiUsage(bytesResponse(input, "application/json", 13_007), ctx).arrayBuffer();
    assert.deepEqual(new Uint8Array(output), input);
    const rows = await records(ctx.ip);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].usage_known, 0);
    assert.equal(rows[0].total_tokens, 0);
  }
  const ctx = context();
  await observeLokiUsage(new Response('{"usage":{"prompt_tokens":0,"completion_tokens":0}}', {
    headers: { "content-type": "application/json" },
  }), ctx).text();
  assert.equal((await records(ctx.ip))[0].usage_known, 1);
});

test("no-body responses log exactly once without changing the response", async () => {
  for (const response of [new Response(null, { status: 204 }), Response.error()]) {
    const ctx = context();
    assert.equal(observeLokiUsage(response, ctx), response);
    const rows = await records(ctx.ip);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].usage_known, 0);
  }
});

test("Anthropic JSON includes cache reads/writes in prompt and total tokens", async () => {
  const ctx = context();
  const raw = JSON.stringify({ type: "message", usage: {
    input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 30, cache_creation_input_tokens: 20,
  } });
  assert.equal(await observeLokiUsage(new Response(raw, {
    headers: { "content-type": "application/json" },
  }), ctx).text(), raw);
  const [row] = await records(ctx.ip);
  assert.equal(row.prompt_tokens, 60);
  assert.equal(row.completion_tokens, 2);
  assert.equal(row.total_tokens, 62);
  assert.equal(row.cached_prompt_tokens, 30);
  assert.equal(row.cache_write_prompt_tokens, 20);
  assert.equal(row.usage_known, 1);
});

test("OpenAI SSE preserves split UTF-8/CRLF and records final usage once", async () => {
  const ctx = context(true);
  const raw = ': heartbeat\r\n\r\n' +
    sse({ choices: [{ delta: { role: "assistant" } }] }, "", "\r\n") +
    sse({ choices: [{ delta: { content: "中文🙂" } }] }, "", "\r\n") +
    sse({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }, "", "\r\n") +
    'data: [DONE]\r\n\r\n';
  const input = encoder.encode(raw);
  const output = await observeLokiUsage(bytesResponse(input, "text/event-stream", 1), ctx).arrayBuffer();
  assert.deepEqual(new Uint8Array(output), input);
  const rows = await records(ctx.ip);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usage_known, 1);
  assert.equal(rows[0].total_tokens, 24);
  assert.ok(Number(rows[0].ttfb_ms) >= 50);
});

test("Responses SSE records only completed usage and output deltas count as TTFT", async () => {
  const ctx = context(true);
  const raw = sse({ type: "response.created", response: { usage: { input_tokens: 0, output_tokens: 0 } } }) +
    sse({ delta: "tool arguments" }, "response.function_call_arguments.delta") +
    sse({ type: "response.completed", response: { usage: {
      input_tokens: 100, output_tokens: 8, total_tokens: 108,
      input_tokens_details: { cached_tokens: 70, cache_write_tokens: 10 },
    } } });
  assert.equal(await observeLokiUsage(bytesResponse(encoder.encode(raw), "text/event-stream", 7), ctx).text(), raw);
  const [row] = await records(ctx.ip);
  assert.equal(row.usage_known, 1);
  assert.equal(row.total_tokens, 108);
  assert.equal(row.cached_prompt_tokens, 70);
  assert.equal(row.cache_write_prompt_tokens, 10);
  assert.ok(Number(row.ttfb_ms) >= 50);
});

test("Anthropic SSE merges cumulative message_start/delta usage without double counting", async () => {
  const ctx = context(true);
  const start = { type: "message_start", message: { usage: {
    input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 30,
  } } };
  const delta = { type: "message_delta", usage: { output_tokens: 7, cache_creation_input_tokens: 40 } };
  const raw = sse(start) + sse({ type: "content_block_delta", delta: { type: "text_delta", text: "hello" } }) +
    sse(delta) + sse(delta) + sse({ type: "message_stop" });
  assert.equal(await observeLokiUsage(bytesResponse(encoder.encode(raw), "text/event-stream", 5), ctx).text(), raw);
  const [row] = await records(ctx.ip);
  assert.equal(row.prompt_tokens, 70);
  assert.equal(row.completion_tokens, 7);
  assert.equal(row.total_tokens, 77);
  assert.equal(row.cached_prompt_tokens, 20);
  assert.equal(row.cache_write_prompt_tokens, 40);
  assert.equal(row.usage_known, 1);
  assert.ok(Number(row.ttfb_ms) >= 50);

  const partial = context(true);
  await observeLokiUsage(bytesResponse(encoder.encode(sse(start)), "text/event-stream"), partial).text();
  const [incomplete] = await records(partial.ip);
  assert.equal(incomplete.usage_known, 0);
  assert.equal(incomplete.prompt_tokens, 60);
  assert.equal(incomplete.completion_tokens, 0);
  assert.equal(incomplete.ttfb_ms, 0);
});

test("TTFT ignores heartbeats, role and usage metadata, then records first real output", async (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  for (const output of [
    { choices: [{ delta: { content: "hello" } }] },
    { choices: [{ delta: { tool_calls: [{ function: { arguments: "{" } }] } }] },
    { type: "response.output_text.delta", delta: "hello" },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } },
  ]) {
    const ctx = { ...context(true), startTime: 1_000 };
    const chunks = [
      ': heartbeat\n\n',
      sse({ choices: [{ delta: { role: "assistant", content: "" } }] }),
      sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } }),
      sse(output),
      sse(output),
    ];
    let index = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        now = 1_100 + index * 100;
        if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
        else controller.close();
      },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
    await observeLokiUsage(response, ctx).text();
    assert.equal((await records(ctx.ip))[0].ttfb_ms, 400);
    now = 1_000;
  }
});

test("oversized SSE frames (single line or multiline) are skipped and later frames recover", async () => {
  for (const oversized of [
    sse({ padding: "x".repeat(300_000), usage: { prompt_tokens: 99, completion_tokens: 99 } }),
    'data: {"padding":"' + 'x'.repeat(140_000) + '\ndata: ' + 'x'.repeat(140_000) + '"}\n\n',
  ]) {
    for (const final of ["", sse({ usage: { prompt_tokens: 3, completion_tokens: 2 } })]) {
      const ctx = context(true);
      const input = encoder.encode(oversized + final);
      const output = await observeLokiUsage(bytesResponse(input, "text/event-stream", 5003), ctx).arrayBuffer();
      assert.deepEqual(new Uint8Array(output), input);
      const [row] = await records(ctx.ip);
      assert.equal(row.usage_known, final ? 1 : 0);
      assert.equal(row.total_tokens, final ? 5 : 0);
    }
  }
});

test("downstream backpressure causes no eager reads and cancellation propagates exactly once", async () => {
  const ctx = context(true);
  let pulls = 0;
  let cancels = 0;
  const reason = new Error("client disconnected");
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(encoder.encode(': heartbeat\n\n'));
    },
    cancel(value) { cancels++; assert.equal(value, reason); },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  const reader = observeLokiUsage(response, ctx).body!.getReader();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pulls, 0);
  assert.equal((await records(ctx.ip)).length, 0);
  await reader.read();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pulls, 1);
  await reader.cancel(reason);
  await reader.cancel(reason);
  assert.equal(cancels, 1);
  const rows = await records(ctx.ip);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usage_known, 0);
});

test("cancellation while an upstream read is pending logs once", async () => {
  const ctx = context(true);
  let reason: unknown;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull() { /* pending until downstream cancels */ },
    cancel(value) { reason = value; },
  }, { highWaterMark: 0 }));
  const reader = observeLokiUsage(response, ctx).body!.getReader();
  const read = reader.read();
  await reader.cancel("stop");
  assert.equal((await read).done, true);
  assert.equal(reason, "stop");
  const rows = await records(ctx.ip);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usage_known, 0);
});

test("known usage is retained on cancellation and reason propagation is unchanged", async () => {
  const ctx = context(true);
  let cancelled: unknown;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoder.encode(sse({ usage: { prompt_tokens: 4, completion_tokens: 1 } })));
    },
    cancel(reason) { cancelled = reason; },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  const reader = observeLokiUsage(response, ctx).body!.getReader();
  await reader.read();
  await reader.cancel("disconnect");
  const rows = await records(ctx.ip);
  assert.equal(cancelled, "disconnect");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usage_known, 1);
  assert.equal(rows[0].total_tokens, 5);
});

test("small JSON without explicit JSON Content-Type can still report usage", async () => {
  const ctx = context();
  const raw = '{"usage":{"prompt_tokens":2,"completion_tokens":1}}';
  const response = new Response(raw); // Fetch labels string bodies as text/plain.
  assert.equal(await observeLokiUsage(response, ctx).text(), raw);
  assert.equal((await records(ctx.ip))[0].usage_known, 1);
});

test("SSE handles multiline data and CR-only delimiters, with a final unterminated frame", async () => {
  const ctx = context(true);
  const raw = 'data: {"usage":\rdata: {"prompt_tokens":2,"completion_tokens":1}}\r\r' +
    'data: {"usage":{"prompt_tokens":3,"completion_tokens":2}}';
  assert.equal(await observeLokiUsage(bytesResponse(encoder.encode(raw), "text/event-stream", 1), ctx).text(), raw);
  const [row] = await records(ctx.ip);
  assert.equal(row.usage_known, 1);
  assert.equal(row.total_tokens, 5);
});

test("upstream read errors preserve the error and log once, retaining observed usage", async () => {
  for (const includeUsage of [false, true]) {
    const ctx = context(true);
    const error = new Error("upstream failure");
    let pulls = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++pulls === 1 && includeUsage) {
          controller.enqueue(encoder.encode(sse({ usage: { prompt_tokens: 5, completion_tokens: 2 } })));
        } else controller.error(error);
      },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
    const reader = observeLokiUsage(response, ctx).body!.getReader();
    if (includeUsage) await reader.read();
    await assert.rejects(reader.read(), (value) => value === error);
    await assert.rejects(reader.read(), (value) => value === error);
    const rows = await records(ctx.ip);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].usage_known, includeUsage ? 1 : 0);
    assert.equal(rows[0].total_tokens, includeUsage ? 7 : 0);
  }
});
