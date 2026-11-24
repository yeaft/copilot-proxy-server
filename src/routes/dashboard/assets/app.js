"use strict";
// Adapted from llm-proxy's dashboard/app.js; GET /dashboard/api/metrics returns the same report shape.

const $ = (id) => document.getElementById(id);
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const LOW_SAMPLE = 5;
const COMPARE_LIMIT = 15;
const LIVE_INTERVAL = 30_000;
const THEME_KEY = "copilot-proxy.dashboard.theme";
const LIVE_KEY = "copilot-proxy.dashboard.live";
// Model colors avoid the red used for failures and the gray used for "Other".
const PALETTE = ["#5b6cff", "#f59e0b", "#14b8a6", "#ec4899", "#a855f7", "#22c55e", "#0ea5e9", "#f97316", "#84cc16", "#d946ef"];
const OTHER = "#9ca3af";
const FAIL = "#ef4444";
const TOKEN_COLORS = { input: "#5b6cff", output: "#a855f7", input_cache_read: "#14b8a6", input_cache_write: "#f59e0b", output_cache_read: "#0ea5e9", output_cache_write: "#f97316" };
const TOKEN_LABELS = { input: "Input", output: "Output", input_cache_read: "Input cache read", input_cache_write: "Input cache write", output_cache_read: "Output cache read", output_cache_write: "Output cache write" };

const numberFormat = new Intl.NumberFormat();
const compactFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const stampFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayHourFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric" });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const trim = (value) => String(Number(value.toFixed(2)));
const count = (value) => value == null ? "—" : numberFormat.format(value);
const compact = (value) => value == null ? "—" : compactFormat.format(value);
const percent = (value) => value == null ? "—" : `${value.toFixed(1)}%`;
const speed = (value) => value == null ? "—" : `${value.toFixed(value < 10 ? 1 : 0)} tok/s`;
const plural = (value, word) => `${count(value)} ${word}${value === 1 ? "" : "s"}`;
function duration(value) {
  if (value == null) return "—";
  if (value < 999.5) return `${Math.round(value)} ms`;
  if (value < 59_950) return `${(value / 1000).toFixed(value < 9_995 ? 2 : 1)} s`;
  const seconds = Math.round(value / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
function axisDuration(value) {
  if (value === 0) return "0";
  if (value < 1000) return `${trim(value)}ms`;
  return value < 120_000 ? `${trim(value / 1000)}s` : `${trim(value / MINUTE)}m`;
}
const successRate = (entry) => entry.requests ? (entry.requests - entry.errors) / entry.requests * 100 : null;
const grade = (rate) => rate == null ? "" : rate >= 99 ? "good" : rate >= 95 ? "warn" : "bad";

const text = (id, value) => { $(id).textContent = value; };
function add(parent, tag, content, className) {
  const child = document.createElement(tag);
  if (content) child.textContent = content;
  if (className) child.className = className;
  parent.append(child);
  return child;
}
function svgNode(name, attrs, label) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (label !== undefined) node.textContent = label;
  return node;
}
const tint = (node, color) => { node.style.setProperty("--c", color); return node; };
function store(key, value) { try { localStorage.setItem(key, value); } catch { /* storage may be disabled */ } }
function stored(key) { try { return localStorage.getItem(key); } catch { return null; } }

/* Providers & colors. Copilot models are unprefixed and untagged; the proxy routes deepseek* models to DeepSeek. */
const MODEL_GROUPS = ["Copilot", "DeepSeek", "Other"];
function describe(model) {
  if (!model || model === "(unresolved)") return { id: "unknown", label: "", group: "Other", name: model || "Unknown model" };
  if (model.toLowerCase().startsWith("deepseek")) return { id: "deepseek", label: "DeepSeek", group: "DeepSeek", name: model };
  return { id: "copilot", label: "", group: "Copilot", name: model };
}
const fullName = (model) => { const info = describe(model); return info.label ? `${info.name} · ${info.label}` : info.name; };
let colors = new Map();
function colorFor(model) {
  if (!colors.has(model)) colors.set(model, PALETTE[colors.size % PALETTE.length]);
  return colors.get(model);
}

/* State, persisted in the URL so reloads and bookmarks keep the view */
const RANGES = ["1", "6", "24", "168", "720", "custom"];
const COMPARE = {
  latency: { note: "End-to-end duration of completed requests; failures and cancellations are excluded (see Success). Shorter bars are faster.", lowerIsBetter: true },
  "latency-avg": { note: "Average end-to-end latency of completed requests. Failures and cancellations are excluded.", lowerIsBetter: true },
  ttft: { note: "Time until the first streamed token. Shorter bars respond sooner.", lowerIsBetter: true },
  speed: { note: "Visible output tokens per second after the first token, on successful streamed requests; reasoning tokens are excluded. Longer bars generate faster." },
  success: { note: "Share of requests without an HTTP, stream, or proxy failure." },
  volume: { note: "Requests per model in this range." },
};
const MODEL_METRICS = {
  "latency-p50": { note: "Median latency of completed requests per bucket.", pick: (point) => point.completed_latency_ms.p50, format: duration, axis: axisDuration },
  "latency-p95": { note: "95th percentile latency of completed requests per bucket.", pick: (point) => point.completed_latency_ms.p95, format: duration, axis: axisDuration },
  "latency-avg": { note: "Average end-to-end latency of completed requests per bucket. Gaps mean no completed requests.", pick: (point) => point.completed_latency_ms.avg, format: duration, axis: axisDuration },
  "ttft-p50": { note: "Median time to first token per bucket.", pick: (point) => point.ttft_ms.p50, format: duration, axis: axisDuration },
  speed: { note: "Median visible output tokens per second per bucket (reasoning excluded).", pick: (point) => point.output_tps.p50, format: speed, axis: compact },
};
const TOKEN_VIEWS = ["totals", "cache", "cache-rate"];
const state = {
  range: "24", from: null, to: null, model: "", step: "auto",
  compare: "latency", sort: "best", modelMetric: "latency-p50", tokenView: "totals",
  table: { key: "requests", descending: true }, hidden: new Set(), customOpen: false,
};
let data = null;
let pending = null;
let liveTimer = null;
const charts = {};

const validWindow = (from, to) => Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from && to - from <= 31 * DAY;
function loadState() {
  const params = new URLSearchParams(location.search);
  const pick = (key, allowed, fallback) => allowed.includes(params.get(key)) ? params.get(key) : fallback;
  state.range = pick("range", RANGES, "24");
  if (state.range === "custom") {
    const from = Number(params.get("from"));
    const to = Number(params.get("to"));
    if (validWindow(from, to)) Object.assign(state, { from, to, customOpen: true });
    else state.range = "24";
  }
  state.model = (params.get("model") || "").slice(0, 4096);
  state.step = pick("step", [...$("step").options].map((option) => option.value), "auto");
  state.compare = pick("compare", Object.keys(COMPARE), "latency");
  state.sort = pick("sort", ["best", "traffic"], "best");
  state.modelMetric = pick("trend", Object.keys(MODEL_METRICS), "latency-p50");
  state.tokenView = pick("tokens", TOKEN_VIEWS, "totals");
}
function saveState() {
  const params = new URLSearchParams();
  if (state.range !== "24") params.set("range", state.range);
  if (state.range === "custom") { params.set("from", state.from); params.set("to", state.to); }
  if (state.model) params.set("model", state.model);
  if (state.step !== "auto") params.set("step", state.step);
  if (state.compare !== "latency") params.set("compare", state.compare);
  if (state.sort !== "best") params.set("sort", state.sort);
  if (state.modelMetric !== "latency-p50") params.set("trend", state.modelMetric);
  if (state.tokenView !== "totals") params.set("tokens", state.tokenView);
  const query = params.toString();
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
}
function currentWindow() {
  if (state.range === "custom") return { from: state.from, to: state.to };
  const to = Date.now();
  return { from: to - Number(state.range) * HOUR, to };
}
const localInput = (time) => { const date = new Date(time); return new Date(time - date.getTimezoneOffset() * MINUTE).toISOString().slice(0, 16); };

/* Segmented controls */
function segmented(id, onChange) {
  const group = $(id);
  group.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (button) onChange(button.dataset.value);
  });
  return (value) => group.querySelectorAll("button[data-value]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.value === value)));
}

