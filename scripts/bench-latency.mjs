#!/usr/bin/env node

/**
 * CopilotProxyServer — 模型延迟基准测试
 *
 * 测量通过代理的各主要模型的:
 *   - TTFT (Time To First Token) — 首 token 延迟
 *   - Total Duration — 完整响应耗时
 *   - TPS (Tokens Per Second) — 生成速度
 *
 * 每个模型跑 N 轮取统计值 (min / p50 / avg / p95 / max)
 *
 * 用法:
 *   node scripts/bench-latency.mjs                           # 默认配置
 *   node scripts/bench-latency.mjs --rounds 5                # 5 轮
 *   node scripts/bench-latency.mjs --models gpt-4o,claude-sonnet-4  # 指定模型
 *   node scripts/bench-latency.mjs --url https://your-server # 指定服务器
 *   node scripts/bench-latency.mjs --prompt-size short       # short / medium / long
 *   node scripts/bench-latency.mjs --output results.json     # 输出 JSON
 *   node scripts/bench-latency.mjs --max-tokens 200          # 控制输出长度
 */

import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// ─────────────────────────────────────────────────────────────────────────────
// .env 解析
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// CLI 参数解析
// ─────────────────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    rounds: 3,
    models: null,       // null = 自动检测
    url: null,
    promptSize: "short",
    output: null,
    maxTokens: 300,
    warmup: true,        // 是否先跑一轮 warmup
    sequential: true,    // 串行跑避免互相干扰
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--rounds":
      case "-n":
        opts.rounds = parseInt(args[++i], 10);
        break;
      case "--models":
      case "-m":
        opts.models = args[++i].split(",").map((s) => s.trim());
        break;
      case "--url":
        opts.url = args[++i];
        break;
      case "--prompt-size":
        opts.promptSize = args[++i]; // short | medium | long
        break;
      case "--output":
      case "-o":
        opts.output = args[++i];
        break;
      case "--max-tokens":
        opts.maxTokens = parseInt(args[++i], 10);
        break;
      case "--no-warmup":
        opts.warmup = false;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: node scripts/bench-latency.mjs [options]
Options:
  --rounds, -n <N>       Number of rounds per model (default: 3)
  --models, -m <list>    Comma-separated model IDs (default: auto-detect top models)
  --url <url>            Server URL (default: from .env PORT)
  --prompt-size <size>   short | medium | long (default: short)
  --max-tokens <N>       Max tokens to generate (default: 300)
  --output, -o <file>    Save results as JSON
  --no-warmup            Skip warmup round
  --help, -h             Show this help
`);
        process.exit(0);
    }
  }
  return opts;
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试 Prompt 定义
// ─────────────────────────────────────────────────────────────────────────────
const PROMPTS = {
  short: {
    label: "短 prompt (~30 tokens)",
    messages: [
      { role: "user", content: "Explain what a hash table is in 2-3 sentences." },
    ],
  },
  medium: {
    label: "中等 prompt (~200 tokens)",
    messages: [
      {
        role: "system",
        content:
          "You are a senior software engineer. Answer concisely but thoroughly.",
      },
      {
        role: "user",
        content: `I'm building a web application that needs to handle real-time notifications.
The app has about 10,000 concurrent users. Compare WebSockets vs Server-Sent Events (SSE)
for this use case. Consider: connection overhead, browser support, scalability,
and ease of implementation. Recommend one approach with reasoning.`,
      },
    ],
  },
  long: {
    label: "长 prompt (~800 tokens)",
    messages: [
      {
        role: "system",
        content: `You are a principal software architect at a Fortune 500 company.
You specialize in distributed systems, microservices, and cloud-native architecture.
Provide detailed, production-ready advice based on real-world experience.
Always consider trade-offs, operational costs, and team skill requirements.`,
      },
      {
        role: "user",
        content: `Our e-commerce platform currently runs as a monolithic Node.js application
on AWS EC2. We're experiencing scaling issues during peak traffic (Black Friday, flash sales).
Current architecture:
- Single Express.js app handling all routes
- PostgreSQL for order and product data
- Redis for session management
- File-based image storage on EBS volumes
- Background jobs processed in-process with Bull queue

Key metrics:
- 50,000 RPM during peak, normally 5,000 RPM
- Average response time degrades from 200ms to 3s during peaks
- Database connection pool exhaustion during spikes
- Memory usage spikes to 90%+ causing OOM kills

Team: 8 backend engineers, 4 frontend engineers, 2 DevOps engineers.

