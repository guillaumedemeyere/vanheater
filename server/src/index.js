// Diesel heater portal server.
// MQTT is READ-ONLY here (no publish calls). Writes go to our own alarm config only.
import http from 'node:http';
import crypto from 'node:crypto';
import mqtt from 'mqtt';
import { load, save } from './store.js';
import { Engine, DEFAULTS, mergeConfig } from './engine.js';
import * as push from './push.js';
import * as auth from './auth.js';
import { build as buildCommand } from './commands.js';

const {
  MQTT_HOST, MQTT_PORT = '8883', MQTT_TLS = 'true',
  MQTT_USER = '', MQTT_PASSWORD = '', MQTT_TOPIC_PREFIX, PORT = '3000', COMMANDS_ENABLED = 'false',
} = process.env;
// Portal-side broker connection: .env gives the defaults, /data/portal-mqtt.json (edited in the UI) overrides them.
// This is the connection used by THIS WEBSITE only; the heater's own MQTT settings are separate and read-only here.
let mqttConf = load('portal-mqtt.json', null) ||
  { host: MQTT_HOST, port: Number(MQTT_PORT), tls: MQTT_TLS === 'true', user: MQTT_USER, password: MQTT_PASSWORD, prefix: MQTT_TOPIC_PREFIX };
if (!mqttConf.host || !mqttConf.prefix) { console.error('MQTT host and topic prefix are required (.env or UI)'); process.exit(1); }
let prefix = mqttConf.prefix;

// Never keep secrets, and only expose the dashboard keys to visitors who are not logged in.
const SECRET = /pass|pwd|secret|token|^MPIN$|^MQTTPIN$/i;
const PUBLIC_KEYS = new Set(['TempCurrent', 'Temp1Current', 'Temp2Current', 'Temp3Current', 'Temp4Current', 'TempDesired', 'TempBody',
  'RunState', 'RunString', 'ErrorState', 'ErrorString', 'InputVoltage', 'FanRPM', 'PumpActual', 'FuelRate', 'FuelUsage',
  'TotalFuelUsage', 'Humidity', 'Pressure', 'FuelAlarm', 'ThermMin', 'ThermMax', 'Thermostat', 'ThermostatMode', 'ThermostatMethod', 'TempMin', 'TempMax', 'ThermStep',
  'PumpFixed', 'PumpMinActual', 'PumpMaxActual', 'MinUserPower', 'MaxUserPower', 'TempMode', 'FixedDemand']);

// ---- live state
const values = new Map();           // key -> { v, t }
let online = null, lastMsg = 0;
const SLOW_KEYS = ['Humidity', 'Pressure', 'Thermostat', 'ThermostatMode', 'ThermostatMethod', 'TempMin', 'TempMax', 'ThermMin', 'ThermMax', 'ThermStep', 'PumpFixed', 'PumpMinActual', 'PumpMaxActual', 'MinUserPower', 'MaxUserPower', 'TempMode'];       // only sent occasionally, in JSONout only
for (const [k, v] of Object.entries(load('slow.json', {}))) values.set(k, { v, t: 0 });
const history = load('history.json', {});
const HISTORY_KEYS = ['TempCurrent', 'TempDesired', 'TempBody', 'InputVoltage', 'PumpActual', 'PumpFixed'];
const HISTORY_MAX = 7 * 24 * 60;      // 7 days at 1 sample/min
const RANGES = { '1h': [3600e3, 60e3], '4h': [4 * 3600e3, 60e3], '1d': [864e5, 300e3], '7d': [7 * 864e5, 1800e3] }; // [window, bucket] ms
const clients = new Set();

const num = (s) => { const n = Number(s); return s !== '' && Number.isFinite(n) ? n : s; };
const valuesObj = () => Object.fromEntries([...values].map(([k, e]) => [k, e.v]));
const state = () => ({ online, lastMsg, values: valuesObj() });          // full, internal (alarm engine)
const stateFor = (authed) => ({ online, lastMsg, values: Object.fromEntries(Object.entries(valuesObj()).filter(([k]) => authed || PUBLIC_KEYS.has(k))) });