/* Charts */
function niceCeiling(max, integer) {
  if (!(max > 0)) return integer ? 4 : 1;
  const raw = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  let step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
  if (integer) step = Math.max(1, Math.ceil(step));
  return step * 4;
}
function timeTicks(from, to, width) {
  const span = to - from;
  const format = span <= 36 * HOUR ? clockFormat : span <= 8 * DAY ? dayHourFormat : dayFormat;
  const total = Math.max(2, Math.min(7, Math.floor((width - 60) / 130)));
  return Array.from({ length: total }, (_, index) => {
    const time = from + span * index / (total - 1);
    return { time, label: format.format(time) };
  });
}
const bucketLabel = (bucket) => `${stampFormat.format(bucket.start)} – ${(bucket.end - bucket.start < DAY ? clockFormat : stampFormat).format(bucket.end)}`;

function legend(name, series, options) {
  const container = $(`${name}-legend`);
  container.replaceChildren();
  for (const item of series) {
    const node = tint(document.createElement(options.toggle ? "button" : "span"), item.color);
    node.className = "legend-item";
    add(node, "span", "", "swatch");
    if (item.provider?.label) add(node, "span", item.provider.label, `provider ${item.provider.id}`);
    add(node, "span", item.label, "label");
    if (item.title) node.title = item.title;
    if (options.toggle) {
      node.type = "button";
      node.setAttribute("aria-pressed", String(!state.hidden.has(item.key)));
      node.addEventListener("click", () => {
        if (!state.hidden.delete(item.key)) state.hidden.add(item.key);
        options.onToggle();
      });
    }
    container.append(node);
  }
}

/**
 * Time-bucketed chart: `bar` series stack, `line` series draw on top with gaps for nulls.
 * The viewBox matches the rendered width so text stays at its real size.
 */
