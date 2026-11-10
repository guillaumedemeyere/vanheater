// Heater controls (login required). Commands go through the portal server, never directly to MQTT.
// Safety: Start/Stop, Stop-Start thermostat mode and Cyclic mode can stop or restart the heater, so each asks for confirmation.
const $ = (id) => document.getElementById(id);
const api = async (path, method = 'GET', body) => {
  const r = await fetch('/api' + path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const cfgFile = await fetch('/config.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ mode: 'server' }));

if (cfgFile.mode === 'server') {
  const vals = () => window.__dh?.vals || {};
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const hz = () => vals().Thermostat === 0;
  let sp = null, spTimer = null, pendingSince = 0;

  const calcHz = (d) => {
    const v = vals(), pMin = v.PumpMinActual, pMax = v.PumpMaxActual, tMin = v.TempMin, tMax = v.TempMax;
    if (![d, pMin, pMax, tMin, tMax].every(isNum) || tMax === tMin) return null;
    return +(pMin + ((d - tMin) / (tMax - tMin)) * (pMax - pMin) - 0.0499995).toFixed(1);
  };
  const demandNow = () => (isNum(vals().PumpFixed) ? vals().PumpFixed : calcHz(vals().TempDesired));

  const confirmDlg = (text, okLabel) => new Promise((res) => {
    const d = $('dlg'); $('dlgtext').textContent = text; $('dlgok').textContent = okLabel;
    d.onclose = () => res(d.returnValue === 'yes'); d.returnValue = 'no'; d.showModal();
  });
  async function cmd(name, body) {
    $('cmdmsg').textContent = 'Sending…';
    try {
      const r = await api('/cmd/' + name, 'POST', body || {});
      $('cmdmsg').textContent = r.dryRun ? 'Dry run: validated, not sent' : 'Sent. Waiting for the heater…';
      return r;
    } catch (e) { $('cmdmsg').textContent = e.message; throw e; }
  }
  const state = () => vals().RunString ?? 'unknown';

  $('startbtn').onclick = async () => {
    const t = `Heater state: ${state()}.\n\nStart the heater?` + (/run|start|heat/i.test(state()) ? ' It already looks like it is running or starting.' : '');
    if (await confirmDlg(t, 'Yes, start')) cmd('start').catch(() => {});
  };
  $('stopbtn').onclick = async () => {
    const armed = await api('/alarms').then((a) => a.config.armed).catch(() => false);
    const t = `Heater state: ${state()}.\n\nStop the heater?` + (armed ? ' Dog mode is armed: the cabin will cool and the cold alarm may trigger.' : '');
    if (await confirmDlg(t, 'Yes, stop')) cmd('stop').catch(() => {});
  };
  $('fuelreset').onclick = async () => {
    const used = isNum(vals().FuelUsage) ? (vals().FuelUsage / 1000).toFixed(2) + ' L' : 'the';
    if (await confirmDlg(`Reset the "Used" fuel counter (${used})? The lifetime total is NOT changed.`, 'Reset Used')) cmd('reset-fuel-used').catch(() => {});
  };

  /* ---- setpoint: °C in thermostat modes, pump demand (shown as Hz) in fixed-Hz mode ---- */
  function bump(dir) {
    const v = vals(), cur = sp ?? v.TempDesired; if (!isNum(cur)) return;
    let next;
    if (hz()) {                                   // step the demand until the displayed Hz really changes (stock "cleanHzStep")
      const lo = v.TempMin ?? 8, hi = v.TempMax ?? 35, before = calcHz(cur);
      next = cur + dir;
      if (calcHz(next) === before) next += dir;
      next = Math.min(hi, Math.max(lo, Math.round(next)));
    } else {
      const lo = v.ThermMin ?? 8, hi = v.ThermMax ?? 35;
      next = Math.min(hi, Math.max(lo, cur + dir));
    }
    if (next === cur) return;
    sp = next; pendingSince = Date.now(); paint();
    clearTimeout(spTimer);
    spTimer = setTimeout(() => cmd('setpoint', { value: sp }).catch(() => { sp = null; paint(); }), 700);   // batch rapid taps
  }
  $('spdn').onclick = () => bump(-1); $('spup').onclick = () => bump(1);

  const MODES = [['fixedhz', 'Fixed Hz'], ['standard', 'Standard'], ['deadband', 'Deadband'], ['linearhz', 'Linear Hz'], ['stopstart', 'Stop / Start']];
  const currentMode = () => {
    const v = vals(); if (v.Thermostat === 0) return 'fixedhz';
    return ({ 0: 'standard', 1: 'deadband', 2: 'linearhz', 4: 'stopstart' })[v.ThermostatMethod] ?? null;
  };
  const MODE_TEXT = {
    fixedhz: 'Fixed Hz: the heater holds a constant pump rate and ignores the cabin temperature. The target becomes a pump demand shown in Hz.',
    standard: 'Standard thermostat: changes how the heater regulates the cabin temperature.',
    deadband: 'Deadband thermostat: changes how the heater regulates the cabin temperature.',
    linearhz: 'Linear Hz thermostat: the pump rate follows the gap to the target temperature.',
    stopstart: 'STOP / START thermostat: the heater will STOP and START itself by temperature. Restarts can produce smoke.',
  };
  $('modes').innerHTML = MODES.map(([k, l]) => `<button type="button" class="btn" data-tm="${k}">${l}</button>`).join('');
  $('modes').onclick = async (e) => {
    const b = e.target.closest('[data-tm]'); if (!b || b.dataset.tm === currentMode()) return;
    const label = MODES.find(([k]) => k === b.dataset.tm)[1];
    if (await confirmDlg(`Switch thermostat mode to ${label}?\n\n${MODE_TEXT[b.dataset.tm]}`, `Switch to ${label}`)) cmd('thermostat-mode', { mode: b.dataset.tm }).catch(() => {});
  };

  /* ---- cyclic mode ---- */
  const cyclicOn = () => { const v = vals(); return v.CyclicEnb === 1 || (v.CyclicEnb === undefined && isNum(v.CyclicOff) && v.CyclicOff > 1); };
  $('cyclicbtn').onclick = async () => {
    const enable = !cyclicOn();
    const t = enable ? 'ENABLE cyclic mode?\n\nThe heater will STOP and START itself by temperature. Restarts can produce smoke.' : 'Disable cyclic mode?\n\nThe heater will stop cycling by temperature.';
    if (await confirmDlg(t, enable ? 'Yes, enable' : 'Yes, disable')) cmd('cyclic', { enabled: enable }).catch(() => {});
  };

  function paint() {
    const v = vals(), h = hz();
    if (sp !== null && v.TempDesired === sp) sp = null;                         // heater confirmed
    if (sp !== null && Date.now() - pendingSince > 20000) { sp = null; $('spmsg').textContent = 'No confirmation from heater'; }
    const shown = sp ?? v.TempDesired;
    if (h) {
      const d = sp !== null ? calcHz(sp) : demandNow();
      $('spv').textContent = d ?? '--'; $('spu').textContent = 'Hz demand';
      const diff = isNum(d) && isNum(v.PumpActual) && Math.abs(d - v.PumpActual) >= 0.2;
      if (sp === null) $('spmsg').textContent = `pump now ${isNum(v.PumpActual) ? v.PumpActual.toFixed(1) : '--'} Hz${diff ? ' (differs from demand)' : ''}`;
    } else {
      $('spv').textContent = isNum(shown) ? shown : '--'; $('spu').textContent = '°C target';
      if (sp === null && /^(pump now|sending)/.test($('spmsg').textContent)) $('spmsg').textContent = '';
    }
    if (sp !== null) $('spmsg').textContent = 'sending…';
    const cm = currentMode();
    $('modes').querySelectorAll('[data-tm]').forEach((b) => b.classList.toggle('primary', b.dataset.tm === cm));
    const on = cyclicOn();
    $('cyclicbtn').textContent = on ? 'Cyclic mode: ON (tap to disable)' : 'Cyclic mode: off (tap to enable)';
    $('cyclicbtn').classList.toggle('primary', on);
  }
  window.addEventListener('dh-render', paint);

  async function refresh() {
    try {
      const a = await api('/auth'); $('controls').hidden = !a.authed;
      if (a.authed) { const c = await api('/cmd'); $('dryrun').hidden = c.enabled; }
    } catch {}
  }
  refresh(); (function tick() { setTimeout(() => { if (!document.hidden) refresh(); tick(); }, Math.max(10000, window.__dh.pollMs || 0)); })();
  document.addEventListener('click', (e) => { if (e.target.id === 'loginbtn' || e.target.id === 'authbtn') setTimeout(refresh, 800); });
}
