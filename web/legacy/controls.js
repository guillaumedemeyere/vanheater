// Heater controls (login required). All commands go through the portal server, never directly to MQTT.
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
  let sp = null, spTimer = null, pendingSince = 0;

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
    const used = typeof vals().FuelUsage === 'number' ? (vals().FuelUsage / 1000).toFixed(2) + ' L' : 'the';
    if (await confirmDlg(`Reset the "Used" fuel counter (${used})? The lifetime total is NOT changed.`, 'Reset Used')) cmd('reset-fuel-used').catch(() => {});
  };

  function bump(d) {
    const cur = sp ?? vals().TempDesired; if (typeof cur !== 'number') return;
    sp = Math.min(35, Math.max(8, cur + d)); pendingSince = Date.now(); paint();
    clearTimeout(spTimer);
    spTimer = setTimeout(() => cmd('setpoint', { value: sp }).catch(() => { sp = null; paint(); }), 700);   // batch rapid taps like the stock page
  }
  $('spdn').onclick = () => bump(-1); $('spup').onclick = () => bump(1);

  function paint() {
    const t = vals().TempDesired;
    if (sp !== null && t === sp) sp = null;                          // heater confirmed
    if (sp !== null && Date.now() - pendingSince > 20000) { sp = null; $('spmsg').textContent = 'No confirmation from heater'; }
    $('spv').textContent = (sp ?? t) ?? '--';
    if (sp !== null) $('spmsg').textContent = 'sending…'; else if ($('spmsg').textContent === 'sending…') $('spmsg').textContent = '';
  }
  window.addEventListener('dh-render', paint);

  async function refresh() {
    try {
      const a = await api('/auth'); $('controls').hidden = !a.authed;
      if (a.authed) { const c = await api('/cmd'); $('dryrun').hidden = c.enabled; }
    } catch {}
  }
  refresh(); setInterval(refresh, 10000);
  $('controls').addEventListener('click', () => setTimeout(refresh, 500));
  document.addEventListener('click', (e) => { if (e.target.id === 'loginbtn' || e.target.id === 'authbtn') setTimeout(refresh, 800); });
}