function timeChart(name, series, options) {
  charts[name] = () => timeChart(name, series, options);
  legend(name, series, options);
  const root = $(`${name}-chart`);
  const box = root.parentElement;
  const tip = $(`${name}-tooltip`);
  const empty = $(`${name}-empty`);
  const width = Math.max(260, Math.floor(box.clientWidth) || 900);
  const height = width < 520 ? 210 : 260;
  root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  root.setAttribute("width", width);
  root.setAttribute("height", height);
  root.replaceChildren();
  tip.hidden = true;
  const { from, to, trend } = data;
  const visible = series.filter((item) => !state.hidden.has(item.key) || !options.toggle);
  const bars = visible.filter((item) => item.type === "bar");
  const lines = visible.filter((item) => item.type !== "bar");
  const stacks = trend.map((_, index) => bars.reduce((sum, item) => sum + (item.values[index] ?? 0), 0));
  const values = [...stacks, ...lines.flatMap((item) => item.values.filter((value) => value != null))];
  const ceiling = options.ceiling ?? niceCeiling(Math.max(0, ...values), options.integer);
  const axis = options.axis || compact;
  const ticks = [0, 1, 2, 3, 4].map((index) => ceiling * index / 4);
  const labels = ticks.map(axis);
  const left = Math.max(...labels.map((label) => label.length)) * 6.6 + 14;
  const right = width - 8;
  const top = 10;
  const bottom = height - 26;
  const x = (time) => left + (time - from) / (to - from) * (right - left);
  const y = (value) => bottom - Math.min(value, ceiling) / ceiling * (bottom - top);
  ticks.forEach((tick, index) => {
    root.append(svgNode("line", { x1: left, x2: right, y1: y(tick), y2: y(tick), class: index ? "gridline" : "gridline base" }));
    root.append(svgNode("text", { x: left - 8, y: y(tick) + 4, "text-anchor": "end", class: "axis-label" }, labels[index]));
  });
  const timeLabels = timeTicks(from, to, width);
  timeLabels.forEach((tick, index) => {
    const anchor = index === 0 ? "start" : index === timeLabels.length - 1 ? "end" : "middle";
    root.append(svgNode("text", { x: x(tick.time), y: height - 6, "text-anchor": anchor, class: "axis-label" }, tick.label));
  });
  empty.hidden = !options.empty;
  if (options.emptyText) empty.textContent = options.emptyText;
  if (bars.length) {
    trend.forEach((bucket, index) => {
      const x0 = x(bucket.start);
      const span = x(bucket.end) - x0;
      const barWidth = Math.max(1, span * (span > 6 ? 0.72 : 0.9));
      let stacked = 0;
      for (const item of bars) {
        const value = item.values[index] ?? 0;
        if (value <= 0) continue;
        const y1 = y(stacked);
        const y2 = y(stacked + value);
        root.append(svgNode("rect", { x: x0 + (span - barWidth) / 2, y: y2, width: barWidth, height: Math.max(0.75, y1 - y2), rx: Math.min(2, barWidth / 3), fill: item.color, class: "bar-segment" }));
        stacked += value;
      }
    });
  }
  const center = (bucket) => x((bucket.start + bucket.end) / 2);
  for (const item of lines) {
    let path = "";
    let segment = [];
    const segments = [];
    item.values.forEach((value, index) => {
      if (value == null) { if (segment.length) segments.push(segment); segment = []; return; }
      segment.push([center(trend[index]), y(value)]);
    });
    if (segment.length) segments.push(segment);
    for (const points of segments) {
      path += points.map(([px, py], index) => `${index ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ") + " ";
      if (item.area && points.length > 1) {
        const area = `M${points[0][0].toFixed(1)},${bottom} ` + points.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join(" ") + ` L${points.at(-1)[0].toFixed(1)},${bottom} Z`;
        root.append(svgNode("path", { d: area, fill: item.color, class: "trend-area" }));
      }
    }
    if (path) root.append(svgNode("path", { d: path, stroke: item.color, class: "trend-line" }));
    item.values.forEach((value, index) => {
      if (value == null) return;
      const isolated = item.values[index - 1] == null && item.values[index + 1] == null;
      if (isolated || trend.length <= 60) root.append(svgNode("circle", { cx: center(trend[index]), cy: y(value), r: isolated ? 3.5 : 2.6, fill: item.color, class: "trend-point" }));
    });
  }
  if (options.empty) return;

  const crosshair = svgNode("line", { x1: 0, x2: 0, y1: top, y2: bottom, class: "crosshair" });
  root.append(crosshair);
  const describeBucket = (index) => {
    const rows = visible.map((item) => [item, (item.format || options.format)(item.values[index])]);
    return { rows, label: `${bucketLabel(trend[index])} · ${rows.map(([item, value]) => `${item.tooltipLabel || item.label}: ${value}`).join(" · ")}` };
  };
  const show = (index) => {
    const bucket = trend[index];
    const cx = center(bucket);
    crosshair.setAttribute("x1", cx);
    crosshair.setAttribute("x2", cx);
    crosshair.classList.add("on");
    tip.replaceChildren();
    add(tip, "div", bucketLabel(bucket), "tooltip-title");
    for (const [item, value] of describeBucket(index).rows) {
      const row = tint(add(tip, "div", "", "tooltip-row"), item.color);
      add(row, "span", "", "dot");
      add(row, "span", item.tooltipLabel || item.label, "label");
      add(row, "b", value);
    }
    if (options.total && bars.length > 1) {
      const row = add(tip, "div", "", "tooltip-row total");
      add(row, "span", "");
      add(row, "span", "Total", "label");
      add(row, "b", options.format(stacks[index]));
    }
    tip.hidden = false;
    const flip = cx > width * 0.6;
    tip.classList.toggle("flip", flip);
    tip.style.left = `${flip ? cx - 12 : cx + 12}px`;
  };
  const hide = () => { tip.hidden = true; crosshair.classList.remove("on"); };
  trend.forEach((bucket, index) => {
    const hit = svgNode("rect", {
      x: x(bucket.start), y: top, width: Math.max(1, x(bucket.end) - x(bucket.start)), height: bottom - top,
      tabindex: index === 0 ? 0 : -1, role: "img", "aria-label": describeBucket(index).label, class: "chart-hit",
    });
    hit.addEventListener("mouseenter", () => show(index));
    hit.addEventListener("focus", () => show(index));
    hit.addEventListener("blur", hide);
    hit.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const hits = [...root.querySelectorAll(".chart-hit")];
      const target = event.key === "Home" ? 0 : event.key === "End" ? hits.length - 1
        : Math.max(0, Math.min(hits.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
      hit.setAttribute("tabindex", "-1");
      hits[target].setAttribute("tabindex", "0");
      hits[target].focus();
    });
    root.append(hit);
  });
  root.onmouseleave = () => { if (!root.contains(document.activeElement)) hide(); };
}

/** Bars for counts and sparse series; a line only when most buckets have a value. */
function spark(id, values, kind = "auto") {
  const root = $(id);
  root.replaceChildren();
  root.setAttribute("viewBox", "0 0 100 30");
  root.setAttribute("preserveAspectRatio", "none");
  const present = values.filter((value) => value != null);
  if (!present.length) return;
  const max = Math.max(...present);
  const y = (value) => max > 0 ? 28 - value / max * 24 : 28;
  const total = values.length;
  if (kind === "bar" || present.length < total * 0.6) {
    const slot = 100 / total;
    values.forEach((value, index) => {
      if (value > 0) root.append(svgNode("rect", { x: index * slot + slot * 0.15, y: y(value), width: Math.max(slot * 0.7, 0.6), height: 30 - y(value) }));
    });
    return;
  }
  const x = (index) => total === 1 ? 50 : index / (total - 1) * 100;
  let line = "";
  let area = "";
  let run = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length === 1) run = [[run[0][0] - 0.8, run[0][1]], [run[0][0] + 0.8, run[0][1]]];
    line += run.map(([px, py], index) => `${index ? "L" : "M"}${px.toFixed(2)},${py.toFixed(2)}`).join(" ") + " ";
    area += `M${run[0][0].toFixed(2)},30 ` + run.map(([px, py]) => `L${px.toFixed(2)},${py.toFixed(2)}`).join(" ") + ` L${run.at(-1)[0].toFixed(2)},30 Z `;
    run = [];
  };
  values.forEach((value, index) => { if (value == null) flush(); else run.push([x(index), y(value)]); });
  flush();
  root.append(svgNode("path", { d: area, class: "area" }), svgNode("path", { d: line, class: "line" }));
}

function donut(id, items, total, unit) {
  const container = $(`${id}-chart`);
  const list = $(`${id}-legend`);
  container.replaceChildren();
  list.replaceChildren();
  const root = svgNode("svg", { viewBox: "0 0 132 132", role: "img", "aria-label": `${count(total)} ${unit}. Breakdown listed alongside.` });
  root.append(svgNode("circle", { cx: 66, cy: 66, r: 52, class: "donut-track" }));
  const circumference = 2 * Math.PI * 52;
  let offset = 0;
  for (const item of items) {
    if (item.value > 0 && total > 0) {
      const length = item.value / total * circumference;
      const arc = svgNode("circle", { cx: 66, cy: 66, r: 52, fill: "none", stroke: item.color, "stroke-width": 16,
        "stroke-dasharray": `${Math.max(0, length - (items.length > 1 ? 1.5 : 0))} ${circumference}`, "stroke-dashoffset": -offset, transform: "rotate(-90 66 66)" });
      arc.append(svgNode("title", {}, `${item.label}: ${count(item.value)}`));
      root.append(arc);
      offset += length;
    }
    const row = add(list, "li", "");
    tint(add(row, "span", "", "dot"), item.color);
    add(row, "span", item.label, "name");
    add(row, "span", count(item.value), "value");
    add(row, "span", item.value == null || !total ? "—" : `${(item.value / total * 100).toFixed(1)}%`, "share");
  }
  root.append(svgNode("text", { x: 66, y: 68, "text-anchor": "middle", class: "donut-value" }, total == null ? "—" : compact(total)));
  root.append(svgNode("text", { x: 66, y: 86, "text-anchor": "middle", class: "donut-label" }, unit));
  container.append(root);
  if (!items.length) add(list, "li", "No requests in this range.", "empty-note");
}

/* Shared row pieces */
function modelButton(model) {
  const info = describe(model);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "model-link";
  button.title = model === state.model ? model : `${model} — focus the dashboard on this model`;
  add(button, "span", "", "swatch");
  if (info.label) add(button, "span", info.label, `provider ${info.id}`);
  add(button, "span", info.name, "model-name");
  if (model === state.model) button.disabled = true;
  else button.addEventListener("click", () => focusModel(model));
  return button;
}
function bar(parts, label, className = "") {
  const node = document.createElement("div");
  node.className = `bar ${className}`.trim();
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", label);
  for (const part of parts) {
    const span = add(node, "span", "", part.className || "");
    const start = Math.max(0, Math.min(100, part.from ?? 0));
    if (part.at != null) span.style.left = `${Math.max(0, Math.min(100, part.at))}%`;
    else {
      span.style.left = `${start}%`;
      span.style.width = `${Math.max(0, Math.min(100, part.to) - start)}%`;
    }
  }
  return node;
}

/* Sections */
function renderKpis() {
  const summary = data.summary;
  const trend = data.trend;
  text("requests", count(summary.requests));
  const perMinute = summary.requests / ((data.to - data.from) / MINUTE);
  text("requests-detail", `${perMinute.toLocaleString(undefined, { maximumFractionDigits: 2 })} / min · ${plural(data.models.length, "model")}`);
  spark("spark-requests", trend.map((bucket) => bucket.requests), "bar");
  const rate = successRate(summary);
  text("success", percent(rate));
  $("success").className = grade(rate);
  text("errors-detail", !summary.requests ? "No requests" : summary.errors ? `${count(summary.errors)} failed` : "No failures");
  spark("spark-success", trend.map((bucket) => bucket.errors), "bar");
  const latency = summary.completed_latency_ms;
  text("latency", duration(latency.p50));
  text("latency-detail", latency.count ? `P95 ${duration(latency.p95)} · avg ${duration(latency.avg)}` : "No completed requests");
  spark("spark-latency", trend.map((bucket) => bucket.completed_latency_ms.p50));
  text("ttft", duration(summary.ttft_ms.p50));
  text("ttft-detail", summary.ttft_ms.count ? `P95 ${duration(summary.ttft_ms.p95)} · n=${count(summary.ttft_ms.count)}` : "Streamed requests only");
  spark("spark-ttft", trend.map((bucket) => bucket.ttft_ms.p50));
  text("speed", speed(summary.output_tps.p50));
  text("speed-detail", summary.output_tps.count ? `overall ${speed(summary.output_tps.overall)} · n=${count(summary.output_tps.count)}` : "Needs streamed output usage");
  spark("spark-speed", trend.map((bucket) => bucket.output_tps.p50));
  const tokens = (usage) => usage.input.tokens == null && usage.output.tokens == null ? null : (usage.input.tokens ?? 0) + (usage.output.tokens ?? 0);
  text("tokens-total", compact(tokens(summary.usage)));
  text("tokens-detail", `${compact(summary.usage.input.tokens)} in · ${compact(summary.usage.output.tokens)} out`);
  spark("spark-tokens", trend.map((bucket) => tokens(bucket.usage)), "bar");
}

function measure(entry, metric) {
  if (metric === "latency-avg") {
    const values = entry.completed_latency_ms;
    return { key: values.avg, samples: values.count, primary: duration(values.avg) };
  }
  if (metric === "latency" || metric === "ttft") {
    const values = metric === "latency" ? entry.completed_latency_ms : entry.ttft_ms;
    return { key: values.p50, samples: values.count, values, primary: duration(values.p50),
      secondary: values.count ? `P95 ${duration(values.p95)} · P99 ${duration(values.p99)}` : "" };
  }
  if (metric === "speed") {
    const values = entry.output_tps;
    return { key: values.p50, samples: values.count, primary: speed(values.p50), secondary: values.count ? `overall ${speed(values.overall)}` : "" };
  }
  if (metric === "success") {
    const rate = successRate(entry);
    return { key: rate, samples: entry.requests, primary: percent(rate), secondary: entry.errors ? `${count(entry.errors)} failed` : "no failures" };
  }
  const share = data.summary.requests ? entry.requests / data.summary.requests * 100 : null;
  return { key: entry.requests, samples: entry.requests, primary: count(entry.requests), secondary: `${percent(share)} of traffic` };
}
function renderCompare() {
  const metric = state.compare;
  const config = COMPARE[metric];
  const list = $("compare");
  const legendNode = $("compare-legend");
  list.replaceChildren();
  legendNode.replaceChildren();
  const busiest = data.models.slice(0, COMPARE_LIMIT);
  const hiddenCount = data.models.length - busiest.length;
  text("compare-note", config.note + (hiddenCount > 0 ? ` Showing the ${COMPARE_LIMIT} busiest of ${count(data.models.length)} models.` : ""));
  const rows = busiest.map((entry) => ({ entry, measured: measure(entry, metric) }));
  const direction = config.lowerIsBetter ? 1 : -1;
  rows.sort((a, b) => state.sort === "traffic"
    ? b.entry.requests - a.entry.requests || a.entry.model.localeCompare(b.entry.model)
    : (a.measured.key == null) - (b.measured.key == null) || direction * ((a.measured.key ?? 0) - (b.measured.key ?? 0)) || b.entry.requests - a.entry.requests);
  const showPercentiles = metric === "latency" || metric === "ttft";
  const scale = metric === "success" ? 100 : Math.max(0, ...rows.map(({ measured }) =>
    (showPercentiles ? measured.values.p95 ?? measured.values.p50 : measured.key) ?? 0));
  const legendItem = (label, className) => { const item = add(legendNode, "span", ""); add(item, "i", "", className); item.append(label); };
  if (showPercentiles) {
    legendItem("P50 (typical)");
    legendItem("up to P95", "range");
    legendItem("P99", "tick");
    if (scale) add(legendNode, "span", `Scale 0 – ${duration(scale)}`, "scale");
  } else if (metric === "latency-avg") {
    legendItem("Latency Avg");
    if (scale) add(legendNode, "span", `Scale 0 – ${duration(scale)}`, "scale");
  } else if (metric === "speed") {
    legendItem("Median tok/s");
    if (scale) add(legendNode, "span", `Scale 0 – ${speed(scale)}`, "scale");
  } else if (metric === "success") {
    add(legendNode, "span", "Green ≥ 99% · amber ≥ 95% · red below");
  } else {
    legendItem("Requests");
    add(legendNode, "span", `Total ${count(data.summary.requests)}`, "scale");
  }
  rows.forEach(({ entry, measured }, index) => {
    const low = metric !== "volume" && measured.samples > 0 && measured.samples < LOW_SAMPLE;
    const row = tint(add(list, "li", "", `cmp-row${low ? " low" : ""}`), colorFor(entry.model));
    add(row, "span", String(index + 1), "rank");
    const name = add(row, "div", "", "cmp-name");
    name.append(modelButton(entry.model));
    const sub = add(name, "span", "", "cmp-sub");
    add(sub, "span", plural(entry.requests, "request"));
    if ((metric === "latency-avg" || metric === "ttft" || metric === "speed") && measured.samples !== entry.requests) {
      add(sub, "span", `${count(measured.samples)} measured`);
    }
    if (low) add(sub, "span", "few samples", "low-tag");
    const pct = (value) => scale ? value / scale * 100 : 0;
    const label = `${fullName(entry.model)}: ${measured.primary}${measured.secondary ? ` (${measured.secondary})` : ""}`;
    if (measured.key == null) row.append(bar([], `${fullName(entry.model)}: no data`));
    else if (showPercentiles) {
      const { p50, p95, p99 } = measured.values;
      const parts = [{ className: "range", to: pct(p95 ?? p50) }, { to: pct(p50) }];
      if (p99 != null) parts.push({ className: p99 > scale ? "tick over" : "tick", at: Math.min(pct(p99), 99.6) });
      row.append(bar(parts, label));
    } else if (metric === "success") row.append(bar([{ to: measured.key }], label, grade(measured.key)));
    else if (metric === "volume") {
      const ok = entry.requests - entry.errors;
      row.append(bar([{ to: pct(ok) }, { className: "fail", from: pct(ok), to: pct(entry.requests) }], label));
    } else row.append(bar([{ to: pct(measured.key) }], label));
    const value = add(row, "div", "", "cmp-value");
    if (measured.key == null) add(value, "span", metric === "ttft" || metric === "speed" ? "not streamed" : "no data", "none");
    else {
      add(value, "strong", measured.primary);
      if (measured.secondary) add(value, "span", measured.secondary);
    }
  });
  if (!rows.length) add(list, "li", state.model ? "This model has no requests in this range." : "No requests in this range.", "empty");
}

function renderModelChart() {
  const metric = MODEL_METRICS[state.modelMetric];
  const shown = data.model_trend.length;
  text("model-chart-note", `${metric.note}${data.models.length > shown ? ` Showing the ${shown} busiest models.` : ""} Select a model in the legend to show or hide it.`);
  const series = data.model_trend.map((trend) => {
    const info = describe(trend.model);
    return { key: trend.model, label: info.name, tooltipLabel: fullName(trend.model), title: trend.model, provider: info, color: colorFor(trend.model),
      values: trend.points.map((point) => point ? metric.pick(point) : null), type: "line" };
  });
  const measured = series.some((item) => item.values.some((value) => value != null));
  timeChart("model", series, {
    format: metric.format, axis: metric.axis, toggle: true, onToggle: renderModelChart, empty: !measured,
    emptyText: data.summary.requests ? "No measurements for this metric in this range." : "No requests in this range.",
  });
}

const OUTCOME_COLORS = { ok: "#10b981", cancelled: "#9ca3af", timeout: "#f97316", stream_error: "#ec4899", upstream_error: "#e11d48", incomplete: "#a855f7" };
const outcomeLabel = (name) => ({ ok: "Completed", cancelled: "Cancelled", timeout: "Timeout", stream_error: "Stream error", upstream_error: "Upstream error", incomplete: "Incomplete", rejected: "Rejected" })[name]
  || (name.startsWith("http_") ? `HTTP ${name.slice(5)}` : name || "Unknown");
// Stored endpoint labels; anything else (older rows) is shown as stored.
const ENDPOINT_LABELS = {
  openai: "Chat Completions", anthropic: "Messages", responses: "Responses", gemini: "Gemini",
  "deepseek-chat-completions": "DeepSeek · Chat Completions", "deepseek-messages": "DeepSeek · Messages", "deepseek-responses": "DeepSeek · Responses",
};
const outcomeColor = (name) => OUTCOME_COLORS[name] || (name.startsWith("http_4") ? "#f59e0b" : FAIL);
function renderTraffic() {
  const summary = data.summary;
  const series = data.model_trend.map((trend) => {
    const info = describe(trend.model);
    return { key: trend.model, label: info.name, tooltipLabel: fullName(trend.model), title: trend.model, provider: info, color: colorFor(trend.model),
      values: trend.points.map((point) => point ? point.requests : 0), type: "bar" };
  });
  const other = data.trend.map((bucket, index) => bucket.requests - series.reduce((sum, item) => sum + item.values[index], 0));
  if (other.some((value) => value > 0)) series.push({ key: "other", label: "Other models", color: OTHER, values: other, type: "bar" });
  // Zero-failure buckets are gaps, so the line only marks where failures happened.
  if (summary.errors) {
    series.push({ key: "failures", label: "Failures", color: FAIL, values: data.trend.map((bucket) => bucket.errors || null),
      format: (value) => count(value ?? 0), type: "line" });
  }
  timeChart("traffic", series, { format: count, integer: true, total: true, empty: summary.requests === 0 });

  const outcomes = data.results.slice(0, 6).map((item) => ({ label: outcomeLabel(item.name), value: item.requests, color: outcomeColor(item.name) }));
  const rest = summary.requests - outcomes.reduce((sum, item) => sum + item.value, 0);
  if (rest > 0) outcomes.push({ label: "Other outcomes", value: rest, color: OTHER });
  donut("outcomes", outcomes, summary.requests, "requests");

  const endpoints = $("endpoints");
  endpoints.replaceChildren();
  const items = data.endpoints.slice(0, 6).map((item) => ({ label: ENDPOINT_LABELS[item.name] || item.name || "Unknown endpoint", title: item.name, value: item.requests }));
  const others = summary.requests - items.reduce((sum, item) => sum + item.value, 0);
  if (others > 0) items.push({ label: "Other endpoints", value: others });
  for (const item of items) {
    const row = add(endpoints, "li", "");
    const name = add(row, "span", item.label, "name");
    if (item.title) name.title = item.title;
    add(row, "span", `${count(item.value)} · ${(item.value / summary.requests * 100).toFixed(1)}%`, "value");
    row.append(bar([{ to: item.value / summary.requests * 100 }], `${item.label}: ${count(item.value)} requests`));
  }
  if (!items.length) add(endpoints, "li", "No requests in this range.", "empty-note");
}

function renderTokenChart() {
  const summary = data.summary;
  const view = state.tokenView;
  if (view === "cache-rate") {
    text("token-chart-note", "Input cache reads ÷ input tokens on requests reporting both. Gaps mean no valid denominator.");
    const values = data.trend.map((bucket) => bucket.input_cache_rate.percent);
    timeChart("token", [{ key: "rate", label: "Input cache hit rate", color: TOKEN_COLORS.input_cache_read, values, area: true }], {
      format: percent, ceiling: 100, axis: (value) => `${value}%`, empty: !values.some((value) => value != null),
      emptyText: "No paired cache usage with positive input tokens in this range.",
    });
    return;
  }
  let keys = view === "totals" ? ["input", "output"] : ["input_cache_read", "input_cache_write"];
  if (view === "cache") keys = keys.concat(["output_cache_read", "output_cache_write"].filter((key) => summary.usage[key].reported));
  text("token-chart-note", view === "totals" ? "Reported input and output tokens per bucket." : "Cache reads and writes are subsets of input, not additional tokens.");
  const series = keys.map((key) => ({ key, label: TOKEN_LABELS[key], color: TOKEN_COLORS[key], values: data.trend.map((bucket) => bucket.usage[key].tokens), area: true }));
  timeChart("token", series, {
    format: count, empty: !series.some((item) => item.values.some((value) => value != null)), emptyText: "No reported token usage in this range.",
  });
}
function renderTokens() {
  const summary = data.summary;
  const rate = summary.input_cache_rate;
  text("cache-rate", percent(rate.percent));
  $("cache-rate-bar").style.width = `${rate.percent ?? 0}%`;
  text("cache-rate-detail", `Cache reads ÷ input tokens on ${count(rate.reported)} / ${count(summary.requests)} requests reporting both. Token-weighted; cache writes are excluded.`);
  const list = $("tokens");
  list.replaceChildren();
  const unreported = [];
  for (const [key, label] of Object.entries(TOKEN_LABELS)) {
    const metric = summary.usage[key];
    if (key.startsWith("output_cache") && !metric.reported) { unreported.push(label.toLowerCase()); continue; }
    const row = tint(add(list, "li", ""), TOKEN_COLORS[key]);
    add(row, "span", "", "dot");
    add(row, "span", label, "name");
    add(row, "strong", count(metric.tokens));
    add(row, "small", `Reported on ${count(metric.reported)} / ${count(summary.requests)} requests`);
  }
  $("tokens-note").hidden = !unreported.length;
  text("tokens-note", unreported.length ? `Not reported in this range: ${unreported.join(", ")}.` : "");
  renderTokenChart();

  const models = $("token-models");
  models.replaceChildren();
  const rows = data.models.filter((entry) => entry.usage.input.tokens != null || entry.usage.output.tokens != null)
    .sort((a, b) => (b.usage.input.tokens ?? 0) - (a.usage.input.tokens ?? 0) || (b.usage.output.tokens ?? 0) - (a.usage.output.tokens ?? 0))
    .slice(0, COMPARE_LIMIT);
  const max = Math.max(0, ...rows.map((entry) => entry.usage.input.tokens ?? 0));
  rows.forEach((entry, index) => {
    const row = tint(add(models, "li", "", "cmp-row"), colorFor(entry.model));
    add(row, "span", String(index + 1), "rank");
    const name = add(row, "div", "", "cmp-name");
    name.append(modelButton(entry.model));
    add(add(name, "span", "", "cmp-sub"), "span", plural(entry.requests, "request"));
    const input = entry.usage.input.tokens ?? 0;
    const cached = Math.min(entry.usage.input_cache_read.tokens ?? 0, input);
    const pct = (value) => max ? value / max * 100 : 0;
    row.append(bar([{ className: "range", to: pct(input) }, { to: pct(cached) }], `${fullName(entry.model)}: ${count(entry.usage.input.tokens)} input tokens, ${count(entry.usage.input_cache_read.tokens)} from cache`));
    const value = add(row, "div", "", "cmp-value");
    add(value, "strong", `${compact(entry.usage.input.tokens)} in`);
    add(value, "span", `${compact(entry.usage.output.tokens)} out · ${percent(entry.input_cache_rate.percent)} cached`);
  });
  if (!rows.length) add(models, "li", "No reported token usage in this range.", "empty");
}

const COLUMNS = [
  { key: "model", label: "Model", value: (entry) => entry.model },
  { key: "requests", label: "Requests", value: (entry) => entry.requests, format: count },
  { key: "success", label: "Success", value: successRate, format: percent },
  { key: "latency_avg", ascending: true, label: "Latency avg", value: (entry) => entry.completed_latency_ms.avg, format: duration },
  { key: "latency_p50", ascending: true, label: "Latency P50", value: (entry) => entry.completed_latency_ms.p50, format: duration },
  { key: "latency_p95", ascending: true, label: "Latency P95", value: (entry) => entry.completed_latency_ms.p95, format: duration },
  { key: "latency_p99", ascending: true, label: "Latency P99", value: (entry) => entry.completed_latency_ms.p99, format: duration },
  { key: "ttft_p50", ascending: true, label: "First token P50", value: (entry) => entry.ttft_ms.p50, format: duration },
  { key: "ttft_p95", ascending: true, label: "First token P95", value: (entry) => entry.ttft_ms.p95, format: duration },
  { key: "speed", label: "Speed P50", value: (entry) => entry.output_tps.p50, format: speed },
  ...["input", "input_cache_read", "input_cache_write", "output", "output_cache_read", "output_cache_write"]
    .map((key) => ({ key, label: TOKEN_LABELS[key], value: (entry) => entry.usage[key].tokens, format: count, token: key })),
  { key: "cache_rate", label: "Cache hit", value: (entry) => entry.input_cache_rate.percent, format: percent },
];
function renderTableHead() {
  const head = $("models-head");
  head.replaceChildren();
  for (const column of COLUMNS) {
    const cell = add(head, "th", "");
    cell.scope = "col";
    if (state.table.key === column.key) cell.setAttribute("aria-sort", state.table.descending ? "descending" : "ascending");
    const button = add(cell, "button", column.label);
    button.type = "button";
    button.addEventListener("click", () => {
      // First click shows the best end: shortest latency, otherwise largest value.
      state.table = state.table.key === column.key ? { key: column.key, descending: !state.table.descending } : { key: column.key, descending: column.key !== "model" && !column.ascending };
      renderTable();
    });
  }
}
function renderTable() {
  renderTableHead();
  const column = COLUMNS.find((item) => item.key === state.table.key) || COLUMNS[1];
  const sign = state.table.descending ? -1 : 1;
  const rows = [...data.models].sort((a, b) => {
    const left = column.value(a);
    const right = column.value(b);
    if (left == null || right == null) return (left == null) - (right == null);
    return sign * (typeof left === "string" ? left.localeCompare(right) : left - right) || b.requests - a.requests;
  });
  const body = $("models");
  body.replaceChildren();
  text("model-count", plural(data.models.length, "model"));
  for (const entry of rows) {
    const row = tint(add(body, "tr", ""), colorFor(entry.model));
    for (const item of COLUMNS) {
      const cell = add(row, "td", "");
      cell.dataset.key = item.key;
      if (item.key === "model") { cell.append(modelButton(entry.model)); continue; }
      const value = item.value(entry);
      cell.textContent = item.format(value);
      if (value == null) cell.classList.add("muted");
      if (item.token) cell.title = `Reported on ${count(entry.usage[item.token].reported)} / ${count(entry.requests)} requests`;
    }
  }
  if (!rows.length) {
    const cell = add(add(body, "tr", ""), "td", "No models in this time range.", "empty");
    cell.colSpan = COLUMNS.length;
  }
}

function renderContext() {
  const interval = data.step >= DAY ? `${trim(data.step / DAY)} day` : data.step >= HOUR ? `${trim(data.step / HOUR)} h`
    : data.step >= MINUTE ? `${trim(data.step / MINUTE)} min` : `${trim(data.step / 1000)} s`;
  text("range-label", `${stampFormat.format(data.from)} – ${stampFormat.format(data.to)} · ${interval} buckets`);
  text("updated", `Updated ${new Date().toLocaleTimeString()}`);
  const select = $("model");
  const names = new Set(data.available_models.filter(Boolean));
  if (state.model) names.add(state.model);
  select.replaceChildren(new Option("All models", ""));
  const groups = new Map();
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const group = describe(name).group;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(name);
  }
  for (const group of MODEL_GROUPS.filter((name) => groups.has(name))) {
    const node = document.createElement("optgroup");
    node.label = group;
    for (const name of groups.get(group)) node.append(new Option(name, name));
    select.append(node);
  }
  select.value = state.model;
  $("clear-model").hidden = !state.model;
}

function render(report) {
  data = report;
  colors = new Map();
  for (const name of data.available_models) colorFor(name);
  for (const entry of data.models) colorFor(entry.model);
  renderContext();
  renderKpis();
  renderCompare();
  renderModelChart();
  renderTraffic();
  renderTokens();
  renderTable();
  const notices = [];
  if (data.truncated) notices.push("This report includes only the newest 100,000 matching requests.");
  if (data.model_list_truncated) notices.push("Model list is limited to 200 entries.");
  if (data.dropped_since_start) notices.push(`${count(data.dropped_since_start)} metrics could not be recorded since the proxy started.`);
  warning(notices);
}
function warning(messages) {
  const shown = messages.filter(Boolean);
  text("warning", shown.join(" "));
  $("warning").hidden = !shown.length;
}

/* Data loading */
function updateSteps(span) {
  const select = $("step");
  for (const option of select.options) option.disabled = option.value !== "auto" && Math.ceil(span / Number(option.value)) > 240;
  if (select.selectedOptions[0]?.disabled) select.value = "auto";
  state.step = select.value;
}
async function refresh({ quiet = false } = {}) {
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  $("refresh").classList.add("spinning");
  try {
    const { from, to } = currentWindow();
    updateSteps(to - from);
    const params = new URLSearchParams({ from: String(from), to: String(to) });
    if (state.model) params.set("model", state.model);
    if (state.step !== "auto") params.set("step", state.step);
    saveState();
    syncControls();
    if (!quiet) text("updated", "Refreshing…");
    $("analytics").setAttribute("aria-busy", "true");
    const response = await fetch(`/dashboard/api/metrics?${params}`, { signal: controller.signal, cache: "no-store" });
    // The session cookie expired or was revoked (for example after a password change).
    if (response.status === 401) {
      location.assign("/dashboard/login");
      return;
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Analytics request failed (${response.status}).`);
    }
    const report = await response.json();
    if (pending === controller) render(report);
  } catch (error) {
    if (pending !== controller || error.name === "AbortError") return;
    if (!data) text("range-label", "Analytics unavailable");
    text("updated", "Refresh failed");
    warning([error.message, data ? "Charts still show the last successful report, not the current filters." : ""]);
  } finally {
    if (pending === controller) {
      pending = null;
      $("analytics").setAttribute("aria-busy", "false");
      $("refresh").classList.remove("spinning");
    }
  }
}
function focusModel(model) {
  state.model = model;
  state.hidden.clear();
  refresh();
  if (window.scrollY > $("models-section").offsetTop) $("main").scrollIntoView({ behavior: "smooth" });
}

