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
    .header { background: #1e293b; padding: 20px 32px; border-bottom: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 20px; font-weight: 600; }
    .period-selector { display: flex; gap: 8px; }
    .period-btn { padding: 6px 16px; border: 1px solid #475569; background: transparent; color: #94a3b8; border-radius: 6px; cursor: pointer; font-size: 13px; transition: all 0.2s; }
    .period-btn:hover { border-color: #60a5fa; color: #60a5fa; }
    .period-btn.active { background: #3b82f6; border-color: #3b82f6; color: #fff; }
    .container { max-width: 1400px; margin: 0 auto; padding: 24px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; }
    .card-label { font-size: 13px; color: #94a3b8; margin-bottom: 8px; }
    .card-value { font-size: 28px; font-weight: 700; color: #f1f5f9; }
    .card-value .unit { font-size: 14px; font-weight: 400; color: #64748b; margin-left: 4px; }
    .charts { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; margin-bottom: 24px; }
    .chart-box { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; }
    .chart-box h3 { font-size: 15px; font-weight: 600; margin-bottom: 16px; color: #cbd5e1; }
    .chart-container { width: 100%; height: 320px; }
    .tables { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .table-box { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; }
    .table-box h3 { font-size: 15px; font-weight: 600; margin-bottom: 16px; color: #cbd5e1; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 8px 12px; font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #334155; }
    td { padding: 10px 12px; font-size: 13px; border-bottom: 1px solid #1e293b; }
    tr:hover td { background: #334155; }
    .num { font-variant-numeric: tabular-nums; text-align: right; }
    .loading { text-align: center; padding: 60px; color: #64748b; }
    @media (max-width: 768px) {
      .charts, .tables { grid-template-columns: 1fr; }
      .header { flex-direction: column; gap: 12px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>CopilotProxy Dashboard</h1>
    <div class="period-selector">
      <button class="period-btn" data-period="1h">1H</button>
      <button class="period-btn" data-period="6h">6H</button>
      <button class="period-btn active" data-period="24h">24H</button>
      <button class="period-btn" data-period="7d">7D</button>
      <button class="period-btn" data-period="30d">30D</button>
    </div>
  </div>

  <div class="container">
    <div class="cards">
      <div class="card"><div class="card-label">Total Requests</div><div class="card-value" id="stat-requests">-</div></div>
      <div class="card"><div class="card-label">Prompt Tokens</div><div class="card-value" id="stat-prompt">-</div></div>
      <div class="card"><div class="card-label">Completion Tokens</div><div class="card-value" id="stat-completion">-</div></div>
      <div class="card"><div class="card-label">Total Tokens</div><div class="card-value" id="stat-tokens">-</div></div>
      <div class="card"><div class="card-label">Active IPs</div><div class="card-value" id="stat-ips">-</div></div>
    </div>

    <div class="charts">
      <div class="chart-box">
        <h3>Token Usage Over Time</h3>
        <div class="chart-container" id="chart-timeline"></div>
      </div>
      <div class="chart-box">
        <h3>Model Distribution</h3>
        <div class="chart-container" id="chart-models"></div>
      </div>
    </div>

    <div class="tables">
      <div class="table-box">
        <h3>Top IPs</h3>
        <table>
          <thead><tr><th>IP</th><th class="num">Requests</th><th class="num">Prompt</th><th class="num">Completion</th><th class="num">Total</th></tr></thead>
          <tbody id="table-ips"></tbody>
        </table>
      </div>
      <div class="table-box">
        <h3>Top Models</h3>
        <table>
          <thead><tr><th>Model</th><th class="num">Requests</th><th class="num">Prompt</th><th class="num">Completion</th><th class="num">Total</th></tr></thead>
          <tbody id="table-models"></tbody>
        </table>
      </div>
    </div>
  </div>

<script>
  let currentPeriod = '24h';
  let timelineChart = null;
  let modelsChart = null;

  function fmt(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  async function fetchJSON(url) {
    const res = await fetch(url);
    return res.json();
  }

  async function loadStats() {
    const stats = await fetchJSON('/dashboard/api/stats?period=' + currentPeriod);
    document.getElementById('stat-requests').textContent = fmt(stats.total_requests);
    document.getElementById('stat-prompt').textContent = fmt(stats.total_prompt_tokens);
    document.getElementById('stat-completion').textContent = fmt(stats.total_completion_tokens);
    document.getElementById('stat-tokens').textContent = fmt(stats.total_tokens);
    document.getElementById('stat-ips').textContent = stats.active_ips;
  }

  async function loadTimeline() {
    const data = await fetchJSON('/dashboard/api/usage?period=' + currentPeriod);
    if (!timelineChart) {
      timelineChart = echarts.init(document.getElementById('chart-timeline'));
    }
    timelineChart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['Prompt', 'Completion'], textStyle: { color: '#94a3b8' }, top: 0 },
      grid: { left: 60, right: 20, top: 40, bottom: 30 },
      xAxis: { type: 'category', data: data.map(d => d.time_bucket), axisLabel: { color: '#64748b', fontSize: 11 }, axisLine: { lineStyle: { color: '#334155' } } },
      yAxis: { type: 'value', axisLabel: { color: '#64748b', formatter: function(v) { return v >= 1000 ? (v/1000).toFixed(0) + 'K' : v; } }, splitLine: { lineStyle: { color: '#1e293b' } } },
      series: [
        { name: 'Prompt', type: 'line', data: data.map(d => d.prompt_tokens), smooth: true, lineStyle: { width: 2 }, itemStyle: { color: '#3b82f6' }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(59,130,246,0.3)' }, { offset: 1, color: 'rgba(59,130,246,0.02)' }] } } },
        { name: 'Completion', type: 'line', data: data.map(d => d.completion_tokens), smooth: true, lineStyle: { width: 2 }, itemStyle: { color: '#10b981' }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(16,185,129,0.3)' }, { offset: 1, color: 'rgba(16,185,129,0.02)' }] } } }
      ]
    });
  }

  async function loadModels() {
    const data = await fetchJSON('/dashboard/api/top-models?period=' + currentPeriod);
    if (!modelsChart) {
      modelsChart = echarts.init(document.getElementById('chart-models'));
    }
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
    modelsChart.setOption({
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      series: [{
        type: 'pie',
        radius: ['40%', '70%'],
        center: ['50%', '55%'],
        data: data.map((d, i) => ({ name: d.name, value: d.total_tokens, itemStyle: { color: colors[i % colors.length] } })),
        label: { color: '#94a3b8', fontSize: 11 },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.5)' } }
      }]
    });
  }

  async function loadTopIps() {
    const data = await fetchJSON('/dashboard/api/top-ips?period=' + currentPeriod);
    const tbody = document.getElementById('table-ips');
    tbody.innerHTML = data.map(d =>
      '<tr><td>' + d.name + '</td><td class="num">' + fmt(d.requests) + '</td><td class="num">' + fmt(d.prompt_tokens) + '</td><td class="num">' + fmt(d.completion_tokens) + '</td><td class="num">' + fmt(d.total_tokens) + '</td></tr>'
    ).join('');
    if (!data.length) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#64748b;padding:20px;">No data</td></tr>';
  }

  async function loadTopModels() {
    const data = await fetchJSON('/dashboard/api/top-models?period=' + currentPeriod);
    const tbody = document.getElementById('table-models');
    tbody.innerHTML = data.map(d =>
      '<tr><td>' + d.name + '</td><td class="num">' + fmt(d.requests) + '</td><td class="num">' + fmt(d.prompt_tokens) + '</td><td class="num">' + fmt(d.completion_tokens) + '</td><td class="num">' + fmt(d.total_tokens) + '</td></tr>'
    ).join('');
    if (!data.length) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#64748b;padding:20px;">No data</td></tr>';
  }

  async function loadAll() {
    await Promise.all([loadStats(), loadTimeline(), loadModels(), loadTopIps(), loadTopModels()]);
  }

  // Period selector
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelector('.period-btn.active').classList.remove('active');
      btn.classList.add('active');
      currentPeriod = btn.dataset.period;
      loadAll();
    });
  });

  // Auto-refresh every 30s
  loadAll();
  setInterval(loadAll, 30000);

  // Resize charts on window resize
  window.addEventListener('resize', () => {
    if (timelineChart) timelineChart.resize();
    if (modelsChart) modelsChart.resize();
  });
</script>
</body>
</html>`;
}
