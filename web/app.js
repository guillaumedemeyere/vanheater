// Van Heater UI: four layouts (Classic, Gauge, Dog, History) over one live data layer.
// Controls and Alarms are persistent components (see index.html #stash) moved into the active layout's slots.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {
  get(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const D = window.__dh, vals = D.vals;
let online = null, lastMsg = 0, active = [];
let range = store.get('range', '4h'), metric = 'temp', mode = store.get('mode', 'classic');
let ser = {}, span = [0, 0];
const RANGE_MS = { '1h': 36e5, '4h': 144e5, '1d': 864e5, '7d': 6048e5 };
const cfg = await fetch('/config.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ mode: 'server', apiBase: '/api' }));
const API = cfg.apiBase || '/api';

/* ---------------- theme ---------------- */
const themeSel = $('#theme');
const setTheme = (t) => { document.documentElement.dataset.theme = t; themeSel.value = t; store.set('theme', t); };
setTheme(store.get('theme', 'auto'));
themeSel.onchange = () => { setTheme(themeSel.value); draw(); };

/* ---------------- update interval ---------------- */
let pollMs = Number(store.get('poll', store.get('theme', 'auto') === 'eink' ? '30000' : '0'));   // e-ink defaults to 30 s unless chosen
if (!Number.isFinite(pollMs) || pollMs < 0) pollMs = 0;
D.pollMs = pollMs;
const pollSel = $('#poll');
pollSel.value = String(pollMs);
if (!$$('#poll option').some((o) => o.value === String(pollMs))) { const o = document.createElement('option'); o.value = String(pollMs); o.textContent = pollMs / 1000 + ' s'; pollSel.appendChild(o); pollSel.value = String(pollMs); }
pollSel.onchange = () => { pollMs = Number(pollSel.value); D.pollMs = pollMs; store.set('poll', String(pollMs)); if (cfg.mode !== 'direct') startServer(); };

/* ---------------- derived values ---------------- */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const f1 = (v) => (isNum(v) ? v.toFixed(1) : '--');
const f0 = (v) => (isNum(v) ? Math.round(v).toString() : '--');
const litres = (ml) => (isNum(ml) ? (ml / 1000).toFixed(2) : '--');
const hzMode = () => vals.Thermostat === 0;                         // fixed-Hz mode: TempDesired is a pump demand level, not °C
function calcHz(d) {                                                // same formula as the stock page
  const pMin = vals.PumpMinActual, pMax = vals.PumpMaxActual, tMin = vals.TempMin, tMax = vals.TempMax;
  if (![d, pMin, pMax, tMin, tMax].every(isNum) || tMax === tMin) return null;
  return +(pMin + ((d - tMin) / (tMax - tMin)) * (pMax - pMin) - 0.0499995).toFixed(1);
}
const demandHz = () => (isNum(vals.PumpFixed) ? vals.PumpFixed : calcHz(vals.TempDesired));
const lim = () => {
  const c = D.alarms?.config;
  return { hot: c?.rules?.tempHigh?.value ?? 30, cold: c?.rules?.tempLow?.value ?? 10, armed: !!c?.armed };
};
const errBad = () => typeof vals.ErrorString === 'string' && !vals.ErrorString.startsWith('E-00');
function runKind() {
  if (online === false) return 'offline';
  const r = String(vals.RunString ?? '').toLowerCase();
  if (/cool/.test(r)) return 'cooling';
  if (/start|prim|glow|ignit|heat/.test(r)) return 'starting';
  if (/run/.test(r)) return 'running';
  return 'idle';
}
const banners = () => {
  const list = active.map((a) => ({ rule: a.rule, text: `${a.title}: ${a.msg}` }));
  if (online === false && !active.some((a) => a.rule === 'offline')) list.push({ rule: 'offline', text: 'Heater is offline' });
  if (errBad() && !active.some((a) => a.rule === 'error')) list.push({ rule: 'error', text: `Heater error: ${vals.ErrorString}` });
  return list;
};
const accent = () => (banners().length ? 'var(--bad)' : ({ running: 'var(--ember)', starting: 'var(--warn)', cooling: 'var(--target)' })[runKind()] || 'var(--muted)');
const bannerHTML = () => banners().map((b) => `<div class="banner">${b.text}</div>`).join('');
const runLabel = () => (online === false ? 'Offline' : (vals.RunString ?? '—'));
const targetLine = () => (hzMode()
  ? `Fixed Hz · demand <b>${f1(demandHz())}</b> Hz · pump <b>${f1(vals.PumpActual)}</b> Hz`
  : `Target <b>${f1(vals.TempDesired)}</b> °C`);

/* ---------------- toast ---------------- */
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2200); }
D.toast = toast;