// Average samples into fixed buckets so any range returns a few hundred points.
function series(range) {
  const [win, bucket] = RANGES[range] || RANGES['4h'], from = Date.now() - win, out = {};
  for (const k of HISTORY_KEYS) {
    const acc = new Map();
    for (const [t, v] of history[k] || []) {
      if (t < from) continue;
      const b = Math.floor(t / bucket) * bucket, a = acc.get(b) || [0, 0];
      a[0] += v; a[1]++; acc.set(b, a);
    }
    out[k] = [...acc].map(([b, [sum, c]]) => [b + bucket / 2, Math.round((sum / c) * 100) / 100]);
  }
  return { range, from, to: Date.now(), series: out };
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    if (event === 'value' && !res.authed && !PUBLIC_KEYS.has(data.k)) continue;
    res.write(msg);
  }
}
function setValue(k, v) {
  if (SECRET.test(k)) return;
  const prev = values.get(k)?.v;
  values.set(k, { v, t: Date.now() });
  if (prev !== v) broadcast('value', { k, v });
}

// ---- MQTT (subscribe; publishes only from the allow-listed /api/cmd handler)
const connectOpts = (c) => ({
  clientId: `dh-portal-${crypto.randomBytes(4).toString('hex')}`,
  username: c.user || undefined, password: c.password || undefined, reconnectPeriod: 5000, clean: true,
});
const brokerUrl = (c) => `${c.tls ? 'mqtts' : 'mqtt'}://${c.host}:${c.port}`;

function onMessage(topic, payload) {
  const text = payload.toString();
  lastMsg = Date.now();
  if (topic === `${prefix}/status`) { online = text.trim() === 'online'; broadcast('status', { online }); return; }
  if (topic === `${prefix}/JSONout`) {         // delta JSON; adds keys the sts/ topics lack (Humidity, Pressure…)
    let o; try { o = JSON.parse(text); } catch { return; }
    for (const [k, v] of Object.entries(o)) {
      if ((typeof v === 'number' || typeof v === 'string') && !/^(Snap|telnet)/.test(k)) setValue(k, v);
    }
    return;
  }
  setValue(topic.slice(`${prefix}/sts/`.length), num(text));
}
function startClient(c) {
  const cl = mqtt.connect(brokerUrl(c), connectOpts(c));
  cl.on('connect', () => { console.log('mqtt connected', c.host); cl.subscribe([`${c.prefix}/sts/#`, `${c.prefix}/JSONout`, `${c.prefix}/status`], { qos: 0 });
    // Settings (thermostat mode, limits, pump range) are only published when asked. The stock page asks on every connect.
    if (COMMANDS_ENABLED === 'true') setTimeout(() => cl.connected && cl.publish(`${c.prefix}/JSONin`, JSON.stringify(buildCommand('refresh')), { qos: 0, retain: false }), 1500);
  });
  cl.on('error', (e) => console.error('mqtt error', e.message));
  cl.on('close', () => console.warn('mqtt closed'));
  cl.on('message', onMessage);
  return cl;
}
let client = startClient(mqttConf);

// Validate a new connection by actually receiving heater data on it BEFORE switching; if that fails nothing changes.
function probe(c, ms = 30_000) {
  return new Promise((resolve, reject) => {
    const cl = mqtt.connect(brokerUrl(c), { ...connectOpts(c), reconnectPeriod: 0 });
    const done = (err) => { clearTimeout(t); cl.end(true); err ? reject(err) : resolve(); };
    const t = setTimeout(() => done(new Error('No data from the heater on that broker/prefix within 30 s')), ms);
    cl.on('error', (e) => done(new Error('Connection failed: ' + e.message)));
    cl.on('connect', () => cl.subscribe([`${c.prefix}/status`, `${c.prefix}/sts/#`]));
    cl.on('message', () => done());
  });
}
function validateConn(b, cur) {
  const host = String(b.host || '').trim(), prefixIn = String(b.prefix || '').trim(), port = Number(b.port);
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new Error('invalid host');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(prefixIn)) throw new Error('topic prefix may only contain letters, digits, _ and -');
  return { host, port, tls: !!b.tls, user: String(b.user || ''), prefix: prefixIn,
    password: typeof b.password === 'string' && b.password !== '' ? b.password : cur.password };   // blank = keep current
}
const connView = (c) => ({ host: c.host, port: c.port, tls: c.tls, user: c.user, prefix: c.prefix, hasPassword: !!c.password });

