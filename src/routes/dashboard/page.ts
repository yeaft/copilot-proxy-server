export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CopilotProxy Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    .header { background: #1e293b; padding: 20px 32px; border-bottom: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
    .header h1 { font-size: 20px; font-weight: 600; }
    .header-controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .period-selector { display: flex; gap: 8px; }
    .period-btn { padding: 6px 16px; border: 1px solid #475569; background: transparent; color: #94a3b8; border-radius: 6px; cursor: pointer; font-size: 13px; transition: all 0.2s; }
    .period-btn:hover { border-color: #60a5fa; color: #60a5fa; }
    .period-btn.active { background: #3b82f6; border-color: #3b82f6; color: #fff; }
    .custom-range { display: flex; align-items: center; gap: 8px; }
    .custom-range input[type="datetime-local"] {
      padding: 5px 10px; border: 1px solid #475569; background: #0f172a; color: #e2e8f0;
      border-radius: 6px; font-size: 13px; outline: none; transition: border-color 0.2s;
    }
    .custom-range input[type="datetime-local"]:focus { border-color: #60a5fa; }
    .custom-range .range-sep { color: #64748b; font-size: 13px; }
    .custom-range .apply-btn {
      padding: 5px 14px; border: 1px solid #3b82f6; background: #3b82f6; color: #fff;
      border-radius: 6px; cursor: pointer; font-size: 13px; transition: all 0.2s;
    }
    .custom-range .apply-btn:hover { background: #2563eb; }
    .range-error { color: #f87171; font-size: 12px; min-height: 16px; }
    .granularity-label { font-size: 12px; color: #64748b; padding: 4px 10px; background: #334155; border-radius: 4px; }
    .container { max-width: 1400px; margin: 0 auto; padding: 24px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; }
    .card-label { font-size: 13px; color: #94a3b8; margin-bottom: 8px; }
    .card-value { font-size: 28px; font-weight: 700; color: #f1f5f9; }
    .card-sub { font-size: 12px; color: #64748b; margin-top: 4px; }
    .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
    .charts-wide { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; margin-bottom: 24px; }
    .chart-box { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; }
    .chart-box h3 { font-size: 15px; font-weight: 600; margin-bottom: 16px; color: #cbd5e1; }
    .chart-container { width: 100%; height: 320px; }
    .tables { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .table-box { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; overflow-x: auto; }
    .table-box h3 { font-size: 15px; font-weight: 600; margin-bottom: 16px; color: #cbd5e1; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 8px 12px; font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #334155; white-space: nowrap; }
    td { padding: 10px 12px; font-size: 13px; border-bottom: 1px solid #1e293b; white-space: nowrap; }
    tr:hover td { background: #334155; }
    .num { font-variant-numeric: tabular-nums; text-align: right; }
    @media (max-width: 768px) {
      .charts, .charts-wide, .tables { grid-template-columns: 1fr; }
      .header { flex-direction: column; gap: 12px; }
      .header-controls { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>CopilotProxy Dashboard</h1>
    <div class="header-controls">
      <div class="period-selector">
        <button class="period-btn" data-period="1h">1H</button>
        <button class="period-btn" data-period="6h">6H</button>
        <button class="period-btn active" data-period="24h">24H</button>
        <button class="period-btn" data-period="7d">7D</button>
        <button class="period-btn" data-period="30d">30D</button>
      </div>
      <div class="custom-range">
        <input type="datetime-local" id="range-start" step="60">
        <span class="range-sep">-</span>
        <input type="datetime-local" id="range-end" step="60">
        <button class="apply-btn" id="apply-range">Apply</button>
      </div>
      <span class="range-error" id="range-error" role="alert"></span>
      <span class="granularity-label" id="granularity-label"></span>
    </div>
  </div>

  <div class="container">
    <!-- Stats cards -->
    <div class="cards">
      <div class="card"><div class="card-label">Total Requests</div><div class="card-value" id="stat-requests">-</div></div>
      <div class="card"><div class="card-label">Uncached Input</div><div class="card-value" id="stat-input-tokens">-</div></div>
      <div class="card"><div class="card-label">Cache Read</div><div class="card-value" id="stat-cached-tokens">-</div></div>
      <div class="card"><div class="card-label">Output Tokens</div><div class="card-value" id="stat-output-tokens">-</div></div>
      <div class="card"><div class="card-label">Total Tokens</div><div class="card-value" id="stat-tokens">-</div></div>
      <div class="card"><div class="card-label">Estimated Cost</div><div class="card-value" id="stat-cost">-</div><div class="card-sub" id="stat-credits"></div></div>
      <div class="card"><div class="card-label">Active IPs</div><div class="card-value" id="stat-ips">-</div></div>
      <div class="card">
        <div class="card-label">Avg TTFB</div>
        <div class="card-value" id="stat-ttfb">-</div>
        <div class="card-sub" id="stat-ttfb-pct"></div>
      </div>
      <div class="card">
        <div class="card-label">Avg Duration</div>
        <div class="card-value" id="stat-duration">-</div>
        <div class="card-sub" id="stat-duration-pct"></div>
      </div>
    </div>

    <!-- Token charts -->
    <div class="charts-wide">
      <div class="chart-box">
        <h3>Token Usage Over Time</h3>
        <div class="chart-container" id="chart-timeline"></div>
      </div>
      <div class="chart-box">
        <h3>Model Distribution</h3>
        <div class="chart-container" id="chart-models"></div>
      </div>
    </div>

    <!-- Latency charts -->
    <div class="charts">
      <div class="chart-box">
        <h3>TTFB Over Time</h3>
        <div class="chart-container" id="chart-ttfb"></div>
      </div>
      <div class="chart-box">
        <h3>Duration Over Time</h3>
        <div class="chart-container" id="chart-duration"></div>
      </div>
    </div>

    <!-- Tables -->
    <div class="tables">
      <div class="table-box">
        <h3>Top IPs</h3>
        <table>
          <thead><tr><th>IP</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num">Avg TTFB</th><th class="num">Avg Duration</th></tr></thead>
          <tbody id="table-ips"></tbody>
        </table>
      </div>
      <div class="table-box">
        <h3>Top Models</h3>
        <table>
          <thead><tr><th>Model</th><th class="num">Requests</th><th class="num">Input</th><th class="num">Cache Read</th><th class="num">Output</th><th class="num">Credits</th><th class="num">Cost</th></tr></thead>
          <tbody id="table-models"></tbody>
        </table>
      </div>
    </div>
  </div>

<script>
  // ── State ───────────────────────────────────────────────────
  let currentMode = 'preset'; // 'preset' | 'custom' | 'zoom'
  let currentPeriod = '24h';
  let currentStart = '';
  let currentEnd = '';
  let currentGranularity = '';

  // ── Chart instances ─────────────────────────────────────────
  let timelineChart = null;
  let modelsChart = null;
  let ttfbChart = null;
  let durationChart = null;

  // Track whether we're updating zoom programmatically to avoid loops
  let zoomLock = false;

  // ── Formatters ──────────────────────────────────────────────
  function fmt(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  function fmtMs(n) {
    n = Math.round(n);
    if (n >= 1000) return (n / 1000).toFixed(1) + 's';
    return n + 'ms';
  }

  // ── Period helpers ──────────────────────────────────────────
  const periodHours = { '1h': 1, '6h': 6, '24h': 24, '7d': 168, '30d': 720 };

  function periodToRange(period) {
    const h = periodHours[period] || 24;
    const now = new Date();
    const start = new Date(now.getTime() - h * 3600000);
    return { start: toUtc(start), end: toUtc(now) };
  }

  function toUtc(d) {
    return d.toISOString().slice(0, 19);
  }

  function syncRangeInputs(start, end) {
    document.getElementById('range-start').value = toLocal(new Date(start + 'Z')).slice(0, 16);
    document.getElementById('range-end').value = toLocal(new Date(end + 'Z')).slice(0, 16);
  }

  function toLocal(d) {
    // Format as YYYY-MM-DDTHH:MM:SS in local time
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function inferGranularity(start, end) {
    const spanMs = new Date(end).getTime() - new Date(start).getTime();
    const spanH = spanMs / 3600000;
    if (spanH <= 3) return '1m';
    if (spanH <= 24) return '5m';
    if (spanH <= 168) return '1h';
    return '1d';
  }

  const granularityNames = { '1m': '1 min', '5m': '5 min', '1h': '1 hour', '1d': '1 day' };

  // ── Build query string ──────────────────────────────────────
  function buildQuery() {
    let start = currentStart;
    let end = currentEnd;
    if (!start || !end) {
      const r = periodToRange('24h');
      start = r.start; end = r.end;
    }
    const g = currentGranularity || inferGranularity(start, end);
    // Update granularity label
    document.getElementById('granularity-label').textContent = 'Granularity: ' + (granularityNames[g] || g);
    return 'start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end) + '&granularity=' + g;
  }

  // ── Fetch helper ────────────────────────────────────────────
  async function fetchJSON(url) {
    const res = await fetch(url);
    return res.json();
  }

  // ── Data loaders ────────────────────────────────────────────
  async function loadStats() {
    const s = await fetchJSON('/dashboard/api/stats?' + buildQuery());
    document.getElementById('stat-requests').textContent = fmt(s.total_requests);
    document.getElementById('stat-input-tokens').textContent = fmt(Math.max(0, s.total_prompt_tokens - s.total_cached_prompt_tokens));
    document.getElementById('stat-cached-tokens').textContent = fmt(s.total_cached_prompt_tokens);
    document.getElementById('stat-output-tokens').textContent = fmt(s.total_completion_tokens);
    document.getElementById('stat-tokens').textContent = fmt(s.total_tokens);
    document.getElementById('stat-cost').textContent = '$' + Number(s.total_cost_usd).toFixed(4);
    document.getElementById('stat-credits').textContent = Number(s.total_credits).toFixed(2) + ' credits' + (s.unpriced_tokens ? ' · ' + fmt(s.unpriced_tokens) + ' unpriced tokens' : '');
    document.getElementById('stat-ips').textContent = s.active_ips;
    document.getElementById('stat-ttfb').textContent = fmtMs(s.avg_ttfb_ms);
    document.getElementById('stat-ttfb-pct').textContent = 'P50: ' + fmtMs(s.p50_ttfb_ms) + '  P95: ' + fmtMs(s.p95_ttfb_ms);
    document.getElementById('stat-duration').textContent = fmtMs(s.avg_duration_ms);
    document.getElementById('stat-duration-pct').textContent = 'P50: ' + fmtMs(s.p50_duration_ms) + '  P95: ' + fmtMs(s.p95_duration_ms);
  }

  // ── Shared dataZoom config ──────────────────────────────────
  function makeDataZoom() {
    return [
      { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
      { type: 'slider', xAxisIndex: 0, height: 20, bottom: 4, borderColor: '#334155',
        backgroundColor: '#1e293b', fillerColor: 'rgba(59,130,246,0.15)',
        handleStyle: { color: '#3b82f6' }, textStyle: { color: '#64748b', fontSize: 10 },
        dataBackground: { lineStyle: { color: '#475569' }, areaStyle: { color: '#1e293b' } } }
    ];
  }

  function makeLatencyOption(data, field, color, name) {
    return {
      tooltip: { trigger: 'axis', formatter: function(p) { return p[0].axisValue + '<br/>' + name + ': ' + fmtMs(p[0].value); } },
      grid: { left: 60, right: 20, top: 20, bottom: 54 },
      xAxis: { type: 'category', data: data.map(d => d.time_bucket), axisLabel: { color: '#64748b', fontSize: 11 }, axisLine: { lineStyle: { color: '#334155' } } },
      yAxis: { type: 'value', axisLabel: { color: '#64748b', formatter: function(v) { return v >= 1000 ? (v/1000).toFixed(1) + 's' : v + 'ms'; } }, splitLine: { lineStyle: { color: '#1e293b' } } },
      dataZoom: makeDataZoom(),
      series: [{
        name: name, type: 'line', data: data.map(d => Math.round(d[field])),
        smooth: true, lineStyle: { width: 2 }, itemStyle: { color: color },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: color + '4D' }, { offset: 1, color: color + '05' }] } }
      }]
    };
  }

  // ── Timeline data (stored for zoom calculations) ────────────
  let timelineData = [];

  async function loadTimeline() {
    const data = await fetchJSON('/dashboard/api/usage?' + buildQuery());
    timelineData = data;

    if (!timelineChart) timelineChart = echarts.init(document.getElementById('chart-timeline'));
    timelineChart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['Uncached Input', 'Cache Read', 'Output'], textStyle: { color: '#94a3b8' }, top: 0 },
      grid: { left: 60, right: 20, top: 40, bottom: 54 },
      xAxis: { type: 'category', data: data.map(d => d.time_bucket), axisLabel: { color: '#64748b', fontSize: 11 }, axisLine: { lineStyle: { color: '#334155' } } },
      yAxis: { type: 'value', axisLabel: { color: '#64748b', formatter: function(v) { return v >= 1000 ? (v/1000).toFixed(0) + 'K' : v; } }, splitLine: { lineStyle: { color: '#1e293b' } } },
      dataZoom: makeDataZoom(),
      series: [
        { name: 'Uncached Input', type: 'line', data: data.map(d => Math.max(0, d.prompt_tokens - d.cached_prompt_tokens)), smooth: true, lineStyle: { width: 2 }, itemStyle: { color: '#3b82f6' } },
        { name: 'Cache Read', type: 'line', data: data.map(d => d.cached_prompt_tokens), smooth: true, lineStyle: { width: 2 }, itemStyle: { color: '#f59e0b' } },
        { name: 'Output', type: 'line', data: data.map(d => d.completion_tokens), smooth: true, lineStyle: { width: 2 }, itemStyle: { color: '#10b981' } }
      ]
    }, true);

    if (!ttfbChart) ttfbChart = echarts.init(document.getElementById('chart-ttfb'));
    ttfbChart.setOption(makeLatencyOption(data, 'avg_ttfb_ms', '#f59e0b', 'Avg TTFB'), true);

    if (!durationChart) durationChart = echarts.init(document.getElementById('chart-duration'));
    durationChart.setOption(makeLatencyOption(data, 'avg_duration_ms', '#8b5cf6', 'Avg Duration'), true);
  }

  async function loadModels() {
    const data = await fetchJSON('/dashboard/api/top-models?' + buildQuery());
    if (!modelsChart) modelsChart = echarts.init(document.getElementById('chart-models'));
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
    modelsChart.setOption({
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      series: [{
        type: 'pie', radius: ['40%', '70%'], center: ['50%', '55%'],
        data: data.map((d, i) => ({ name: d.name, value: d.total_tokens, itemStyle: { color: colors[i % colors.length] } })),
        label: { color: '#94a3b8', fontSize: 11 },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.5)' } }
      }]
    });
  }

  async function loadTopIps() {
    const data = await fetchJSON('/dashboard/api/top-ips?' + buildQuery());
    const tbody = document.getElementById('table-ips');
    tbody.innerHTML = data.map(d =>
      '<tr><td>' + d.name + '</td><td class="num">' + fmt(d.requests) + '</td><td class="num">' + fmt(d.total_tokens) + '</td><td class="num">' + fmtMs(d.avg_ttfb_ms) + '</td><td class="num">' + fmtMs(d.avg_duration_ms) + '</td></tr>'
    ).join('');
    if (!data.length) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#64748b;padding:20px;">No data</td></tr>';
  }

  async function loadTopModels() {
    const data = await fetchJSON('/dashboard/api/top-models?' + buildQuery());
    const tbody = document.getElementById('table-models');
    tbody.innerHTML = data.map(d =>
      '<tr><td>' + d.name + '</td><td class="num">' + fmt(d.requests) + '</td><td class="num">' + fmt(Math.max(0, d.prompt_tokens - d.cached_prompt_tokens)) + '</td><td class="num">' + fmt(d.cached_prompt_tokens) + '</td><td class="num">' + fmt(d.completion_tokens) + '</td><td class="num">' + (d.credits == null ? 'N/A' : Number(d.credits).toFixed(2)) + '</td><td class="num">' + (d.cost_usd == null ? 'N/A' : '$' + Number(d.cost_usd).toFixed(4)) + '</td></tr>'
    ).join('');
    if (!data.length) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#64748b;padding:20px;">No data</td></tr>';
  }

  async function loadAll() {
    if (currentMode === 'preset') {
      const range = periodToRange(currentPeriod);
      currentStart = range.start;
      currentEnd = range.end;
      syncRangeInputs(range.start, range.end);
    }
    await Promise.all([loadStats(), loadTimeline(), loadModels(), loadTopIps(), loadTopModels()]);
  }

  // ── Zoom-in drill-down ──────────────────────────────────────
  // When user zooms into a chart, re-query with the visible time range
  let zoomDebounce = null;

  function handleDataZoom(params) {
    if (zoomLock) return;
    // Get the zoom range percentage from the event
    const opt = timelineChart.getOption();
    if (!opt || !opt.dataZoom || !opt.dataZoom.length) return;
    const startPct = opt.dataZoom[0].start;
    const endPct = opt.dataZoom[0].end;

    // If zoomed back to full range, don't re-query
    if (startPct <= 0.1 && endPct >= 99.9) return;

    // Map percentage to time_bucket values
    const buckets = timelineData.map(d => d.time_bucket);
    if (!buckets.length) return;
    const startIdx = Math.floor(startPct / 100 * (buckets.length - 1));
    const endIdx = Math.ceil(endPct / 100 * (buckets.length - 1));
    const zoomStart = buckets[Math.max(0, startIdx)];
    const zoomEnd = buckets[Math.min(buckets.length - 1, endIdx)];

    if (!zoomStart || !zoomEnd) return;

    // Convert time_bucket strings to ISO-ish format for query
    // Buckets can be "YYYY-MM-DD HH:MM", "YYYY-MM-DD HH:00", or "YYYY-MM-DD"
    const isoStart = zoomStart.replace(' ', 'T').length < 16 ? zoomStart + 'T00:00:00' : zoomStart.replace(' ', 'T') + ':00';
    const isoEnd = zoomEnd.replace(' ', 'T').length < 16 ? zoomEnd + 'T23:59:59' : zoomEnd.replace(' ', 'T') + ':59';

    // Debounce: wait for user to finish zooming
    clearTimeout(zoomDebounce);
    zoomDebounce = setTimeout(() => {
      currentMode = 'zoom';
      currentStart = isoStart;
      currentEnd = isoEnd;
      currentGranularity = inferGranularity(isoStart, isoEnd);
      syncRangeInputs(isoStart, isoEnd);

      // Deactivate preset buttons
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));

      // Reload stats and tables (but NOT the charts — they already show the zoom)
      Promise.all([loadStats(), loadTopIps(), loadTopModels()]);
    }, 400);
  }

  function syncZoom(sourceChart, params) {
    if (zoomLock) return;
    zoomLock = true;
    const opt = sourceChart.getOption();
    const startPct = opt.dataZoom[0].start;
    const endPct = opt.dataZoom[0].end;

    [timelineChart, ttfbChart, durationChart].forEach(chart => {
      if (chart && chart !== sourceChart) {
        chart.dispatchAction({ type: 'dataZoom', start: startPct, end: endPct });
      }
    });
    zoomLock = false;

    // Trigger the drill-down logic
    handleDataZoom(params);
  }

  // ── Preset buttons ──────────────────────────────────────────
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = 'preset';
      currentPeriod = btn.dataset.period;
      currentGranularity = '';
      document.getElementById('range-error').textContent = '';
      // Reset zoom on all charts
      resetAllZoom();
      loadAll();
    });
  });

  function resetAllZoom() {
    zoomLock = true;
    [timelineChart, ttfbChart, durationChart].forEach(chart => {
      if (chart) chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
    });
    zoomLock = false;
  }

  // ── Custom range ────────────────────────────────────────────
  document.getElementById('apply-range').addEventListener('click', () => {
    const startInput = document.getElementById('range-start').value;
    const endInput = document.getElementById('range-end').value;
    const error = document.getElementById('range-error');
    if (!startInput || !endInput) {
      error.textContent = 'Choose both start and end time.';
      return;
    }
    if (new Date(startInput).getTime() >= new Date(endInput).getTime()) {
      error.textContent = 'Start time must be before end time.';
      return;
    }

    error.textContent = '';
    currentMode = 'custom';
    currentStart = toUtc(new Date(startInput));
    currentEnd = toUtc(new Date(endInput));
    currentGranularity = '';

    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    resetAllZoom();
    loadAll();
  });

  // ── Init ────────────────────────────────────────────────────
  const initialRange = periodToRange(currentPeriod);
  currentStart = initialRange.start;
  currentEnd = initialRange.end;
  syncRangeInputs(initialRange.start, initialRange.end);

  loadAll();
  setInterval(() => {
    // Only auto-refresh when in preset mode (not custom/zoom)
    if (currentMode === 'preset') loadAll();
  }, 30000);

  window.addEventListener('resize', () => {
    [timelineChart, modelsChart, ttfbChart, durationChart].forEach(c => c && c.resize());
  });

  // Attach zoom sync after first render (charts must exist)
  setTimeout(() => {
    [timelineChart, ttfbChart, durationChart].forEach(chart => {
      if (chart) {
        chart.on('dataZoom', (params) => syncZoom(chart, params));
      }
    });
  }, 2000);
</script>
</body>
</html>`;
}