Please design a migration strategy to handle 10x our current peak load.
Cover: which services to extract first, data migration strategy,
recommended infrastructure changes, monitoring approach, and a 6-month timeline.`,
      },
      {
        role: "assistant",
        content: `I'll outline a comprehensive migration strategy. Let me start with the high-priority extractions.

**Phase 1 (Month 1-2): Critical Path Decomposition**

First, extract the services causing the most contention:

1. **Product Catalog Service** — Read-heavy, perfect candidate for caching layer
2. **Order Processing Service** — Write-heavy, needs its own DB connection pool`,
      },
      {
        role: "user",
        content:
          "Good start. Now focus specifically on the database migration strategy. How do we split the monolith's PostgreSQL without downtime? What patterns should we use for cross-service data consistency?",
      },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 模型优先级 — 每个厂商取 top N 个最有代表性的
// ─────────────────────────────────────────────────────────────────────────────
const MODEL_PRIORITY = [
  // OpenAI — 旗舰
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4o",
  // Anthropic — 旗舰
  "claude-opus-4.6",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-opus-4.5",
  "claude-haiku-4.5",
  "claude-sonnet-4",
  // Gemini — 旗舰
  "gemini-3.1-pro",
  "gemini-3-flash",
  "gemini-2.5-pro",
];

// 这些模型不支持 /chat/completions 或太老，自动排除
const EXCLUDE_PATTERNS = [
  "embedding", "codex", "goldeneye", "-1m",
  "gpt-5.4-mini",   // codex-only
  "gpt-5.3-codex",  // codex-only
  "gpt-3.5",        // 太老
  "gpt-4-0613", "gpt-4-0125", "gpt-4o-2024-05-13", "gpt-4o-2024-08-06",  // 旧快照，有新的就跳过
  "gpt-4-o-preview",
  "gpt-41-copilot",  // 内部模型
  "gpt-4o-mini-2024",  // 旧快照
  "gpt-4o-2024-11",    // 旧快照
  "gpt-5.4",           // 不兼容 max_tokens，代理会自动注入导致 400
];

function shouldExclude(modelId) {
  return EXCLUDE_PATTERNS.some((p) => modelId.includes(p));
}

function selectModels(availableModels, requestedModels) {
  if (requestedModels) {
    // 校验请求的模型是否在可用列表
    const valid = [];
    const invalid = [];
    for (const m of requestedModels) {
      if (availableModels.includes(m)) valid.push(m);
      else invalid.push(m);
    }
    if (invalid.length) {
      console.warn(`  ⚠  Models not available: ${invalid.join(", ")}`);
    }
    return valid;
  }

  // 自动选择: 按优先级匹配（排除不兼容的模型）
  const selected = [];
  for (const priority of MODEL_PRIORITY) {
    const match = availableModels.find((m) => m.startsWith(priority) && !shouldExclude(m));
    if (match && !selected.includes(match)) {
      selected.push(match);
    }
  }

  // 如果优先级列表没覆盖到的模型，也加几个
  for (const m of availableModels) {
    if (
      !selected.includes(m) &&
      !shouldExclude(m) &&
      selected.length < 12
    ) {
      selected.push(m);
    }
  }

  return selected;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP 工具
// ─────────────────────────────────────────────────────────────────────────────
function makeHeaders(apiKey, extra = {}) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 核心测量: 流式请求
// ─────────────────────────────────────────────────────────────────────────────
// 某些新模型 (gpt-5.4 等) 只接受 max_completion_tokens 而不是 max_tokens
const MAX_COMPLETION_TOKENS_MODELS = ["gpt-5.4", "gpt-5.3", "o1", "o3", "o4"];

function needsMaxCompletionTokens(model) {
  return MAX_COMPLETION_TOKENS_MODELS.some((p) => model.startsWith(p));
}

async function measureStream(baseUrl, apiKey, model, messages, maxTokens) {
  const start = performance.now();

  // gpt-5.4 等模型不接受 max_tokens，而旧版代理会自动注入 max_tokens，
  // 所以对这类模型干脆不发任何 token 限制参数，避免代理注入 max_tokens 导致上游报错
  const tokenParam = needsMaxCompletionTokens(model)
    ? {}
    : { max_tokens: maxTokens };

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: makeHeaders(apiKey),
    body: JSON.stringify({
      model,
      messages,
      ...tokenParam,
      stream: true,
      temperature: 0.7,  // 固定温度保证一致性
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let ttft = null;
  let chunks = 0;
  let completionTokens = 0;
  let text = "";
  let lastUsage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const raw = decoder.decode(value, { stream: true });
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      try {
        const chunk = JSON.parse(line.slice(6));
        const delta = chunk.choices?.[0]?.delta?.content || "";
        if (delta && ttft === null) {
          ttft = performance.now() - start;
        }
        text += delta;
        if (delta) chunks++;
        if (chunk.usage) lastUsage = chunk.usage;
      } catch {}
    }
  }

  const totalMs = performance.now() - start;

  // 估算 completion tokens (如果 usage 不可用)
  if (lastUsage) {
    completionTokens = lastUsage.completion_tokens;
  } else {
    // 粗略估算: ~4 chars per token
    completionTokens = Math.ceil(text.length / 4);
  }

  const generationMs = totalMs - (ttft || 0);
  // 当 generation 时间 < 50ms 时说明所有 token 都在首个 chunk 一起到达
  // 此时 TPS 没有统计意义，用 total 时间来估算更合理
  const effectiveGenMs = generationMs < 50 ? totalMs : generationMs;
  const tps = effectiveGenMs > 0 ? (completionTokens / effectiveGenMs) * 1000 : 0;

  return {
    ttft_ms: ttft ?? totalMs,
    total_ms: totalMs,
    generation_ms: generationMs,
    completion_tokens: completionTokens,
    prompt_tokens: lastUsage?.prompt_tokens ?? null,
    tps,
    chunks,
    text_length: text.length,
    text_preview: text.slice(0, 80),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 统计工具
// ─────────────────────────────────────────────────────────────────────────────
function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function computeStats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: percentile(sorted, 50),
    avg: avg(sorted),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    stddev: Math.sqrt(
      avg(sorted.map((v) => Math.pow(v - avg(sorted), 2)))
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 格式化输出
// ─────────────────────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
};

function fmtMs(v) {
  if (v == null) return "  N/A  ";
  if (v >= 10000) return `${(v / 1000).toFixed(1)}s`.padStart(7);
  return `${v.toFixed(0)}ms`.padStart(7);
}

function fmtTps(v) {
  if (v == null || v === 0) return " N/A ";
  return `${v.toFixed(1)}`.padStart(5);
}

function colorByLatency(ms, thresholds = [500, 1500, 3000]) {
  if (ms < thresholds[0]) return C.green;
  if (ms < thresholds[1]) return C.yellow;
  return C.red;
}

function printStatsRow(label, stats, unit = "ms") {
  if (!stats) {
    console.log(`  ${label.padEnd(10)}   —`);
    return;
  }
  const fmt = unit === "ms" ? fmtMs : fmtTps;
  const color = unit === "ms" ? colorByLatency(stats.avg) : C.cyan;

  console.log(
    `  ${label.padEnd(10)} ${color}${fmt(stats.min)}${C.reset}  ${color}${fmt(stats.p50)}${C.reset}  ${C.bold}${color}${fmt(stats.avg)}${C.reset}  ${color}${fmt(stats.p95)}${C.reset}  ${color}${fmt(stats.max)}${C.reset}  ${C.dim}±${fmt(stats.stddev)}${C.reset}`
  );
}

function printModelHeader() {
  console.log(
    `  ${"Metric".padEnd(10)} ${"Min".padStart(7)}  ${"P50".padStart(7)}  ${"  Avg".padStart(7)}  ${"P95".padStart(7)}  ${"Max".padStart(7)}  ${"StdDev".padStart(8)}`
  );
  console.log(`  ${"-".repeat(72)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 进度指示
// ─────────────────────────────────────────────────────────────────────────────
function progressBar(current, total, width = 20) {
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${current}/${total}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  const env = loadEnv();
  const BASE_URL = opts.url || `http://localhost:${env.PORT || "6628"}`;
  const API_KEY = process.env.API_KEY || env.API_KEY || "";

  if (!API_KEY) {
    console.error("Error: API_KEY not found. Set it in .env or pass via environment variable.");
    process.exit(1);
  }

  const prompt = PROMPTS[opts.promptSize];
  if (!prompt) {
    console.error(`Invalid prompt size: ${opts.promptSize}. Use: short, medium, long`);
    process.exit(1);
  }

  // ── 获取模型列表 ──────────────────────────────────────────────────────────
  console.log(`\n${C.bgBlue}${C.white}${C.bold} ⚡ CopilotProxyServer Latency Benchmark ${C.reset}\n`);
  console.log(`  Server:      ${C.cyan}${BASE_URL}${C.reset}`);
  console.log(`  Prompt:      ${prompt.label}`);
  console.log(`  Max Tokens:  ${opts.maxTokens}`);
  console.log(`  Rounds:      ${opts.rounds} ${opts.warmup ? "(+ 1 warmup)" : ""}`);
  console.log(`  Time:        ${new Date().toISOString()}`);

  let availableModels;
  try {
    const res = await fetch(`${BASE_URL}/v1/models`, {
      headers: makeHeaders(API_KEY),
    });
    const data = await res.json();
    availableModels = data.data?.map((m) => m.id) || [];
  } catch (e) {
    console.error(`\n  ${C.red}Failed to fetch models: ${e.message}${C.reset}`);
    process.exit(1);
  }

  const models = selectModels(availableModels, opts.models);
  console.log(`  Models:      ${models.length} selected`);
  for (const m of models) {
    console.log(`               ${C.dim}• ${m}${C.reset}`);
  }

  // ── 运行基准测试 ──────────────────────────────────────────────────────────
  const allResults = {};
  const totalTests = models.length * (opts.rounds + (opts.warmup ? 1 : 0));
  let completedTests = 0;

  console.log(`\n${"═".repeat(80)}`);

  for (const model of models) {
    console.log(`\n${C.bold}${C.cyan}  ▸ ${model}${C.reset}`);
    const rounds = [];
    const totalRounds = opts.rounds + (opts.warmup ? 1 : 0);

    for (let i = 0; i < totalRounds; i++) {
      const isWarmup = opts.warmup && i === 0;
      const roundLabel = isWarmup
        ? `${C.dim}warmup${C.reset}`
        : `round ${i - (opts.warmup ? 1 : 0) + 1}/${opts.rounds}`;

      process.stdout.write(
        `    ${progressBar(i + 1, totalRounds)} ${roundLabel} ... `
      );

      try {
        const result = await measureStream(
          BASE_URL,
          API_KEY,
          model,
          prompt.messages,
          opts.maxTokens
        );

        if (isWarmup) {
          console.log(
            `${C.dim}TTFT=${fmtMs(result.ttft_ms).trim()} Total=${fmtMs(result.total_ms).trim()} (discarded)${C.reset}`
          );
        } else {
          const ttftColor = colorByLatency(result.ttft_ms);
          console.log(
            `TTFT=${ttftColor}${fmtMs(result.ttft_ms).trim()}${C.reset}  Total=${fmtMs(result.total_ms).trim()}  TPS=${C.cyan}${fmtTps(result.tps).trim()}${C.reset}  Tokens=${result.completion_tokens}`
          );
          rounds.push(result);
        }
      } catch (e) {
        console.log(`${C.red}ERROR: ${e.message}${C.reset}`);
        // 记录失败但继续
        if (!isWarmup) {
          rounds.push({
            ttft_ms: null,
            total_ms: null,
            generation_ms: null,
            tps: null,
            completion_tokens: 0,
            error: e.message,
          });
        }
      }

      completedTests++;

      // 间隔 1 秒避免触发 rate limit
      if (i < totalRounds - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // 计算统计
    const validRounds = rounds.filter((r) => r.ttft_ms != null);
    const stats = {
      model,
      rounds: rounds.length,
      valid_rounds: validRounds.length,
      errors: rounds.filter((r) => r.error).map((r) => r.error),
      ttft: computeStats(validRounds.map((r) => r.ttft_ms)),
      total: computeStats(validRounds.map((r) => r.total_ms)),
      generation: computeStats(validRounds.map((r) => r.generation_ms)),
      tps: computeStats(validRounds.map((r) => r.tps)),
      completion_tokens: computeStats(
        validRounds.map((r) => r.completion_tokens)
      ),
      raw: rounds,
    };
    allResults[model] = stats;

    // 模型小结
    if (validRounds.length > 0) {
      console.log();
      printModelHeader();
      printStatsRow("TTFT", stats.ttft, "ms");
      printStatsRow("Total", stats.total, "ms");
      printStatsRow("Gen", stats.generation, "ms");
      printStatsRow("TPS", stats.tps, "tps");
    }

    // 模型间等待
    if (model !== models[models.length - 1]) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // ── 汇总对比表 ────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(80)}`);
  console.log(`${C.bold}${C.white}  📊 Summary — TTFT (首 Token 延迟)${C.reset}`);
  console.log(`${"═".repeat(80)}`);
  console.log(
    `  ${"Model".padEnd(35)} ${"Min".padStart(7)}  ${"P50".padStart(7)}  ${"  Avg".padStart(7)}  ${"P95".padStart(7)}  ${"Max".padStart(7)}`
  );
  console.log(`  ${"-".repeat(74)}`);

  // 按 TTFT avg 排序
  const sortedByTtft = Object.values(allResults)
    .filter((s) => s.ttft)
    .sort((a, b) => a.ttft.avg - b.ttft.avg);

  for (const stats of sortedByTtft) {
    const s = stats.ttft;
    const color = colorByLatency(s.avg);
    console.log(
      `  ${stats.model.padEnd(35)} ${color}${fmtMs(s.min)}${C.reset}  ${color}${fmtMs(s.p50)}${C.reset}  ${C.bold}${color}${fmtMs(s.avg)}${C.reset}  ${color}${fmtMs(s.p95)}${C.reset}  ${color}${fmtMs(s.max)}${C.reset}`
    );
  }

  // 失败的模型
  const failedModels = Object.values(allResults).filter((s) => !s.ttft);
  if (failedModels.length > 0) {
    for (const stats of failedModels) {
      console.log(
        `  ${stats.model.padEnd(35)} ${C.red}FAILED${C.reset}  ${C.dim}${stats.errors[0] || ""}${C.reset}`
      );
    }
  }

  console.log(`\n${"═".repeat(80)}`);
  console.log(`${C.bold}${C.white}  📊 Summary — Total Duration (完整响应)${C.reset}`);
  console.log(`${"═".repeat(80)}`);
  console.log(
    `  ${"Model".padEnd(35)} ${"Min".padStart(7)}  ${"P50".padStart(7)}  ${"  Avg".padStart(7)}  ${"P95".padStart(7)}  ${"Max".padStart(7)}`
  );
  console.log(`  ${"-".repeat(74)}`);

  const sortedByTotal = Object.values(allResults)
    .filter((s) => s.total)
    .sort((a, b) => a.total.avg - b.total.avg);

  for (const stats of sortedByTotal) {
    const s = stats.total;
    const color = colorByLatency(s.avg, [2000, 5000, 10000]);
    console.log(
      `  ${stats.model.padEnd(35)} ${color}${fmtMs(s.min)}${C.reset}  ${color}${fmtMs(s.p50)}${C.reset}  ${C.bold}${color}${fmtMs(s.avg)}${C.reset}  ${color}${fmtMs(s.p95)}${C.reset}  ${color}${fmtMs(s.max)}${C.reset}`
    );
  }

  console.log(`\n${"═".repeat(80)}`);
  console.log(`${C.bold}${C.white}  📊 Summary — TPS (Token/s 生成速度)${C.reset}`);
  console.log(`${"═".repeat(80)}`);
  console.log(
    `  ${"Model".padEnd(35)} ${"Min".padStart(7)}  ${"P50".padStart(7)}  ${"  Avg".padStart(7)}  ${"P95".padStart(7)}  ${"Max".padStart(7)}`
  );
  console.log(`  ${"-".repeat(74)}`);

  const sortedByTps = Object.values(allResults)
    .filter((s) => s.tps)
    .sort((a, b) => b.tps.avg - a.tps.avg); // TPS 越高越好

  for (const stats of sortedByTps) {
    const s = stats.tps;
    console.log(
      `  ${stats.model.padEnd(35)} ${C.cyan}${fmtTps(s.min)}${C.reset}  ${C.cyan}${fmtTps(s.p50)}${C.reset}  ${C.bold}${C.cyan}${fmtTps(s.avg)}${C.reset}  ${C.cyan}${fmtTps(s.p95)}${C.reset}  ${C.cyan}${fmtTps(s.max)}${C.reset}`
    );
  }

  console.log(`\n${"═".repeat(80)}`);

  // ── 导出 JSON ─────────────────────────────────────────────────────────────
  if (opts.output) {
    const exportData = {
      metadata: {
        server: BASE_URL,
        prompt_size: opts.promptSize,
        max_tokens: opts.maxTokens,
        rounds: opts.rounds,
        warmup: opts.warmup,
        timestamp: new Date().toISOString(),
      },
      models: Object.fromEntries(
        Object.entries(allResults).map(([model, stats]) => [
          model,
          {
            ttft: stats.ttft,
            total: stats.total,
            generation: stats.generation,
            tps: stats.tps,
            completion_tokens: stats.completion_tokens,
            valid_rounds: stats.valid_rounds,
            errors: stats.errors,
          },
        ])
      ),
    };
    writeFileSync(opts.output, JSON.stringify(exportData, null, 2));
    console.log(`\n  ${C.green}Results saved to ${opts.output}${C.reset}`);
  }

  console.log();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