// ---- alarms
let cfg = structuredClone(DEFAULTS);
{ const saved = load('alarms.json', null); if (saved) { try { cfg = mergeConfig(DEFAULTS, saved); cfg.snoozeUntil = saved.snoozeUntil || 0; } catch (e) { console.error('bad alarms.json', e.message); } } }
const alertLog = load('alertlog.json', []);
const engine = new Engine({
  getState: state, getConfig: () => cfg,
  log: (e) => { alertLog.push(e); if (alertLog.length > 200) alertLog.shift(); save('alertlog.json', alertLog); },
  notify: (n) => { push.sendAll(n).then((r) => console.log('notify', n.rule, n.kind, r)).catch((e) => console.error('notify failed', e.message)); },
});
const alarmsView = () => ({ config: cfg, active: engine.active(), log: alertLog.slice(-30).reverse(), push: { subscribers: push.subCount(), ntfy: push.ntfyEnabled() } });
setInterval(() => { if (engine.tick()) broadcast('alarms', { active: engine.active() }); }, 10_000);

// ---- history (sampled each minute, persisted every 5)
function sample() {
  const now = Date.now();
  // sts/ topics only publish on change, so a steady value is "old" but still current.
  // Judge freshness by the heater being alive (any message recently), not per-key age.
  if (!lastMsg || now - lastMsg > 10 * 60_000) return;
  for (const k of HISTORY_KEYS) {
    const e = values.get(k);
    if (!e || typeof e.v !== 'number') continue;
    const h = (history[k] ??= []); h.push([now, e.v]); if (h.length > HISTORY_MAX) h.shift();
  }
}
setInterval(sample, 60_000);
setTimeout(sample, 20_000);       // first point soon after start so the chart appears quickly
function persist() {
  save('history.json', history);
  save('slow.json', Object.fromEntries(SLOW_KEYS.filter((k) => values.has(k)).map((k) => [k, values.get(k).v])));
}
setInterval(persist, 5 * 60_000);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { persist(); process.exit(0); });

const cmdLog = load('cmdlog.json', []);
let lastCmd = 0;