/* ---------------- charts ---------------- */
const pathD = (pts, x, y) => pts.map((p, i) => (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join('');
function lineChart({ w, h, lines, bands = [], pad = [34, 10, 14, 22], el, dec = 0 }) {
  w = Math.max(260, Math.round((el && el.clientWidth) || w));
  const [pl, pr, pt, pb] = pad, from = span[0], to = span[1];
  const all = lines.flatMap((l) => l.pts.map((p) => p[1]));
  if (!all.length) return { w, svg: `<div class="sub" style="padding:24px 4px">No data for this range yet.</div>`, x: () => 0, y: () => 0 };
  bands.forEach((b) => all.push(b.from, b.to));
  let lo = Math.min(...all), hi = Math.max(...all); const m = (hi - lo) * 0.1 || 1; lo -= m; hi += m;
  const x = (t) => pl + ((t - from) / Math.max(1, to - from)) * (w - pl - pr), y = (v) => h - pb - ((v - lo) / (hi - lo)) * (h - pt - pb);
  let s = '';
  for (let i = 0; i <= 3; i++) { const v = lo + ((hi - lo) * i) / 3, yy = y(v); s += `<line x1="${pl}" x2="${w - pr}" y1="${yy}" y2="${yy}" stroke="var(--line)"/><text x="4" y="${yy + 3}">${v.toFixed(dec)}</text>`; }
  bands.forEach((b) => { const y1 = Math.max(pt, y(b.to)), y2 = Math.min(h - pb, y(b.from)); if (y2 > y1) s += `<rect x="${pl}" y="${y1}" width="${w - pl - pr}" height="${y2 - y1}" fill="${b.color}"/>`; });
  lines.forEach((l) => { if (l.pts.length) s += `<path d="${pathD(l.pts, x, y)}" fill="none" stroke="${l.color}" stroke-width="${l.width || 2.5}" stroke-linejoin="round" ${l.dash ? 'stroke-dasharray="6 4"' : ''}/>`; });
  const fmt = (t) => new Date(t).toLocaleString([], range === '7d' ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  s += `<text x="${pl}" y="${h - 4}">${fmt(from)}</text><text x="${w - pr}" y="${h - 4}" text-anchor="end">${fmt(to)}</text>`;
  return { w, x, y, svg: `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="display:block;max-width:100%">${s}</svg>` };
}
const S = (k) => ser[k] || [];
const safeBand = () => ({ from: lim().cold, to: lim().hot, color: 'color-mix(in srgb,var(--ok) 9%,transparent)' });
function tempChart(el, h) {
  const lines = [];
  if (!hzMode()) lines.push({ pts: S('TempDesired'), color: 'var(--target)', dash: 1, width: 2 });
  lines.push({ pts: S('TempCurrent'), color: 'var(--temp)' });
  return lineChart({ w: 500, h, el, lines, bands: [safeBand()] });
}
const rangeSeg = () => `<div class="seg">${Object.keys(RANGE_MS).map((r) => `<button data-r="${r}" class="${range === r ? 'on' : ''}">${{ '1h': '1h', '4h': '4h', '1d': 'Day', '7d': 'Week' }[r]}</button>`).join('')}</div>`;

async function loadHistory() {
  if (cfg.mode === 'direct') {
    const from = Date.now() - RANGE_MS[range]; span = [from, Date.now()];
    ser = Object.fromEntries(Object.entries(D.localHist || {}).map(([k, h]) => [k, h.filter((p) => p[0] >= from)]));
  } else {
    try { const h = await fetch(`${API}/history?range=${range}`, { credentials: 'same-origin' }).then((r) => r.json()); ser = h.series; span = [h.from, h.to]; } catch { return; }
  }
  draw();
}

/* ---------------- layouts ---------------- */
const tile = (label, inner) => `<div class="card"><div class="lbl">${label}</div><div class="val">${inner}</div></div>`;
const bind = (k, init = '--') => `<span data-b="${k}">${init}</span>`;
const pumpTile = () => `<div class="card wide"><div class="lbl">Pump &amp; fuel</div><div class="row between" style="margin-top:4px">
    <div class="val">${bind('pump')}<small>Hz actual</small></div>
    <div class="sub" style="text-align:right"><span data-b="demandline"></span>
      <span data-b="lph">--</span> L/h · used <span data-b="used">--</span> L · total <span data-b="total">--</span> L</div></div></div>`;

const VIEWS = {
  classic: {
    title: 'Classic',
    html: () => `<div class="two"><div class="stack">
      <section class="card hero"><div class="lbl">Cabin temperature</div>
        <div class="big"><span data-b="cabin">--</span><small>°C</small></div>
        <div class="sub"><span data-b="targetline"></span> · <span class="chip" data-b="run">—</span></div>
        <div data-b="banners"></div></section>
      <div class="tiles">
        ${tile('Battery', `${bind('batt')}<small>V</small>`)}${tile('Heater body', `${bind('body')}<small>°C</small>`)}${tile('Fan', `${bind('fan')}<small>rpm</small>`)}
        ${tile('Humidity', `${bind('hum')}<small>%</small>`)}${tile('Error', `<span data-b="err" style="font-size:.95rem">--</span>`)}${tile('Mode', `<span data-b="tmode" style="font-size:.95rem">--</span>`)}
        ${pumpTile()}</div>
    </div><div class="stack">
      <section class="card"><div class="row between"><div class="lbl">History</div>${rangeSeg()}</div><div data-b="chart" style="margin-top:8px"></div>
        <div class="legend"><span style="--c:var(--temp)">Cabin</span><span style="--c:var(--target)" data-b="legtarget">Target</span></div></section>
      <div data-slot="controls"></div>
    </div></div><div data-slot="alarms" style="margin-top:12px"></div>`,
    upd() { },
    draw() { const el = $('[data-b=chart]'); el.innerHTML = tempChart(el, 230).svg; },
  },

  gauge: {
    title: 'Gauge',
    html: () => `<div class="two"><div class="stack">
      <section class="card" style="padding-bottom:18px"><div class="gaugebox"><div data-b="gauge"></div>
        <div class="mid"><div class="big"><span data-b="cabin">--</span><small>°C</small></div>
          <div class="sub" data-b="gaugesub"></div><div style="margin-top:8px"><span class="chip" data-b="run">—</span></div></div></div>
        <div data-b="banners"></div></section>
      <div data-slot="controls"></div>
    </div><div class="stack">
      <div class="tiles">${tile('Battery', `${bind('batt')}<small>V</small>`)}${tile('Pump', `${bind('pump')}<small>Hz</small>`)}${tile('Humidity', `${bind('hum')}<small>%</small>`)}</div>
      <section class="card"><div class="row between"><div class="lbl">History</div>${rangeSeg()}</div><div data-b="chart" style="margin-top:6px"></div></section>
    </div></div><div data-slot="alarms" style="margin-top:12px"></div>`,
    upd() {
      const R = 112, cx = 150, cy = 150, a0 = -210, a1 = 30, lo = 8, hi = 35, P = (a, r = R) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
      const ang = (v) => a0 + ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (a1 - a0);
      const arc = (from, to, r = R) => { const [x1, y1] = P(ang(from), r), [x2, y2] = P(ang(to), r); return `M${x1} ${y1} A${r} ${r} 0 ${Math.abs(ang(to) - ang(from)) > 180 ? 1 : 0} 1 ${x2} ${y2}`; };
      const cab = isNum(vals.TempCurrent) ? vals.TempCurrent : lo;
      let ticks = '';
      for (let v = 10; v <= 35; v += 5) { const [x, y] = P(ang(v), R + 22); ticks += `<text x="${x}" y="${y + 3}" text-anchor="middle">${v}°</text>`; }
      let marker = '';
      if (!hzMode() && isNum(vals.TempDesired)) { const [tx, ty] = P(ang(vals.TempDesired)); marker = `<circle cx="${tx}" cy="${ty}" r="9" fill="var(--target)" stroke="var(--card)" stroke-width="3"/>`; }
      $('[data-b=gauge]').innerHTML = `<svg viewBox="0 0 300 240" width="100%"><path d="${arc(lo, hi)}" fill="none" stroke="var(--line)" stroke-width="18" stroke-linecap="round"/>
        <path d="${arc(lim().cold, lim().hot)}" fill="none" stroke="color-mix(in srgb,var(--ok) 28%,transparent)" stroke-width="18"/>
        <path d="${arc(lo, Math.max(lo + 0.1, cab))}" fill="none" stroke="${accent()}" stroke-width="18" stroke-linecap="round"/>${marker}${ticks}</svg>`;
      $('[data-b=gaugesub]').innerHTML = hzMode() ? `Fixed Hz · demand <b>${f1(demandHz())}</b> · pump <b>${f1(vals.PumpActual)}</b> Hz` : `target <b style="color:var(--target)">${f1(vals.TempDesired)}°</b>`;
    },
    draw() { const el = $('[data-b=chart]'); el.innerHTML = tempChart(el, 170).svg; },
  },

  dog: {
    title: 'Dog',
    html: () => `<div class="two"><div class="stack">
      <section class="status" data-b="status"></section>
      <div class="row"><button class="btn" data-a="silence" style="flex:1" id="silbtn">Silence alarms 1 h</button><button class="btn" data-a="arm" style="flex:1" id="armbtn2">Arm dog mode</button></div>
      <section class="card"><div class="row between"><div class="lbl">Cabin · history</div>${rangeSeg()}</div><div data-b="chart" style="margin-top:6px"></div>
        <div class="legend"><span style="--c:var(--temp)">Cabin</span><span style="--c:var(--target)" data-b="legtarget">Target</span></div>
        <div class="sub" style="margin-top:6px">Green band = safe range (<span data-b="lims"></span>)</div></section>
    </div><div class="stack">
      <details class="card fold" id="ctlfold"><summary>Controls <small>(setpoint, mode, start / stop)</small></summary><div data-slot="controls"></div></details>
      <section class="card"><div class="lbl">Heater</div><div style="margin:4px 0"><b data-b="hsum"></b></div>
        <div class="kv"><div><span>Battery</span><b>${bind('batt')} V</b></div><div><span>Body</span><b>${bind('body')} °C</b></div><div><span>Fan</span><b>${bind('fan')} rpm</b></div>
          <div><span>Pump</span><b>${bind('pump')} Hz</b></div><div><span>Humidity</span><b>${bind('hum')} %</b></div><div><span>Error</span><b data-b="err">--</b></div></div></section>
    </div></div><div data-slot="alarms" style="margin-top:12px"></div>`,
    upd() {
      const L = lim(), b = banners(), cab = vals.TempCurrent;
      const near = isNum(cab) && (cab > L.hot - 2 || cab < L.cold + 2);
      const lv = b.length ? 'alarm' : near ? 'warn' : 'ok';
      const head = b.length ? b[0].text.split(':')[0].toUpperCase() + (b.length > 1 ? ` +${b.length - 1}` : '') : near ? 'Getting close' : 'All OK';
      const st = $('[data-b=status]');
      st.className = 'status ' + (lv === 'ok' ? '' : lv);
      const span2 = L.hot - L.cold + 12, w = (6 / span2) * 100;
      const pos = isNum(cab) ? Math.min(100, Math.max(0, ((cab - (L.cold - 6)) / span2) * 100)) : 50;
      st.innerHTML = `<div class="row between"><span class="lbl">Dog mode</span><span class="pill ${L.armed ? 'on' : ''}">${L.armed ? 'ARMED' : 'Disarmed'}</span></div>
        <h2>${head}</h2><div class="sub">${b.length ? b.map((x) => x.text).join(' · ') : `Cabin ${f1(cab)}°C · ${online === false ? 'heater data LOST' : 'heater online'} · battery ${f1(vals.InputVoltage)} V`}</div>
        <div class="rangebar"><div class="track" style="background:linear-gradient(90deg,var(--bad) 0 ${w * 0.6}%,var(--warn) ${w * 0.6}% ${w}%,var(--ok) ${w}% ${100 - w}%,var(--warn) ${100 - w}% ${100 - w * 0.6}%,var(--bad) ${100 - w * 0.6}%)"></div><div class="mark" style="left:${pos}%"></div></div>
        <div class="rangelab"><span>${L.cold}° cold alarm</span><b style="color:var(--text)">${f1(cab)}°</b><span>${L.hot}° hot alarm</span></div>`;
      $('[data-b=hsum]').innerHTML = `${runLabel()} · ${hzMode() ? `fixed Hz: demand ${f1(demandHz())} / pump ${f1(vals.PumpActual)} Hz` : `target ${f1(vals.TempDesired)}°`}`;
      $('[data-b=lims]').textContent = `${L.cold}–${L.hot}°C`;
      $('#armbtn2').textContent = L.armed ? 'Disarm' : 'Arm dog mode';
      $('#silbtn').textContent = D.alarms?.config?.snoozeUntil > Date.now() ? 'Silenced (tap to undo)' : 'Silence alarms 1 h';
    },
    draw() { const el = $('[data-b=chart]'); el.innerHTML = tempChart(el, 200).svg; },
  },

  history: {
    title: 'History',
    html: () => `<div class="stack">
      <div class="row between" style="align-items:flex-end"><div><div class="lbl">Cabin now</div><div class="val" style="font-size:2.6rem"><span data-b="cabin">--</span><small>°C</small></div></div>
        <div style="text-align:right" class="sub"><span data-b="targetline"></span><br><span class="chip" data-b="run">—</span></div></div>
      <div data-b="banners"></div>
      <div class="row between">${rangeSeg()}<div class="seg">${[['temp', 'Temperature'], ['pump', 'Pump'], ['batt', 'Battery'], ['body', 'Body']].map(([k, l]) => `<button data-m="${k}" class="${metric === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <section class="card" style="padding:10px"><div class="chartwrap" id="cw"><div data-b="chart"></div><div class="tip" id="tip"></div></div>
        <div class="legend" data-b="histlegend"></div></section>
      <div class="stat" data-b="stats"></div>
      <div class="two"><div data-slot="controls"></div><div data-slot="alarms"></div></div></div>`,
    upd() { },
    draw() {
      const el = $('[data-b=chart]'); let lines, bands = [], unit = '°', dec = 0, leg = '';
      if (metric === 'temp') {
        lines = []; if (!hzMode()) lines.push({ pts: S('TempDesired'), color: 'var(--target)', dash: 1, width: 2 });
        lines.push({ pts: S('TempCurrent'), color: 'var(--temp)' }); bands = [safeBand()];
        leg = `<span style="--c:var(--temp)">Cabin</span>${hzMode() ? '' : '<span style="--c:var(--target)">Target</span>'}`;
      } else if (metric === 'pump') {
        lines = [{ pts: S('PumpFixed'), color: 'var(--target)', dash: 1, width: 2 }, { pts: S('PumpActual'), color: 'var(--ember)' }]; unit = ' Hz'; dec = 1;
        leg = '<span style="--c:var(--ember)">Pump actual</span><span style="--c:var(--target)">Demand (fixed Hz)</span>';
      } else if (metric === 'batt') {
        lines = [{ pts: S('InputVoltage'), color: 'var(--warn)' }]; unit = ' V'; dec = 1; leg = '<span style="--c:var(--warn)">Battery</span>';
      } else { lines = [{ pts: S('TempBody'), color: 'var(--ember)' }]; leg = '<span style="--c:var(--ember)">Heater body</span>'; }
      const c = lineChart({ w: 640, h: 300, el, lines, bands, pad: [36, 10, 14, 24], dec });
      el.innerHTML = c.svg; $('[data-b=histlegend]').innerHTML = leg;
      const main = lines.at(-1).pts, pts = main.map((p) => p[1]);
      $('[data-b=stats]').innerHTML = pts.length ? [['Min', Math.min(...pts)], ['Average', pts.reduce((a, b) => a + b, 0) / pts.length], ['Max', Math.max(...pts)]]
        .map(([l, v]) => `<div class="card"><div class="lbl">${l}</div><div class="val">${v.toFixed(dec || 1)}<small>${unit.trim()}</small></div></div>`).join('') : '';
      const cw = $('#cw'), tip = $('#tip');
      cw.onpointermove = (e) => {
        const r = cw.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * c.w; let best = null, bd = 1e9;
        main.forEach((p) => { const d = Math.abs(c.x(p[0]) - px); if (d < bd) { bd = d; best = p; } });
        if (!best) return;
        tip.style.display = 'block'; tip.style.left = (c.x(best[0]) / c.w) * r.width + 'px'; tip.style.top = c.y(best[1]) + 10 + 'px';
        tip.textContent = `${best[1].toFixed(dec || 1)}${unit} · ${new Date(best[0]).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
      };
      cw.onpointerleave = () => { tip.style.display = 'none'; };
    },
  },
};

/* ---------------- shell ---------------- */
const ICONS = {
  classic: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/>',
  gauge: '<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="M12 13l4-5"/><circle cx="12" cy="14" r="1.2"/>',
  dog: '<path d="M5 9l-2 3 3 1M19 9l2 3-3 1"/><path d="M7 6c1-2 3-2.5 5-2.5S16 4 17 6l1 7a6 6 0 0 1-12 0z"/><circle cx="10" cy="11" r=".8"/><circle cx="14" cy="11" r=".8"/><path d="M11 14.5h2"/>',
  history: '<path d="M3 20h18"/><path d="M4 15l4-5 4 3 5-7 3 3"/>',
};
$('#nav').innerHTML = '<div class="brand"><i>🔥</i> Van Heater</div>' + Object.entries(VIEWS).map(([k, v]) =>
  `<button data-mode="${k}"><svg viewBox="0 0 24 24">${ICONS[k]}</svg><span>${v.title}</span></button>`).join('');

function render() {
  const stash = $('#stash');
  ['controls', 'alarms'].forEach((id) => { const n = document.getElementById(id); if (n) stash.appendChild(n); });   // park before the view is replaced
  const v = VIEWS[mode] || VIEWS.classic;
  $('#view').innerHTML = v.html();
  $$('[data-slot]').forEach((s) => { const n = document.getElementById(s.dataset.slot); if (n) s.appendChild(n); });
  const fold = $('#ctlfold');                                       // Dog view: controls are collapsible, state remembered
  if (fold) { fold.open = store.get('ctlfold', '0') === '1'; fold.ontoggle = () => store.set('ctlfold', fold.open ? '1' : '0'); }
  $('#title').innerHTML = `<span class="pre">Van Heater · </span>${v.title}`;
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  update(); draw();
}
function update() {
  document.documentElement.style.setProperty('--accent', accent());
  const set = (k, t) => $$(`[data-b="${k}"]`).forEach((e) => { e.textContent = t; });
  const L = lim(), armedPill = $('#armpill');
  armedPill.hidden = !D.alarms; armedPill.textContent = L.armed ? 'ARMED' : 'Disarmed'; armedPill.className = 'pill ' + (L.armed ? 'on' : '');
  set('cabin', f1(vals.TempCurrent)); set('run', runLabel()); set('batt', f1(vals.InputVoltage)); set('body', f0(vals.TempBody)); set('fan', f0(vals.FanRPM));
  set('hum', f0(vals.Humidity)); set('err', vals.ErrorString ?? '--'); set('pump', f1(vals.PumpActual));
  set('lph', isNum(vals.FuelRate) ? (vals.FuelRate / 1000).toFixed(3) : '--'); set('used', litres(vals.FuelUsage)); set('total', litres(vals.TotalFuelUsage));
  set('tmode', hzMode() ? 'Fixed Hz' : (vals.ThermostatMode ?? '—'));
  $$('[data-b="targetline"]').forEach((e) => { e.innerHTML = targetLine(); });
  $$('[data-b="legtarget"]').forEach((e) => { e.hidden = hzMode(); });
  $$('[data-b="demandline"]').forEach((e) => {
    const diff = hzMode() && isNum(demandHz()) && isNum(vals.PumpActual) && Math.abs(demandHz() - vals.PumpActual) >= 0.2;
    e.innerHTML = hzMode() ? `demand <b>${f1(demandHz())}</b> Hz${diff ? ' (pump differs)' : ''} · ` : '';
  });
  $$('[data-b="banners"]').forEach((e) => { e.innerHTML = bannerHTML(); });
  document.body.classList.toggle('stale', !!lastMsg && Date.now() - lastMsg > 120000);
  $('#foot').textContent = lastMsg ? 'Updated ' + new Date(lastMsg).toLocaleTimeString() : '';
  (VIEWS[mode] || VIEWS.classic).upd();
  window.dispatchEvent(new Event('dh-render'));
}
const draw = () => (VIEWS[mode] || VIEWS.classic).draw?.();
let pend = 0; const schedule = () => { if (!pend) pend = setTimeout(() => { pend = 0; update(); }, 250); };
const conn = (ok, t) => { const c = $('#conn'); c.textContent = t; c.className = 'pill ' + (ok ? 'ok' : 'bad'); };

/* ---------------- actions ---------------- */
async function post(path, method, body) {
  const r = await fetch(API + path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 ? 'Log in first (Alarms card)' : (j.error || r.statusText));
  return j;
}
document.addEventListener('click', async (e) => {
  const n = e.target.closest('[data-mode]');
  if (n) { mode = n.dataset.mode; store.set('mode', mode); render(); scrollTo({ top: 0 }); return; }
  const r = e.target.closest('[data-r]'); if (r) { range = r.dataset.r; store.set('range', range); $$('[data-r]').forEach((b) => b.classList.toggle('on', b.dataset.r === range)); loadHistory(); return; }
  const m = e.target.closest('[data-m]'); if (m) { metric = m.dataset.m; $$('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === metric)); draw(); return; }
  const a = e.target.closest('[data-a]');
  if (a) {
    try {
      if (a.dataset.a === 'arm') { D.alarms = await post('/alarms', 'PUT', { armed: !lim().armed }); update(); }
      if (a.dataset.a === 'silence') { const on = D.alarms?.config?.snoozeUntil > Date.now(); D.alarms = await post('/alarms/snooze', 'POST', { minutes: on ? 0 : 60 }); update(); toast(on ? 'Silence cancelled' : 'Repeats silenced for 1 h'); }
    } catch (err) { toast(err.message); }
  }
});
window.addEventListener('dh-alarms', () => { if (pollMs > 0 && D.alarms) active = D.alarms.active || []; update(); });
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(draw, 150); });

/* ---------------- data sources ---------------- */
/* Update interval: "Live" keeps one open stream (instant updates). Any other value polls /api/state every N ms instead,
   which is gentler on batteries and e-ink panels. Updates also pause while the page is hidden. Alarms are unaffected:
   they are evaluated on the server and pushed to your phone regardless of what this page does. */
let es = null, pollTimer = null, gen = 0;
const replaceVals = (v) => { Object.keys(vals).forEach((k) => delete vals[k]); Object.assign(vals, v); };
function stopData() { gen++; if (es) { es.close(); es = null; } clearTimeout(pollTimer); pollTimer = null; }
function openStream() {
  es = new EventSource(API + '/stream');
  es.onopen = () => conn(true, 'live');
  es.onerror = () => conn(false, 'reconnecting…');
  es.addEventListener('snapshot', (e) => { const s = JSON.parse(e.data); replaceVals(s.values); online = s.online; lastMsg = s.lastMsg; active = s.active || []; update(); });
  es.addEventListener('value', (e) => { const d = JSON.parse(e.data); vals[d.k] = d.v; lastMsg = Date.now(); schedule(); });
  es.addEventListener('status', (e) => { online = JSON.parse(e.data).online; schedule(); });
  es.addEventListener('alarms', (e) => { active = JSON.parse(e.data).active || []; schedule(); });
}
async function pollOnce() {
  try {
    const s = await fetch(API + '/state', { credentials: 'same-origin', cache: 'no-store' }).then((r) => r.json());
    replaceVals(s.values); online = s.online; lastMsg = s.lastMsg;
    if (D.alarms) active = D.alarms.active || [];
    conn(true, pollMs >= 60000 ? `every ${pollMs / 60000} min` : `every ${pollMs / 1000} s`); update();
  } catch { conn(false, 'offline?'); }
}
function pollLoop(my) { pollOnce().finally(() => { if (my === gen) pollTimer = setTimeout(() => pollLoop(my), pollMs); }); }
function startServer() {
  stopData();
  if (document.hidden) return;                       // resumes on visibilitychange
  if (pollMs === 0) openStream(); else pollLoop(gen);
}

async function startDirect() {
  await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  const p = cfg.prefix; D.localHist = {};
  const c = window.mqtt.connect(cfg.wss, { clientId: 'dh-web-' + Math.random().toString(16).slice(2, 8), reconnectPeriod: 5000 });
  c.on('connect', () => { conn(true, 'live'); c.subscribe([`${p}/sts/#`, `${p}/JSONout`, `${p}/status`]); });
  c.on('close', () => conn(false, 'reconnecting…'));
  c.on('message', (topic, payload) => {
    const text = payload.toString(); lastMsg = Date.now();
    if (topic === `${p}/status`) online = text.trim() === 'online';
    else if (topic === `${p}/JSONout`) { try { Object.entries(JSON.parse(text)).forEach(([k, v]) => { if (typeof v === 'number' || typeof v === 'string') vals[k] = v; }); } catch {} }
    else { const n = Number(text); vals[topic.slice(p.length + 5)] = text !== '' && Number.isFinite(n) ? n : text; }
    for (const k of ['TempCurrent', 'TempDesired', 'TempBody', 'InputVoltage', 'PumpActual', 'PumpFixed']) {
      const h = (D.localHist[k] ??= []), last = h[h.length - 1];
      if (isNum(vals[k]) && (!last || lastMsg - last[0] > 30000)) { h.push([lastMsg, vals[k]]); if (h.length > 10080) h.shift(); }
    }
    schedule();
  });
}

render();
const every = (fn, minMs) => { (function tick() { setTimeout(() => { if (!document.hidden) fn(); tick(); }, Math.max(minMs, pollMs)); })(); };
every(update, 15000); every(loadHistory, 60000); loadHistory();
if (cfg.mode === 'direct') { startDirect(); $('#poll').hidden = true; } else startServer();
document.addEventListener('visibilitychange', () => { if (cfg.mode === 'direct') return; if (document.hidden) stopData(); else { startServer(); loadHistory(); } });