/* Controls */
const syncRange = segmented("range", (value) => {
  if (value === "custom") {
    state.customOpen = true;
    const { from, to } = currentWindow();
    $("from").value = localInput(from);
    $("to").value = localInput(to);
    syncControls();
    $("from").focus();
    return;
  }
  Object.assign(state, { range: value, customOpen: false });
  refresh();
});
const syncCompare = segmented("compare-metric", (value) => { state.compare = value; syncControls(); saveState(); if (data) renderCompare(); });
const syncModelMetric = segmented("model-metric", (value) => { state.modelMetric = value; syncControls(); saveState(); if (data) renderModelChart(); });
const syncTokenView = segmented("token-view", (value) => { state.tokenView = value; syncControls(); saveState(); if (data) renderTokenChart(); });
function syncControls() {
  syncRange(state.customOpen ? "custom" : state.range);
  syncCompare(state.compare);
  syncModelMetric(state.modelMetric);
  syncTokenView(state.tokenView);
  $("custom-range").hidden = !state.customOpen;
  $("compare-sort").value = state.sort;
  $("step").value = state.step;
  const live = $("live");
  live.disabled = state.range === "custom";
  live.title = live.disabled ? "Live refresh follows relative ranges only" : "Refresh automatically every 30 seconds";
}
$("custom-range").addEventListener("submit", (event) => {
  event.preventDefault();
  const from = new Date($("from").value).getTime();
  const to = new Date($("to").value).getTime();
  if (!validWindow(from, to)) {
    text("updated", "Refresh failed");
    warning(["Choose an end time after the start and a range no longer than 31 days.", data ? "Charts still show the last successful report, not the current filters." : ""]);
    return;
  }
  Object.assign(state, { range: "custom", from, to });
  refresh();
});
$("model").addEventListener("change", (event) => { state.model = event.target.value; state.hidden.clear(); refresh(); });
$("clear-model").addEventListener("click", () => { state.model = ""; refresh(); });
$("step").addEventListener("change", (event) => { state.step = event.target.value; refresh(); });
$("compare-sort").addEventListener("change", (event) => { state.sort = event.target.value; saveState(); if (data) renderCompare(); });
$("refresh").addEventListener("click", () => refresh());

