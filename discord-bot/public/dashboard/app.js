const POLL_MS = 2000;
const HISTORY_MAX = 30;

const state = {
  labels: [],
  cmdSeries: [],
  errSeries: [],
  sessionSeries: [],
  logsAutoScroll: true,
};

const el = {
  healthStatus: document.getElementById('health-status'),
  updatedAt: document.getElementById('updated-at'),
  sessionsCount: document.getElementById('sessions-count'),
  guildCount: document.getElementById('guild-count'),
  circuitState: document.getElementById('circuit-state'),
  metricBody: document.getElementById('metric-body'),
  sessionBody: document.getElementById('session-body'),
  livePill: document.getElementById('live-pill'),
  liveText: document.getElementById('live-text'),
  commandCanvas: document.getElementById('command-chart'),
  sessionCanvas: document.getElementById('session-chart'),
  memoryRss: document.getElementById('memory-rss'),
  runtimeErrors: document.getElementById('runtime-errors'),
  recentWarns: document.getElementById('recent-warns'),
  recentErrors: document.getElementById('recent-errors'),
  guildRuntimeBody: document.getElementById('guild-runtime-body'),
  runtimeErrorBody: document.getElementById('runtime-error-body'),
  liveLogsBody: document.getElementById('live-logs-body'),
  logsWrap: document.getElementById('logs-wrap'),
  logsAutoscroll: document.getElementById('logs-autoscroll'),
};

function initLogsAutoscroll() {
  const saved = localStorage.getItem('spoticord.logsAutoScroll');
  if (saved === '0') state.logsAutoScroll = false;
  if (saved === '1') state.logsAutoScroll = true;
  if (el.logsAutoscroll) el.logsAutoscroll.checked = state.logsAutoScroll;
  if (el.logsAutoscroll) {
    el.logsAutoscroll.addEventListener('change', () => {
      state.logsAutoScroll = Boolean(el.logsAutoscroll.checked);
      localStorage.setItem('spoticord.logsAutoScroll', state.logsAutoScroll ? '1' : '0');
      if (state.logsAutoScroll && el.logsWrap) {
        el.logsWrap.scrollTop = el.logsWrap.scrollHeight;
      }
    });
  }
}

function pinLogsToBottom() {
  if (!el.logsWrap) return;
  const node = el.logsWrap;
  const apply = () => {
    node.scrollTop = node.scrollHeight;
  };
  apply();
  requestAnimationFrame(apply);
  setTimeout(apply, 0);
}

