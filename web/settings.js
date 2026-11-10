const $ = (id) => document.getElementById(id);
const api = async (path, method = 'GET', body) => {
  const r = await fetch('/api' + path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status });
  return j;
};
const theme = (() => { try { return localStorage.getItem('theme'); } catch { return null; } })();
document.documentElement.dataset.theme = ({ amoled: 'dark', eink: 'light', einkc: 'light' })[theme] || theme || 'auto';   // this page only has the basic palettes

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const onoff = (v) => (v ? 'on' : 'off');
const GROUPS = {
  'g-hmqtt': [['MEn', 'MQTT enabled', onoff], ['MOnline', 'Connected to broker', (v) => (v ? 'yes' : 'no')], ['MHost', 'Broker host'], ['MPort', 'Broker port'], ['MTopic', 'Topic prefix'], ['MQoS', 'QoS'], ['MUser', 'Username', (v) => v || '(none)']],
  'g-net': [['IP_STASSID', 'WiFi network'], ['IP_STA', 'IP address'], ['IP_STARSSI', 'Signal', (v) => v + ' dBm'], ['SysVer', 'Firmware']],
  'g-therm': [['Thermostat', 'Thermostat', onoff], ['ThermostatMode', 'Mode'], ['TempDesired', 'Target', (v) => v + ' °C'], ['ThermMin', 'Minimum target', (v) => v + ' °C'], ['ThermMax', 'Maximum target', (v) => v + ' °C'],
    ['ThermStep', 'Step', (v) => v + ' °C'], ['ThermostatMethod', 'Method'], ['ThermostatWindow', 'Window', (v) => v + ' °C'], ['ThermostatOvertemp', 'Overtemp offset', (v) => v + ' °C'], ['ThermostatUndertemp', 'Undertemp offset', (v) => v + ' °C'],
    ['CyclicEnb', 'Cyclic mode', onoff], ['CyclicTemp', 'Cyclic temp', (v) => v + ' °C'], ['CyclicOn', 'Cyclic on offset', (v) => v + ' °C'], ['CyclicOff', 'Cyclic off offset', (v) => v + ' °C']],
  'g-frost': [['FrostEnable', 'Frost mode', onoff], ['FrostMode', 'Type'], ['FrostOn', 'Start below', (v) => v + ' °C'], ['FrostRise', 'Stop / rise', (v) => v + ' °C'],
    ['FrostSoak', 'Soak time', (v) => v / 60000 + ' min'], ['FrostMaxHz', 'Power limit', (v) => v + ' Hz'],
    ['FrostStart', 'Active from', hhmm], ['FrostStop', 'Active until', hhmm], ['FrostSensor', 'Sensor'], ['HumidStart', 'Humidity start']],
  'g-start': [['StartMode', 'Start mode'], ['LowVoltCutout', 'Low-voltage cutout', (v) => v + ' V'], ['LowVoltHoldoff', 'Low-voltage holdoff', (v) => v + ' s'], ['VoltCorr', 'Voltage correction', (v) => v + ' V'],
    ['MinUserPower', 'Min power', (v) => v + ' Hz'], ['MaxUserPower', 'Max power', (v) => v + ' Hz'], ['FuelWarning', 'Low-fuel warning', (v) => v + ' %'], ['FuelCapacity', 'Tank capacity'], ['AltitudeMode', 'Altitude mode']],
};
function paint(vals) {
  for (const [id, rows] of Object.entries(GROUPS)) {
    $(id).innerHTML = rows.filter(([k]) => vals[k] !== undefined).map(([k, label, f]) => `<div class="kvr"><span>${label}</span><b>${f ? f(vals[k]) : vals[k]}</b></div>`).join('') ||
      '<p class="hint">Not reported yet. Open the dashboard and ask the heater to refresh, or wait.</p>';
  }
  const p = window.__conn;
  if (p && vals.MHost) {
    const same = vals.MHost === p.host && vals.MTopic === p.prefix;
    $('mqttcheck').textContent = same ? 'Portal and heater use the same broker host and prefix.' : 'Portal and heater differ in broker host or prefix.';
  }
}
const confirmDlg = (text, ok) => new Promise((res) => { const d = $('dlg'); $('dlgtext').textContent = text; $('dlgok').textContent = ok; d.onclose = () => res(d.returnValue === 'yes'); d.returnValue = 'no'; d.showModal(); });

try {
  const a = await api('/auth');
  if (!a.authed) { $('needlogin').hidden = false; }
  else {
    $('content').hidden = false;
    const c = window.__conn = await api('/portal-mqtt');
    const f = $('pform'); f.host.value = c.host; f.port.value = c.port; f.tls.checked = c.tls; f.prefix.value = c.prefix; f.user.value = c.user;
    if (c.hasPassword) f.password.placeholder = 'unchanged (one is set)';
    const refresh = async () => paint((await api('/state')).values);
    const ask = async () => {
      $('rmsg').textContent = 'Asking the heater to resend its settings…';
      try { const r = await api('/cmd/refresh', 'POST', {}); $('rmsg').textContent = r.dryRun ? 'Dry run: not sent' : 'Requested. Values appear within a few seconds.'; setTimeout(refresh, 4000); }
      catch (e) { $('rmsg').textContent = e.message; }
    };
    $('rbtn').onclick = ask;
    await refresh(); setInterval(refresh, 10000);
    if (!(await api('/state')).values.MHost) ask();     // the heater only publishes its settings when asked (the stock page asks on every connect)
    $('psave').onclick = async () => {
      if (!f.reportValidity()) return;
      if (!await confirmDlg('Switch this website to the broker above? It is tested first and only used if heater data arrives.', 'Test & save')) return;
      $('pmsg').textContent = 'Testing connection (up to 30 s)…'; $('psave').disabled = true;
      try {
        window.__conn = await api('/portal-mqtt', 'PUT', { host: f.host.value, port: Number(f.port.value), tls: f.tls.checked, prefix: f.prefix.value, user: f.user.value, password: f.password.value });
        f.password.value = ''; $('pmsg').textContent = 'Saved. Now using the new connection.'; refresh();
      } catch (e) { $('pmsg').textContent = 'Not changed: ' + e.message; }
      $('psave').disabled = false;
    };
  }
} catch { $('needlogin').hidden = false; }
