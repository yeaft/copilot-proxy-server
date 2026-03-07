#!/usr/bin/env node

/**
 * CopilotProxyServer API 测试脚本
 *
 * 从 .env 读取 API_KEY，测试各个端点和模型，记录执行时间。
 *
 * 用法:
 *   node scripts/test-api.mjs                          # 使用 .env 配置
 *   node scripts/test-api.mjs https://your-server.com  # 指定服务器地址
 *   API_KEY=xxx node scripts/test-api.mjs              # 通过环境变量传入
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// 解析 .env
// ---------------------------------------------------------------------------
function loadEnv() {
  try {
    const content = readFileSync(resolve(projectRoot, ".env"), "utf8");
    const vars = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      vars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

const env = loadEnv();
const BASE_URL = process.argv[2] || `http://localhost:${env.PORT || "6628"}`;
const API_KEY = process.env.API_KEY || env.API_KEY || "";

if (!API_KEY) {
  console.error("Error: API_KEY not found. Set it in .env or pass via environment variable.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
const headers = (extra = {}) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${API_KEY}`,
  ...extra,
});

function msVal(start) {
  return performance.now() - start;
}

function fmtMs(v) {
  return `${v.toFixed(0)}ms`;
}

function printResult(name, status, ttft, total, detail, pass = undefined) {
  const ok = pass !== undefined ? pass : (status >= 200 && status < 300);
  const icon = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  const timeStr = total != null
    ? `${fmtMs(ttft).padStart(8)} / ${fmtMs(total).padStart(8)}`
    : fmtMs(ttft).padStart(8);
  console.log(`  [${icon}] ${name.padEnd(45)} ${String(status).padEnd(6)} ${timeStr}  ${detail}`);
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------
async function testHealthCheck() {
  const start = performance.now();
  const res = await fetch(`${BASE_URL}/`);
  const data = await res.json();
  printResult("GET /", res.status, msVal(start), null, data.status || "");
  return res.ok;
}

async function testModels() {
  const start = performance.now();
  const res = await fetch(`${BASE_URL}/v1/models`, { headers: headers() });
  const data = await res.json();
  const models = data.data?.map((m) => m.id) || [];
  printResult("GET /v1/models", res.status, msVal(start), null, `${models.length} models`);
  return models;
}

async function testAuthReject() {
  const start = performance.now();
  const res = await fetch(`${BASE_URL}/v1/models`);
  const ok = res.status === 401;
  printResult("GET /v1/models (no key)", res.status, msVal(start), null, ok ? "correctly rejected" : "should be 401", ok);
  return ok;
}

async function testOpenAI(model) {
  const start = performance.now();
  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: hello" }],
        max_tokens: 1000,
      }),
    });
    const ttft = msVal(start);
    const data = await res.json();
    const total = msVal(start);
    const content = data.choices?.[0]?.message?.content?.slice(0, 60) || "";
    const error = data.error ? (typeof data.error === "string" ? data.error : data.error.message || JSON.stringify(data.error)) : "";
    const detail = content || error || `(empty) ${JSON.stringify(data).slice(0, 80)}`;
    printResult(`OpenAI  ${model}`, res.status, ttft, total, detail, res.ok && !!content);
    return res.ok && !!content;
  } catch (e) {
    printResult(`OpenAI  ${model}`, "ERR", msVal(start), null, e.message);
    return false;
  }
}

async function testOpenAIStream(model) {
  const start = performance.now();
  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: hello" }],
        max_tokens: 1000,
        stream: true,
      }),
    });
    let chunks = 0;
    let text = "";
    let ttft = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttft === null) ttft = msVal(start);
      const raw = decoder.decode(value, { stream: true });
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        try {
          const chunk = JSON.parse(line.slice(6));
          const delta = chunk.choices?.[0]?.delta?.content || "";
          text += delta;
          chunks++;
        } catch {}
      }
    }
    const total = msVal(start);
    printResult(`OpenAI  ${model} (stream)`, res.status, ttft ?? total, total, `${chunks} chunks: ${text.slice(0, 60) || "(empty)"}`, res.ok && !!text);
    return res.ok && !!text;
  } catch (e) {
    printResult(`OpenAI  ${model} (stream)`, "ERR", msVal(start), null, e.message);
    return false;
  }
}

async function testAnthropic(model) {
  const start = performance.now();
  try {
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: headers({ "x-api-key": API_KEY, "anthropic-version": "2023-06-01" }),
      body: JSON.stringify({
        model,
        max_tokens: 1000,
        messages: [{ role: "user", content: "Reply with exactly: hello" }],
      }),
    });
    const ttft = msVal(start);
    const data = await res.json();
    const total = msVal(start);
    const content = data.content?.[0]?.text?.slice(0, 60) || "";
    const error = data.error ? (typeof data.error === "string" ? data.error : data.error.message || JSON.stringify(data.error)) : "";
    const detail = content || error || `(empty) ${JSON.stringify(data).slice(0, 80)}`;
    printResult(`Anthropic  ${model}`, res.status, ttft, total, detail, res.ok && !!content);
    return res.ok && !!content;
  } catch (e) {
    printResult(`Anthropic  ${model}`, "ERR", msVal(start), null, e.message);
    return false;
  }
}

async function testAnthropicStream(model) {
  const start = performance.now();
  try {
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: headers({ "x-api-key": API_KEY, "anthropic-version": "2023-06-01" }),
      body: JSON.stringify({
        model,
        max_tokens: 1000,
        stream: true,
        messages: [{ role: "user", content: "Reply with exactly: hello" }],
      }),
    });
    let events = 0;
    let text = "";
    let ttft = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttft === null) ttft = msVal(start);
      const raw = decoder.decode(value, { stream: true });
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === "content_block_delta") {
            text += evt.delta?.text || "";
          }
          events++;
        } catch {}
      }
    }
    const total = msVal(start);
    printResult(`Anthropic  ${model} (stream)`, res.status, ttft ?? total, total, `${events} events: ${text.slice(0, 60) || "(empty)"}`, res.ok && !!text);
    return res.ok && !!text;
  } catch (e) {
    printResult(`Anthropic  ${model} (stream)`, "ERR", msVal(start), null, e.message);
    return false;
  }
}

async function testGemini(model) {
  const start = performance.now();
  try {
    const res = await fetch(`${BASE_URL}/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Reply with exactly: hello" }] }],
        generationConfig: { maxOutputTokens: 1000 },
      }),
    });
    const ttft = msVal(start);
    const data = await res.json();
    const total = msVal(start);
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text?.slice(0, 60) || "";
    const error = data.error ? (typeof data.error === "string" ? data.error : data.error.message || JSON.stringify(data.error)) : "";
    const detail = content || error || `(empty) ${JSON.stringify(data).slice(0, 80)}`;
    printResult(`Gemini  ${model}`, res.status, ttft, total, detail, res.ok && !!content);
    return res.ok && !!content;
  } catch (e) {
    printResult(`Gemini  ${model}`, "ERR", msVal(start), null, e.message);
    return false;
  }
}

async function testCountTokens() {
  // Anthropic format
  const start1 = performance.now();
  const res1 = await fetch(`${BASE_URL}/v1/messages/count_tokens`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hello world, this is a test." }],
    }),
  });
  const data1 = await res1.json();
  printResult("Anthropic count_tokens", res1.status, msVal(start1), null, `input_tokens: ${data1.input_tokens}`);

  // Gemini format
  const start2 = performance.now();
  const res2 = await fetch(`${BASE_URL}/v1beta/models/gpt-4o:countTokens`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Hello world, this is a test." }] }],
    }),
  });
  const data2 = await res2.json();
  printResult("Gemini countTokens", res2.status, msVal(start2), null, `totalTokens: ${data2.totalTokens}`);
  return res1.ok && res2.ok;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n${"=".repeat(110)}`);
  console.log(`  CopilotProxyServer API Test`);
  console.log(`  Server: ${BASE_URL}`);
  console.log(`  API Key: ${API_KEY.slice(0, 10)}...${API_KEY.slice(-4)}`);
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log(`${"=".repeat(110)}\n`);
  console.log(`  ${"Test".padEnd(45)} ${"Status".padEnd(6)}     TTFT /    Total  Detail`);
  console.log(`  ${"-".repeat(104)}`);

  const totalStart = performance.now();
  let pass = 0;
  let fail = 0;
  const track = (ok) => (ok ? pass++ : fail++);

  // 基础测试
  console.log("--- Basic Tests ---");
  track(await testHealthCheck());
  track(await testAuthReject());
  track(await testCountTokens());

  // 获取可用模型
  console.log("\n--- Available Models ---");
  const models = await testModels();

  if (models.length === 0) {
    console.log("  No models available, skipping model tests.");
    return;
  }

  console.log(`  Models: ${models.join(", ")}`);

  // 过滤掉不支持 chat 的模型（embedding、codex 等）
  const chatModels = models.filter(
    (m) => !m.includes("embedding") && !m.includes("codex")
  );

  // 按厂商分类模型
  const openaiModels = chatModels.filter((m) => m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4"));
  const anthropicModels = chatModels.filter((m) => m.startsWith("claude-"));
  const geminiModels = chatModels.filter((m) => m.startsWith("gemini-"));
  const otherModels = chatModels.filter(
    (m) => !openaiModels.includes(m) && !anthropicModels.includes(m) && !geminiModels.includes(m)
  );

  // 按版本号降序排列，优先测试最新的模型
  // 优先级列表：匹配到的排在最前面
  const openaiPriority = ["gpt-5.2", "gpt-5.1", "gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "o4", "o3", "o1"];
  const anthropicPriority = ["claude-opus-4.6", "claude-sonnet-4.5", "claude-sonnet-4", "claude-opus-4.5", "claude-haiku-4.5"];
  const geminiPriority = ["gemini-3-pro", "gemini-3-flash", "gemini-2.5-pro", "gemini-2.5-flash"];

  const prioritySort = (priorities) => (a, b) => {
    const idxOf = (s) => {
      const i = priorities.findIndex((p) => s.startsWith(p));
      return i === -1 ? priorities.length : i;
    };
    return idxOf(a) - idxOf(b);
  };
  openaiModels.sort(prioritySort(openaiPriority));
  anthropicModels.sort(prioritySort(anthropicPriority));
  geminiModels.sort(prioritySort(geminiPriority));

  // 每个厂商最多取 2 个模型测试
  const selectedOpenAI = openaiModels.slice(0, 2);
  const selectedAnthropic = anthropicModels.slice(0, 2);
  const selectedGemini = geminiModels.slice(0, 2);

  console.log(`  OpenAI models:    ${selectedOpenAI.join(", ") || "(none)"}`);
  console.log(`  Anthropic models: ${selectedAnthropic.join(", ") || "(none)"}`);
  console.log(`  Gemini models:    ${selectedGemini.join(", ") || "(none)"}`);
  if (otherModels.length) console.log(`  Other models:     ${otherModels.join(", ")}`);

  // OpenAI 格式测试（用 GPT 模型）
  if (selectedOpenAI.length) {
    console.log("\n--- OpenAI Format ---");
    for (const model of selectedOpenAI) {
      track(await testOpenAI(model));
    }

    // OpenAI 流式测试（只测第一个模型）
    console.log("\n--- OpenAI Streaming ---");
    track(await testOpenAIStream(selectedOpenAI[0]));
  } else {
    console.log("\n--- OpenAI Format --- (skipped, no GPT models)");
  }

  // Anthropic 格式测试（用 Claude 模型）
  if (selectedAnthropic.length) {
    console.log("\n--- Anthropic Format ---");
    for (const model of selectedAnthropic) {
      track(await testAnthropic(model));
    }

    // Anthropic 流式测试
    console.log("\n--- Anthropic Streaming ---");
    track(await testAnthropicStream(selectedAnthropic[0]));
  } else {
    console.log("\n--- Anthropic Format --- (skipped, no Claude models)");
  }

  // Gemini 格式测试（用 Gemini 模型）
  if (selectedGemini.length) {
    console.log("\n--- Gemini Format ---");
    for (const model of selectedGemini) {
      track(await testGemini(model));
    }
  } else {
    console.log("\n--- Gemini Format --- (skipped, no Gemini models)");
  }

  // 总结
  const totalTime = fmtMs(msVal(totalStart));
  console.log(`\n${"=".repeat(110)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m     Total: ${totalTime}`);
  console.log(`${"=".repeat(110)}\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
