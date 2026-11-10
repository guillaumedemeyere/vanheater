// Van Heater dashboard (read-only). Two data modes, chosen by config.json:
//  "server": consume /api/stream (SSE) from the portal server (recommended)
//  "direct": connect to the broker over wss with mqtt.js (static hosting, no server)
const $ = (id) => document.getElementById(id);
const vals = {};
window.__dh = { vals };
let online = null, lastMsg = 0, history = {};

// ---- theme
const themeSel = $('theme');
const savedTheme = (() => { try { return localStorage.getItem('theme'); } catch { return null; } })();
const setTheme = (t) => {
  document.documentElement.dataset.theme = t; themeSel.value = t;
  try { localStorage.setItem('theme', t); } catch {}
};
setTheme(savedTheme || 'auto');
themeSel.onchange = () => setTheme(themeSel.value);

// ---- rendering
const fmt = (v, d = 1) => (typeof v === 'number' ? v.toFixed(d) : (v ?? '--'));

function stateOf() {
  if (online === false) return 'offline';
  const err = String(vals.ErrorString ?? '');
  if (err && !err.startsWith('E-00')) return 'fault';
  const r = String(vals.RunString ?? '').toLowerCase();
  if (/cool/.test(r)) return 'cooling';
  if (/start|prim|glow|ignit|heat/.test(r)) return 'starting';
  if (/run/.test(r)) return 'running';
  return 'idle';
}

function render() {
  window.dispatchEvent(new Event('dh-render'));
  $('temp').textContent = fmt(vals.TempCurrent);
  $('target').textContent = fmt(vals.TempDesired, 0);
  $('runstring').textContent = online === false ? 'Offline' : (vals.RunString ?? '—');
  $('volt').textContent = fmt(vals.InputVoltage);
  $('body').textContent = fmt(vals.TempBody, 0);
  $('fan').textContent = fmt(vals.FanRPM, 0);
  $('pump').textContent = fmt(vals.PumpActual);
  $('fuel').textContent = typeof vals.FuelRate === 'number' ? (vals.FuelRate / 1000).toFixed(3) : '--'; // FuelRate is mL/h
  const L = (ml) => (typeof ml === 'number' ? (ml / 1000).toFixed(2) : '--'); // mL -> L
  $('used').textContent = L(vals.FuelUsage);
  $('total').textContent = L(vals.TotalFuelUsage);
  $('hum').textContent = fmt(vals.Humidity, 0);
  $('err').textContent = vals.ErrorString ?? '--';
  const st = stateOf();
  document.body.dataset.state = st;
  const a = $('alert');
  if (st === 'fault') { a.hidden = false; a.textContent = vals.ErrorString; }
  else if (st === 'offline') { a.hidden = false; a.textContent = 'Heater is offline'; }
  else a.hidden = true;
  const stale = lastMsg && Date.now() - lastMsg > 120000;
  document.body.classList.toggle('stale', !!stale);
  $('foot').textContent = lastMsg ? 'Updated ' + new Date(lastMsg).toLocaleTimeString() : '';
}

const RANGE_MS = { '1h': 36e5, '4h': 144e5, '1d': 864e5, '7d': 6048e5 };
let range = (() => { try { return localStorage.getItem('range'); } catch { return null; } })() || '4h';
let ser = {}, span = [0, 0];