function setLive(on) {
  $("live").setAttribute("aria-pressed", String(on));
  store(LIVE_KEY, on ? "1" : "0");
  clearInterval(liveTimer);
  liveTimer = on ? setInterval(() => {
    if (!document.hidden && !pending && state.range !== "custom") refresh({ quiet: true });
  }, LIVE_INTERVAL) : null;
}
$("live").addEventListener("click", () => setLive($("live").getAttribute("aria-pressed") !== "true"));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && liveTimer && !pending && state.range !== "custom") refresh({ quiet: true });
});

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
const theme = () => document.documentElement.dataset.theme || (prefersDark.matches ? "dark" : "light");
function syncTheme() {
  const next = theme() === "dark" ? "light" : "dark";
  $("theme").setAttribute("aria-label", `Switch to ${next} theme`);
  $("theme").title = `Switch to ${next} theme`;
}
$("theme").addEventListener("click", () => {
  const next = theme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store(THEME_KEY, next);
  syncTheme();
});
prefersDark.addEventListener("change", syncTheme);

let lastWidth = 0;
let frame = 0;
new ResizeObserver(() => {
  const width = $("analytics").clientWidth;
  if (!data || width === lastWidth) return;
  lastWidth = width;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => Object.values(charts).forEach((draw) => draw()));
}).observe($("analytics"));

const savedTheme = stored(THEME_KEY);
if (savedTheme === "dark" || savedTheme === "light") document.documentElement.dataset.theme = savedTheme;
syncTheme();
loadState();
if (state.range === "custom") { $("from").value = localInput(state.from); $("to").value = localInput(state.to); }
setLive(stored(LIVE_KEY) === "1");
refresh();
