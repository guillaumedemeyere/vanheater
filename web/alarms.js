// Alarm card: arm/disarm, thresholds, push enrolment, login. Server mode only.
const $ = (id) => document.getElementById(id);
const api = async (path, method = 'GET', body) => {
  const r = await fetch('/api' + path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status });
  return j;
};

const cfgFile = await fetch('/config.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ mode: 'server' }));
if (cfgFile.mode === 'server') {
  $('alarms').hidden = false;
  let authed = false, configured = true, view = null, dirty = false;

  const FIELDS = [
    ['tempHigh', 'Too hot', 'Alarm above', '°C', true], ['tempLow', 'Too cold', 'Alarm below', '°C', true],
    ['stale', 'No data from heater', '', '', false], ['offline', 'Heater offline', '', '', false],
    ['error', 'Heater error', 'Always on, even when disarmed', '', false], ['battery', 'Low battery', 'Always on. Alarm below', 'V', true],
  ];
  function buildForm(c) {
    const f = $('form'); f.innerHTML = '';
    for (const [k, name, note, unit, hasVal] of FIELDS) {
      const r = c.rules[k];
      const row = document.createElement('div'); row.className = 'frow';
      row.innerHTML = `<label class="nm"><input type="checkbox" data-k="${k}" data-f="enabled"> ${name}${note ? `<small>${note}${hasVal ? ' ' : ''}</small>` : ''}</label>` +
        (hasVal ? `<span><input type="number" step="0.1" data-k="${k}" data-f="value"> ${unit}</span>` : '<span></span>') +
        `<span title="Must persist this long before alarming"><input type="number" step="1" min="0" data-k="${k}" data-f="delayMin"> min</span>`;
      f.appendChild(row);
      row.querySelector('[data-f=enabled]').checked = r.enabled;
      if (hasVal) row.querySelector('[data-f=value]').value = r.value;
      row.querySelector('[data-f=delayMin]').value = r.delayMin;
    }
    const g = document.createElement('div'); g.className = 'frow';
    g.innerHTML = `<span class="nm">Repeat every<small>while an alarm stays active</small></span><span><input type="number" id="renotify" min="1"> min</span><span></span>`;
    f.appendChild(g); g.querySelector('input').value = c.renotifyMin;
    f.querySelectorAll('input').forEach((i) => i.oninput = i.onchange = () => { dirty = true; });
    lockForm();
  }
  function lockForm() {
    $('form').querySelectorAll('input').forEach((i) => i.disabled = !authed);
    $('savebtn').hidden = !authed;
    $('testbtn').hidden = !authed;
    $('armbtn').disabled = !authed;
    if (authed) $('loginbox').hidden = true;
    $('authbtn').textContent = authed ? 'Log out' : 'Log in to change settings';
    $('authbtn').hidden = !authed && !configured;
    if (!configured) $('loginmsg').textContent = '';
  }

  function render() {
    if (!view) return;
    const c = view.config;
    $('armstate').textContent = c.armed ? 'ARMED' : 'Disarmed';
    $('armstate').className = 'pill ' + (c.armed ? 'on' : '');
    $('armbtn').textContent = c.armed ? 'Disarm' : 'Arm dog mode';
    $('activelist').innerHTML = view.active.map((a) => `<div class="act">${a.title}: ${a.msg}</div>`).join('');
    $('alertlog').innerHTML = view.log.map((l) => `<li>${new Date(l.ts).toLocaleString()} · <b>${l.kind}</b> ${l.msg}</li>`).join('') || '<li>Nothing yet</li>';
    $('pushmsg').textContent = `${view.push.subscribers} device(s) subscribed` + (view.push.ntfy ? ' · ntfy backup on' : '');
    if (!dirty) buildForm(c);
    window.__dh.alarms = view; window.dispatchEvent(new Event('dh-alarms'));
  }

  async function refresh() {
    try {
      view = await api('/alarms');
      const a = await api('/auth'); authed = a.authed; configured = a.configured;
      lockForm(); render();
    } catch {}
  }

  $('armbtn').onclick = async () => { try { view = await api('/alarms', 'PUT', { armed: !view.config.armed }); dirty = false; render(); } catch (e) { $('savemsg').textContent = e.message; } };
  $('savebtn').onclick = async () => {
    const patch = { rules: {}, renotifyMin: Number($('renotify').value) };
    $('form').querySelectorAll('[data-k]').forEach((i) => {
      const r = (patch.rules[i.dataset.k] ??= {});
      r[i.dataset.f] = i.type === 'checkbox' ? i.checked : Number(i.value);
    });
    try { view = await api('/alarms', 'PUT', patch); dirty = false; $('savemsg').textContent = 'Saved'; render(); }
    catch (e) { $('savemsg').textContent = e.message; }
  };
  $('testbtn').onclick = async () => { try { const r = await api('/alarms/test', 'POST', {}); $('pushmsg').textContent = `Test sent to ${r.sent} device(s)` + (r.failed ? `, ${r.failed} failed` : ''); } catch (e) { $('pushmsg').textContent = e.message; } };
  $('authbtn').onclick = async () => {
    if (authed) { await api('/logout', 'POST', {}); authed = false; lockForm(); }
    else { $('loginbox').hidden = false; $('pw').focus(); }
  };
  $('loginbtn').onclick = async () => {
    try { await api('/login', 'POST', { password: $('pw').value }); $('pw').value = ''; $('loginbox').hidden = true; $('loginmsg').textContent = ''; await refresh(); }
    catch (e) { $('loginmsg').textContent = e.message; }
  };
  $('pw').onkeydown = (e) => { if (e.key === 'Enter') $('loginbtn').click(); };
  if (!configured) $('loginmsg').textContent = 'No admin password set on the server yet.';

  // ---- push enrolment
  const b64 = (s) => { const p = '='.repeat((4 - s.length % 4) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map((c) => c.charCodeAt(0))); };
  $('pushbtn').onclick = async () => {
    const m = $('pushmsg');
    try {
      if (!window.isSecureContext) throw new Error('Notifications need HTTPS (or localhost)');
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser does not support push');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Permission denied. Allow notifications for this site in the browser settings.');
      const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
      const { key } = await api('/push/key');
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
      await api('/push/subscribe', 'POST', sub.toJSON());
      m.textContent = 'Notifications enabled on this device'; localStorage.setItem('pushOn', '1'); refresh();
    } catch (e) {
      m.textContent = e.name === 'AbortError' || /push service/i.test(e.message)
        ? 'The browser push service is unavailable. In Brave: brave://settings/privacy -> enable "Use Google Services for Push Messaging", then restart Brave and try again.'
        : e.message;
    }
  };
  // re-register the worker silently on later visits so it stays current
  try { if (localStorage.getItem('pushOn') && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js'); } catch {}

  refresh(); (function tick() { setTimeout(function () { if (!document.hidden) refresh(); tick(); }, Math.max(10000, window.__dh.pollMs || 0)); })();
}