function esc(v) {
  return String(v == null ? '' : v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function setLiveState(mode, text) {
  el.livePill.classList.remove('live', 'error');
  if (mode === 'live') el.livePill.classList.add('live');
  if (mode === 'error') el.livePill.classList.add('error');
  el.liveText.textContent = text;
}

function pushSeries(label, cmdCount, errCount, sessions) {
  state.labels.push(label);
  state.cmdSeries.push(cmdCount);
  state.errSeries.push(errCount);
  state.sessionSeries.push(sessions);

  if (state.labels.length > HISTORY_MAX) {
    state.labels.shift();
    state.cmdSeries.shift();
    state.errSeries.shift();
    state.sessionSeries.shift();
  }
}

function drawLineChart(canvas, labels, lines) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const pad = { top: 20, right: 20, bottom: 36, left: 40 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;

  ctx.clearRect(0, 0, w, h);

  const maxValue = Math.max(1, ...lines.flatMap((line) => line.values));
  const yTicks = 4;

  ctx.strokeStyle = 'rgba(170, 215, 240, 0.2)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= yTicks; i += 1) {
    const y = pad.top + (ch * i) / yTicks;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(197, 223, 239, 0.8)';
  ctx.font = '12px JetBrains Mono, monospace';
  for (let i = 0; i <= yTicks; i += 1) {
    const value = Math.round(maxValue - (maxValue * i) / yTicks);
    const y = pad.top + (ch * i) / yTicks + 4;
    ctx.fillText(String(value), 6, y);
  }

  const points = Math.max(1, labels.length - 1);

  lines.forEach((line) => {
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    line.values.forEach((v, i) => {
      const x = pad.left + (cw * i) / points;
      const y = pad.top + ch - (v / maxValue) * ch;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  ctx.fillStyle = 'rgba(197, 223, 239, 0.72)';
  const step = Math.max(1, Math.floor(labels.length / 4));
  for (let i = 0; i < labels.length; i += step) {
    const x = pad.left + (cw * i) / points;
    ctx.fillText(labels[i], Math.max(pad.left, x - 18), h - 10);
  }
}

function renderTables(metrics, sessions, diagnostics = {}) {
  const metricRows = Object.entries(metrics || {}).sort((a, b) => b[1] - a[1]);
  el.metricBody.innerHTML = metricRows.length
    ? metricRows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')
    : '<tr><td colspan="2">No counters yet</td></tr>';

  el.sessionBody.innerHTML = Array.isArray(sessions) && sessions.length
    ? sessions.map((s) => `<tr><td>${esc(s.guildId || '-')}</td><td>${esc(s.hostId || '-')}</td><td>${esc(s.voiceChannelId || '-')}</td></tr>`).join('')
    : '<tr><td colspan="3">No active sessions</td></tr>';

  const guildRuntime = diagnostics.guildRuntime || [];
  el.guildRuntimeBody.innerHTML = guildRuntime.length
    ? guildRuntime.map((g) => `<tr><td>${esc(g.guildId)}</td><td>${esc(g.playerStatus || 'none')}</td><td>${g.hasConnection ? 'yes' : 'no'}</td><td>${esc(g.ffmpegPid || '-')}</td><td>${g.restartTimerActive ? 'yes' : 'no'}</td></tr>`).join('')
    : '<tr><td colspan="5">No guild runtime state</td></tr>';

  const runtimeErrors = diagnostics.runtimeErrors || [];
  el.runtimeErrorBody.innerHTML = runtimeErrors.length
    ? runtimeErrors.map((r) => `<tr><td>${esc(fmtTime(r.ts))}</td><td>${esc(r.scope || '-')}</td><td>${esc(r.message || '-')}</td></tr>`).join('')
    : '<tr><td colspan="3">No runtime errors captured</td></tr>';

  const logs = diagnostics.recentLogs || [];
  el.liveLogsBody.innerHTML = logs.length
    ? logs.map((l) => {
      const meta = l.meta ? esc(JSON.stringify(l.meta).slice(0, 180)) : '';
      return `<tr class="level-${esc(l.level || 'INFO')}"><td>${esc(fmtTime(l.ts))}</td><td>${esc(l.level || 'INFO')}</td><td>${esc(l.msg || '')}</td><td>${meta}</td></tr>`;
    }).join('')
    : '<tr><td colspan="4">No logs available yet</td></tr>';

  if (state.logsAutoScroll) pinLogsToBottom();
}

function renderSnapshot(payload) {
  const health = payload.health || {};
  const metrics = payload.metrics || {};
  const diagnostics = payload.diagnostics || {};
  const logs = diagnostics.recentLogs || [];

  el.healthStatus.textContent = String(health.status || 'unknown').toUpperCase();
  el.sessionsCount.textContent = String(health.sessions || 0);
  el.guildCount.textContent = String(health.guildStates || 0);
  el.circuitState.textContent = health.spotifyCircuitOpen ? 'Open' : 'Closed';
  el.updatedAt.textContent = `Updated ${fmtTime(payload.now)} | Uptime ${payload.uptimeSec}s`;
  el.memoryRss.textContent = `${Number(diagnostics.memoryMb?.rss || 0).toFixed(1)} MB`;
  el.runtimeErrors.textContent = String((diagnostics.runtimeErrors || []).length);
  el.recentWarns.textContent = String(logs.filter((l) => l.level === 'WARN').length);
  el.recentErrors.textContent = String(logs.filter((l) => l.level === 'ERROR').length);

  pushSeries(
    fmtTime(payload.now),
    Number(metrics.command_start_total || 0),
    Number(metrics.command_errors_total || 0),
    Number(health.sessions || 0)
  );

  drawLineChart(el.commandCanvas, state.labels, [
    { values: state.cmdSeries, color: '#4cd7b5' },
    { values: state.errSeries, color: '#ff6b7a' },
  ]);

  drawLineChart(el.sessionCanvas, state.labels, [
    { values: state.sessionSeries, color: '#42aaff' },
  ]);

  renderTables(metrics, payload.sessions, diagnostics);
}

async function refresh() {
  try {
    const res = await fetch('/api/dashboard', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    renderSnapshot(payload);
    setLiveState('live', `Live updates every ${POLL_MS / 1000}s`);
  } catch (err) {
    setLiveState('error', `Disconnected: ${err.message}`);
  }
}

refresh();
initLogsAutoscroll();
setInterval(refresh, POLL_MS);