function drawChart() {
  const svg = $('chart');
  const a = ser.TempCurrent || [], b = ser.TempDesired || [];
  const all = [...a, ...b];
  if (all.length < 1) { svg.innerHTML = ''; $('axL').textContent = $('axR').textContent = ''; return; }
  const t1 = span[1], t0 = Math.max(span[0], Math.min(...all.map((p) => p[0])) - 1000);   // don't leave empty space before the first sample
  const ys = all.map((p) => p[1]);
  const lo = Math.floor(Math.min(...ys) - 1), hi = Math.ceil(Math.max(...ys) + 1);
  const x = (t) => 6 + ((t - t0) / Math.max(1, t1 - t0)) * 588;
  const y = (v) => 154 - ((v - lo) / (hi - lo)) * 148;
  const path = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join('');
  const dots = (pts, c) => pts.length < 3 ? pts.map((p) => `<circle cx="${x(p[0]).toFixed(1)}" cy="${y(p[1]).toFixed(1)}" r="3" fill="${c}"/>`).join('') : '';
  svg.innerHTML = dots(a, 'var(--temp)') + dots(b, 'var(--target)') +
    `<path d="${path(b)}" fill="none" stroke="var(--target)" stroke-width="2" stroke-dasharray="6 4" vector-effect="non-scaling-stroke"/>` +
    `<path d="${path(a)}" fill="none" stroke="var(--temp)" stroke-width="3" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` +
    `<text x="8" y="14" fill="var(--muted)" font-size="11">${hi}°</text>` +
    `<text x="8" y="152" fill="var(--muted)" font-size="11">${lo}°</text>`;
  const f = (t) => new Date(t).toLocaleString([], range === '7d' ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  $('axL').textContent = f(t0); $('axR').textContent = f(t1);
}

async function loadHistory() {
  if (cfg.mode === 'direct') {            // no server: only what this page has seen since load
    const from = Date.now() - RANGE_MS[range];
    ser = Object.fromEntries(Object.entries(history).map(([k, h]) => [k, h.filter((p) => p[0] >= from)]));
    span = [from, Date.now()];
  } else {
    try { const h = await fetch(`${cfg.apiBase}/history?range=${range}`).then((r) => r.json()); ser = h.series; span = [h.from, h.to]; } catch { return; }
  }
  drawChart();
}
function markRange() { document.querySelectorAll('#ranges button').forEach((b) => b.classList.toggle('on', b.dataset.r === range)); }
document.querySelectorAll('#ranges button').forEach((b) => b.onclick = () => {
  range = b.dataset.r; try { localStorage.setItem('range', range); } catch {} markRange(); loadHistory();
});

function conn(ok, text) {
  const c = $('conn'); c.textContent = text; c.className = 'pill ' + (ok ? 'ok' : 'bad');
}

// ---- data sources
const cfg = await fetch('/config.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ mode: 'server', apiBase: '/api' }));

function startServer() {
  const es = new EventSource(cfg.apiBase + '/stream');
  es.onopen = () => conn(true, 'live');
  es.onerror = () => conn(false, 'reconnecting…');
  es.addEventListener('snapshot', (e) => {
    const s = JSON.parse(e.data);
    Object.assign(vals, s.values); online = s.online; lastMsg = s.lastMsg; render();
  });
  es.addEventListener('value', (e) => { const d = JSON.parse(e.data); vals[d.k] = d.v; lastMsg = Date.now(); render(); });
  es.addEventListener('status', (e) => { online = JSON.parse(e.data).online; render(); });
}

async function startDirect() {
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js';
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
  const p = cfg.prefix;
  const c = window.mqtt.connect(cfg.wss, { clientId: 'dh-web-' + Math.random().toString(16).slice(2, 8), reconnectPeriod: 5000 });
  c.on('connect', () => { conn(true, 'live'); c.subscribe([`${p}/sts/#`, `${p}/status`]); });
  c.on('close', () => conn(false, 'reconnecting…'));
  c.on('message', (topic, payload) => {
    const text = payload.toString(); lastMsg = Date.now();
    if (topic === `${p}/status`) online = text.trim() === 'online';
    else { const n = Number(text); vals[topic.slice(p.length + 5)] = text !== '' && Number.isFinite(n) ? n : text; }
    // light in-browser history (not persisted in direct mode)
    for (const k of ['TempCurrent', 'TempDesired', 'TempBody', 'InputVoltage']) {
      const h = (history[k] ??= []); const last = h[h.length - 1];
      if (vals[k] != null && (!last || lastMsg - last[0] > 30000)) { h.push([lastMsg, vals[k]]); if (h.length > 2880) h.shift(); }
    }
    render(); drawChart();
  });
}

render(); markRange(); loadHistory();
setInterval(render, 15000);
setInterval(loadHistory, 60000);
(cfg.mode === 'direct' ? startDirect : startServer)();