// ---- HTTP
const json = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve, reject) => {
  if (!/^application\/json/.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('JSON required'), { code: 415 }));
  let b = ''; req.on('data', (d) => { b += d; if (b.length > 16384) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(Object.assign(new Error('bad JSON'), { code: 400 })); } });
});
const isSecure = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    let renewed = null;
    const authed = auth.check(req, (t) => { renewed = t; });
    const send = (code, obj) => json(res, code, obj, renewed ? { 'set-cookie': auth.cookieHeader(renewed, isSecure(req)) } : {});
    const need = () => { if (!authed) { send(401, { error: 'Login required' }); return false; } return true; };

    if (req.method === 'GET') {
      if (p === '/api/health') { res.writeHead(200).end('ok'); return; }
      if (p === '/api/state') return send(200, stateFor(authed));
      if (p === '/api/history') return send(200, series(url.searchParams.get('range')));
      if (p === '/api/auth') return send(200, { authed, configured: auth.configured() });
      if (p === '/api/alarms') return send(200, alarmsView());
      if (p === '/api/cmd') return send(200, { enabled: COMMANDS_ENABLED === 'true', recent: authed ? cmdLog.slice(-20).reverse() : [] });
      if (p === '/api/portal-mqtt') { if (!need()) return; return send(200, connView(mqttConf)); }
      if (p === '/api/push/key') return send(200, { key: push.publicKey() });
      if (p === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.authed = authed;
        res.write(`event: snapshot\ndata: ${JSON.stringify({ ...stateFor(authed), active: engine.active() })}\n\n`);
        clients.add(res);
        const hb = setInterval(() => res.write(': hb\n\n'), 25_000);
        req.on('close', () => { clearInterval(hb); clients.delete(res); });
        return;
      }
    } else if (req.method === 'POST' || req.method === 'PUT') {
      const body = await readBody(req);
      if (p === '/api/login') {
        const r = auth.login(body.password);
        if (!r.ok) return send(r.status, { error: r.error });
        return json(res, 200, { ok: true }, { 'set-cookie': auth.cookieHeader(r.token, isSecure(req)) });
      }
      if (p === '/api/logout') return json(res, 200, { ok: true }, { 'set-cookie': auth.cookieHeader('', isSecure(req), true) });
      if (p === '/api/push/subscribe') { push.addSub(body); return send(200, { ok: true }); }       // open by design
      if (p === '/api/push/unsubscribe') { push.removeSub(body.endpoint); return send(200, { ok: true }); }
      if (p === '/api/alarms' && req.method === 'PUT') {
        if (!need()) return;
        cfg = { ...mergeConfig(cfg, body), snoozeUntil: cfg.snoozeUntil };
        save('alarms.json', cfg); engine.tick(); broadcast('alarms', { active: engine.active() });
        return send(200, alarmsView());
      }
      if (p === '/api/alarms/snooze') {
        if (!need()) return;
        const m = Number(body.minutes);
        cfg.snoozeUntil = m > 0 ? Date.now() + Math.min(m, 1440) * 60_000 : 0; save('alarms.json', cfg);
        return send(200, alarmsView());
      }
      if (p.startsWith('/api/cmd/') && req.method === 'POST') {
        if (!need()) return;
        const name = p.slice('/api/cmd/'.length);
        const v = (k) => (typeof values.get(k)?.v === 'number' ? values.get(k).v : undefined);
        const msg = buildCommand(name, body, { thermostat: v('Thermostat'), tempMin: v('TempMin'), tempMax: v('TempMax'), thermMin: v('ThermMin'), thermMax: v('ThermMax'), method: v('ThermostatMethod') });
        if (Date.now() - lastCmd < 1500) return send(429, { error: 'Slow down: one command at a time' });
        lastCmd = Date.now();
        const live = COMMANDS_ENABLED === 'true' && client.connected;
        cmdLog.push({ ts: lastCmd, name, msg, sent: live }); if (cmdLog.length > 100) cmdLog.shift(); save('cmdlog.json', cmdLog);
        console.log('command', name, JSON.stringify(msg), live ? 'SENT' : 'DRY-RUN');
        if (live) await new Promise((ok, no) => client.publish(`${prefix}/JSONin`, JSON.stringify(msg), { qos: 0, retain: false }, (e) => (e ? no(e) : ok())));
        return send(200, { ok: true, sent: live, dryRun: !live, message: msg });
      }
      if (p === '/api/portal-mqtt' && req.method === 'PUT') {
        if (!need()) return;
        const next = validateConn(body, mqttConf);
        await probe(next);                                   // throws (HTTP 400) if it does not work; nothing is changed then
        const old = client;
        mqttConf = next; prefix = next.prefix; save('portal-mqtt.json', next);
        values.clear(); online = null; lastMsg = 0;
        client = startClient(next); old.end(true);
        return send(200, connView(mqttConf));
      }
      if (p === '/api/alarms/test') {
        if (!need()) return;
        const r = await push.sendAll({ title: 'Test alert', body: 'Notifications are working.', kind: 'test' });
        return send(200, r);
      }
    }
    send(404, { error: 'not found' });
  } catch (e) {
    const code = e.code && Number.isInteger(e.code) ? e.code : 400;
    if (!res.headersSent) json(res, code, { error: e.message });
  }
}).listen(Number(PORT), () => console.log(`listening on :${PORT}`));
