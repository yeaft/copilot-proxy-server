export function getPlaygroundHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CopilotProxy Playground</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    .header { background: #1e293b; padding: 14px 24px; border-bottom: 1px solid #334155; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
    .header h1 { font-size: 18px; font-weight: 600; margin-right: 16px; }
    .header input[type="text"], .header input[type="password"] {
      padding: 6px 10px; border: 1px solid #475569; background: #0f172a; color: #e2e8f0;
      border-radius: 6px; font-size: 13px; outline: none; min-width: 260px; font-family: ui-monospace, monospace;
    }
    .header input:focus { border-color: #60a5fa; }
    .header label { font-size: 12px; color: #94a3b8; }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #64748b; margin-right: 6px; vertical-align: middle; }
    .status-dot.ok { background: #10b981; }
    .status-dot.err { background: #ef4444; }

    .layout { display: grid; grid-template-columns: 1fr 1fr; gap: 0; height: calc(100vh - 60px); }
    .panel { padding: 16px; overflow-y: auto; }
    .panel.left { border-right: 1px solid #334155; }

    .search-box { margin-bottom: 12px; }
    .search-box input {
      width: 100%; padding: 8px 12px; border: 1px solid #475569; background: #0f172a;
      color: #e2e8f0; border-radius: 6px; font-size: 13px; outline: none;
    }
    .search-box input:focus { border-color: #60a5fa; }

    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; padding: 8px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #334155; font-size: 11px; position: sticky; top: 0; background: #0f172a; }
    td { padding: 8px; border-bottom: 1px solid #1e293b; vertical-align: top; }
    tr.model-row { cursor: pointer; transition: background 0.15s; }
    tr.model-row:hover td { background: #1e293b; }
    tr.model-row.selected td { background: #1e3a5f; }

    .model-id { font-family: ui-monospace, monospace; color: #e2e8f0; font-weight: 500; }
    .model-vendor { color: #94a3b8; font-size: 11px; }

    .badges { display: flex; gap: 4px; flex-wrap: wrap; }
    .badge { padding: 2px 6px; border-radius: 4px; font-size: 10px; font-family: ui-monospace, monospace; white-space: nowrap; }
    .badge.chat { background: #1e40af; color: #bfdbfe; }
    .badge.resp { background: #047857; color: #a7f3d0; }
    .badge.msg { background: #7c2d12; color: #fed7aa; }
    .badge.ws { background: #4b5563; color: #d1d5db; font-size: 9px; }
    .badge.recommended { outline: 1px solid #fbbf24; outline-offset: -1px; }

    .caps { display: flex; gap: 3px; flex-wrap: wrap; margin-top: 3px; }
    .cap { padding: 1px 5px; font-size: 10px; border-radius: 3px; background: #334155; color: #cbd5e1; font-family: ui-monospace, monospace; }
    .cap.active { background: #312e81; color: #c7d2fe; }

    .limits { color: #64748b; font-size: 11px; font-family: ui-monospace, monospace; }

    /* Right panel: try-it editor */
    .section { margin-bottom: 16px; }
    .section-title { font-size: 12px; text-transform: uppercase; color: #64748b; letter-spacing: 0.05em; margin-bottom: 8px; }
    .hint { color: #64748b; font-size: 12px; }

    .form-row { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; flex-wrap: wrap; }
    .form-row label { font-size: 12px; color: #94a3b8; min-width: 120px; }
    .form-row input, .form-row select, .form-row textarea {
      padding: 6px 10px; border: 1px solid #475569; background: #0f172a; color: #e2e8f0;
      border-radius: 6px; font-size: 12px; outline: none; font-family: ui-monospace, monospace;
    }
    .form-row input[type="text"], .form-row input[type="number"] { min-width: 120px; }
    .form-row input:focus, .form-row select:focus, .form-row textarea:focus { border-color: #60a5fa; }
    .form-row input[type="checkbox"] { width: 16px; height: 16px; }

    .endpoint-tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid #334155; }
    .endpoint-tab { padding: 8px 14px; border: none; background: transparent; color: #94a3b8; cursor: pointer; font-size: 13px; border-bottom: 2px solid transparent; font-family: ui-monospace, monospace; }
    .endpoint-tab:hover { color: #cbd5e1; }
    .endpoint-tab.active { color: #60a5fa; border-bottom-color: #60a5fa; }
    .endpoint-tab.recommended::after { content: ' ★'; color: #fbbf24; }

    textarea.json {
      width: 100%; min-height: 140px; padding: 10px; border: 1px solid #475569;
      background: #0f172a; color: #e2e8f0; border-radius: 6px; font-size: 12px;
      font-family: ui-monospace, monospace; outline: none; resize: vertical;
    }
    textarea.json:focus { border-color: #60a5fa; }

    .btn-row { display: flex; gap: 8px; margin: 12px 0; }
    .btn {
      padding: 8px 16px; border: 1px solid #3b82f6; background: #3b82f6; color: #fff;
      border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;
    }
    .btn:hover { background: #2563eb; }
    .btn.secondary { background: transparent; color: #94a3b8; border-color: #475569; }
    .btn.secondary:hover { background: #1e293b; color: #e2e8f0; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .response-meta { font-size: 11px; color: #94a3b8; margin-bottom: 6px; display: flex; gap: 12px; }
    .response-meta .ok { color: #10b981; }
    .response-meta .err { color: #ef4444; }
    .response-body {
      background: #0a0f1e; border: 1px solid #334155; border-radius: 6px; padding: 12px;
      font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all;
      max-height: 500px; overflow-y: auto; color: #cbd5e1;
    }

    .empty-state { text-align: center; color: #64748b; padding: 40px 20px; }

    details { margin-bottom: 8px; }
    summary { cursor: pointer; color: #94a3b8; font-size: 12px; padding: 4px 0; }
    summary:hover { color: #cbd5e1; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🛝 Playground</h1>
    <label>Base URL:</label>
    <input type="text" id="baseUrl" placeholder="http://host:port" />
    <label>API Key:</label>
    <input type="password" id="apiKey" placeholder="cpx_..." />
    <span id="connStatus"><span class="status-dot"></span><span id="connLabel">not tested</span></span>
    <button class="btn secondary" id="testConn">Test</button>
  </div>

  <div class="layout">
    <div class="panel left">
      <div class="search-box">
        <input type="text" id="search" placeholder="Search model id, vendor, family..." />
      </div>
      <table id="modelsTable">
        <thead>
          <tr>
            <th>Model</th>
            <th>Endpoints</th>
            <th>Capabilities</th>
            <th>Context</th>
          </tr>
        </thead>
        <tbody id="modelsBody">
          <tr><td colspan="4" class="empty-state">Loading models… (enter API key above)</td></tr>
        </tbody>
      </table>
    </div>

    <div class="panel right" id="tryPanel">
      <div class="empty-state">← Select a model from the left to try it</div>
    </div>
  </div>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const baseUrlEl = $('baseUrl');
  const apiKeyEl = $('apiKey');
  const searchEl = $('search');
  const modelsBody = $('modelsBody');
  const tryPanel = $('tryPanel');
  const connDot = document.querySelector('#connStatus .status-dot');
  const connLabel = $('connLabel');

  // Load saved values
  baseUrlEl.value = localStorage.getItem('cpx_base') || window.location.origin;
  apiKeyEl.value = localStorage.getItem('cpx_key') || '';
  baseUrlEl.addEventListener('change', () => localStorage.setItem('cpx_base', baseUrlEl.value));
  apiKeyEl.addEventListener('change', () => localStorage.setItem('cpx_key', apiKeyEl.value));

  let models = [];
  let selected = null;

  function headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKeyEl.value.trim(),
    };
  }

  async function loadModels() {
    try {
      const r = await fetch(baseUrlEl.value.replace(/\\/$/, '') + '/v1/models', { headers: headers() });
      if (!r.ok) {
        modelsBody.innerHTML = '<tr><td colspan="4" class="empty-state">HTTP ' + r.status + ' — check API key</td></tr>';
        setStatus(false, 'HTTP ' + r.status);
        return;
      }
      const data = await r.json();
      // /v1/models returns a trimmed view, we also want capabilities/endpoints — fetch raw list
      // The /v1/models endpoint already uses state.models which has the fields we want via cast
      // But our trimmed response strips them. So we fetch the full model list via a debug path.
      // Fallback: request the raw models by calling /v1/models but our server strips fields.
      // For now, reuse same data — the proxy trim should be fixed to include these fields.
      models = (data.data || []).map(m => ({
        id: m.id,
        vendor: m.owned_by || m.vendor || '',
        name: m.display_name || m.name || m.id,
        _raw: m,
      }));
      // Try fetching full metadata from a dedicated endpoint
      try {
        const r2 = await fetch(baseUrlEl.value.replace(/\\/$/, '') + '/playground/api/models', { headers: headers() });
        if (r2.ok) {
          const full = await r2.json();
          models = (full.data || []).map(m => ({
            id: m.id,
            vendor: m.vendor || '',
            name: m.name || m.id,
            family: m.capabilities?.family || '',
            endpoints: m.supported_endpoints || [],
            supports: m.capabilities?.supports || {},
            limits: m.capabilities?.limits || {},
            type: m.capabilities?.type || '',
            _raw: m,
          }));
        }
      } catch {}
      setStatus(true, models.length + ' models');
      renderModels();
    } catch (e) {
      setStatus(false, e.message);
      modelsBody.innerHTML = '<tr><td colspan="4" class="empty-state">Error: ' + e.message + '</td></tr>';
    }
  }

  function setStatus(ok, label) {
    connDot.classList.remove('ok', 'err');
    connDot.classList.add(ok ? 'ok' : 'err');
    connLabel.textContent = label;
  }

  // Determine which endpoint the proxy uses for a model
  function proxyEndpointFor(model) {
    const eps = model.endpoints || [];
    if (eps.includes('/responses')) return '/v1/responses';
    if (eps.includes('/v1/messages')) return '/v1/messages';
    if (eps.includes('/chat/completions')) return '/v1/chat/completions';
    // Unknown — assume chat
    return '/v1/chat/completions';
  }

  function renderModels() {
    const q = searchEl.value.toLowerCase().trim();
    const rows = models
      .filter(m => !q || m.id.toLowerCase().includes(q) || (m.vendor || '').toLowerCase().includes(q) || (m.family || '').toLowerCase().includes(q))
      .map(m => {
        const eps = m.endpoints || [];
        const epBadges = [];
        if (eps.includes('/chat/completions')) epBadges.push('<span class="badge chat">chat</span>');
        if (eps.includes('/responses')) epBadges.push('<span class="badge resp">responses</span>');
        if (eps.includes('/v1/messages')) epBadges.push('<span class="badge msg">messages</span>');
        if (eps.includes('ws:/responses')) epBadges.push('<span class="badge ws">ws</span>');
        if (epBadges.length === 0) epBadges.push('<span class="hint">—</span>');

        const supports = m.supports || {};
        const caps = [];
        if (supports.tool_calls) caps.push('<span class="cap active">tools</span>');
        if (supports.vision) caps.push('<span class="cap active">vision</span>');
        if (supports.streaming) caps.push('<span class="cap active">stream</span>');
        if (supports.structured_outputs) caps.push('<span class="cap active">json</span>');
        if (supports.parallel_tool_calls) caps.push('<span class="cap active">∥tools</span>');
        if (supports.reasoning_effort) caps.push('<span class="cap active">reasoning</span>');
        if (supports.dimensions) caps.push('<span class="cap active">dims</span>');

        const ctx = m.limits?.max_context_window_tokens;
        const out = m.limits?.max_output_tokens;
        const ctxStr = ctx ? (ctx >= 1000 ? (ctx / 1000).toFixed(0) + 'K' : ctx) : '—';
        const outStr = out ? (out >= 1000 ? (out / 1000).toFixed(0) + 'K' : out) : '—';

        const isSelected = selected && selected.id === m.id;
        return '<tr class="model-row' + (isSelected ? ' selected' : '') + '" data-id="' + m.id + '">' +
          '<td><div class="model-id">' + escapeHtml(m.id) + '</div>' +
          '<div class="model-vendor">' + escapeHtml(m.vendor) + (m.family ? ' · ' + escapeHtml(m.family) : '') + '</div></td>' +
          '<td><div class="badges">' + epBadges.join('') + '</div></td>' +
          '<td><div class="caps">' + (caps.join('') || '<span class="hint">—</span>') + '</div></td>' +
          '<td><div class="limits">ctx ' + ctxStr + '<br/>out ' + outStr + '</div></td>' +
          '</tr>';
      })
      .join('');
    modelsBody.innerHTML = rows || '<tr><td colspan="4" class="empty-state">No models match</td></tr>';

    modelsBody.querySelectorAll('.model-row').forEach(row => {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-id');
        selected = models.find(m => m.id === id);
        renderModels();
        renderTryPanel();
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderTryPanel() {
    if (!selected) {
      tryPanel.innerHTML = '<div class="empty-state">← Select a model from the left to try it</div>';
      return;
    }
    const m = selected;
    const eps = m.endpoints || [];
    const available = [];
    if (eps.includes('/chat/completions')) available.push('/v1/chat/completions');
    if (eps.includes('/responses')) available.push('/v1/responses');
    if (eps.includes('/v1/messages')) available.push('/v1/messages');
    if (available.length === 0) available.push('/v1/chat/completions'); // fallback

    const recommended = proxyEndpointFor(m);

    tryPanel.innerHTML = [
      '<div class="section">',
      '<div class="section-title">Selected Model</div>',
      '<div><strong>' + escapeHtml(m.id) + '</strong> <span class="hint">· ' + escapeHtml(m.vendor) + '</span></div>',
      m.family ? '<div class="hint">family: ' + escapeHtml(m.family) + '</div>' : '',
      '</div>',

      '<div class="section">',
      '<div class="section-title">Endpoint</div>',
      '<div class="endpoint-tabs" id="epTabs">',
      available.map(ep => '<button class="endpoint-tab' + (ep === recommended ? ' active recommended' : '') + '" data-ep="' + ep + '">' + ep + '</button>').join(''),
      '</div>',
      '<div class="hint">★ = recommended (proxy auto-routes here)</div>',
      '</div>',

      '<div id="paramsBox"></div>',

      '<div class="btn-row">',
      '<button class="btn" id="sendBtn">Send</button>',
      '<button class="btn secondary" id="resetBtn">Reset</button>',
      '</div>',

      '<div class="section">',
      '<div class="section-title">Response</div>',
      '<div class="response-meta" id="respMeta"></div>',
      '<div class="response-body" id="respBody">(not sent yet)</div>',
      '</div>',
    ].join('');

    const epTabs = tryPanel.querySelectorAll('.endpoint-tab');
    epTabs.forEach(t => t.addEventListener('click', () => {
      epTabs.forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      renderParamsForm(t.getAttribute('data-ep'));
    }));

    renderParamsForm(recommended);

    $('sendBtn').addEventListener('click', sendRequest);
    $('resetBtn').addEventListener('click', () => renderParamsForm(currentEndpoint()));
  }

  function currentEndpoint() {
    const active = tryPanel.querySelector('.endpoint-tab.active');
    return active ? active.getAttribute('data-ep') : '/v1/chat/completions';
  }

  function renderParamsForm(endpoint) {
    const m = selected;
    const supports = m.supports || {};
    const defMax = Math.min(m.limits?.max_output_tokens || 2000, 2000);

    let body;
    if (endpoint === '/v1/chat/completions') {
      body = {
        model: m.id,
        messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
        max_completion_tokens: defMax,
        stream: false,
      };
    } else if (endpoint === '/v1/responses') {
      body = {
        model: m.id,
        input: 'Say hello in one sentence.',
        max_output_tokens: defMax,
        stream: false,
      };
    } else if (endpoint === '/v1/messages') {
      body = {
        model: m.id,
        max_tokens: defMax,
        messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
        stream: false,
      };
    }

    // Hints: what params this model supports
    const hints = [];
    if (supports.tool_calls) hints.push('supports tools');
    if (supports.vision) hints.push('supports vision');
    if (supports.streaming) hints.push('supports streaming');
    if (supports.structured_outputs) hints.push('supports response_format/json_schema');
    if (supports.reasoning_effort) hints.push('supports reasoning_effort: ' + JSON.stringify(supports.reasoning_effort));
    const isCodex = m.id.includes('-codex');
    if (isCodex) hints.push('⚠ codex models reject temperature/top_p');

    $('paramsBox').innerHTML = [
      '<div class="section">',
      '<div class="section-title">Request Body</div>',
      '<textarea class="json" id="bodyEditor" spellcheck="false">' + escapeHtml(JSON.stringify(body, null, 2)) + '</textarea>',
      hints.length ? '<div class="hint" style="margin-top:6px">' + hints.join(' · ') + '</div>' : '',
      '</div>',
      renderParamReference(m, endpoint),
    ].join('');
  }

  function renderParamReference(m, endpoint) {
    const supports = m.supports || {};
    const isResponses = endpoint === '/v1/responses';
    const isMessages = endpoint === '/v1/messages';
    const limits = m.limits || {};
    const isCodex = m.id.includes('-codex');

    const rows = [];
    rows.push(['model', 'string (required)', 'Model id = ' + m.id]);
    if (isResponses) {
      rows.push(['input', 'string | array (required)', 'Prompt or messages array']);
      rows.push(['instructions', 'string', 'System-like instructions']);
      rows.push(['max_output_tokens', 'number', 'Max output (upper: ' + (limits.max_output_tokens || '?') + ')']);
    } else if (isMessages) {
      rows.push(['messages', 'array (required)', 'Anthropic format']);
      rows.push(['system', 'string', 'System prompt']);
      rows.push(['max_tokens', 'number (required)', 'Max output']);
    } else {
      rows.push(['messages', 'array (required)', 'OpenAI chat format']);
      rows.push(['max_completion_tokens | max_tokens', 'number', 'Max output']);
    }
    rows.push(['stream', 'boolean', 'Set true for SSE streaming' + (supports.streaming ? '' : ' (NOT supported)')]);
    if (!isCodex) {
      rows.push(['temperature', 'number (0-2)', isCodex ? '⚠ rejected by codex' : 'Sampling']);
      rows.push(['top_p', 'number (0-1)', 'Nucleus sampling']);
    }
    if (supports.tool_calls) {
      rows.push(['tools', 'array', 'Function-calling tools']);
      rows.push(['tool_choice', '"auto"|"none"|"required"|object', 'Tool selection']);
    }
    if (supports.structured_outputs) {
      rows.push(['response_format', '{type:"json_object"|"json_schema",...}', 'Structured output']);
    }
    if (supports.reasoning_effort) {
      rows.push(['reasoning_effort', JSON.stringify(supports.reasoning_effort), 'Reasoning depth']);
    }
    if (supports.vision) {
      rows.push(['messages[].content', 'array of {type, text|image_url}', 'Use image_url for vision']);
    }

    return [
      '<details>',
      '<summary>All supported parameters (' + rows.length + ')</summary>',
      '<table style="margin-top:8px; font-size:11px;">',
      '<thead><tr><th>Param</th><th>Type</th><th>Notes</th></tr></thead>',
      '<tbody>',
      rows.map(r => '<tr><td style="font-family:ui-monospace,monospace;color:#e2e8f0">' + escapeHtml(r[0]) + '</td><td style="color:#94a3b8">' + escapeHtml(r[1]) + '</td><td style="color:#64748b">' + escapeHtml(r[2]) + '</td></tr>').join(''),
      '</tbody></table>',
      '</details>',
    ].join('');
  }

  async function sendRequest() {
    const endpoint = currentEndpoint();
    const bodyText = $('bodyEditor').value;
    const respMeta = $('respMeta');
    const respBody = $('respBody');
    const sendBtn = $('sendBtn');

    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch (e) {
      respMeta.innerHTML = '<span class="err">JSON parse error</span>';
      respBody.textContent = e.message;
      return;
    }

    sendBtn.disabled = true;
    respMeta.innerHTML = 'Sending…';
    respBody.textContent = '';
    const t0 = Date.now();
    const isStream = payload.stream === true;

    try {
      const url = baseUrlEl.value.replace(/\\/$/, '') + endpoint;
      const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
      const elapsed = Date.now() - t0;

      if (!r.ok) {
        const text = await r.text();
        respMeta.innerHTML = '<span class="err">HTTP ' + r.status + '</span> · ' + elapsed + ' ms';
        respBody.textContent = text;
        sendBtn.disabled = false;
        return;
      }

      if (isStream) {
        respMeta.innerHTML = '<span class="ok">HTTP ' + r.status + '</span> · ' + elapsed + ' ms TTFB · streaming…';
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        respBody.textContent = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          respBody.textContent = buffer;
          respBody.scrollTop = respBody.scrollHeight;
        }
        respMeta.innerHTML = '<span class="ok">HTTP ' + r.status + '</span> · ' + elapsed + ' ms TTFB · ' + (Date.now() - t0) + ' ms total';
      } else {
        const json = await r.json();
        respMeta.innerHTML = '<span class="ok">HTTP ' + r.status + '</span> · ' + elapsed + ' ms';
        respBody.textContent = JSON.stringify(json, null, 2);
      }
    } catch (e) {
      respMeta.innerHTML = '<span class="err">Error</span>';
      respBody.textContent = e.message;
    } finally {
      sendBtn.disabled = false;
    }
  }

  $('testConn').addEventListener('click', loadModels);
  searchEl.addEventListener('input', renderModels);

  if (apiKeyEl.value) loadModels();
})();
</script>
</body>
</html>`;
}
