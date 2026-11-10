// Alarm rule engine. Pure logic: no I/O, so it is unit-testable with a fake clock.
export const DEFAULTS = {
  armed: false,          // "dog mode": gates temperature / stale / offline rules
  renotifyMin: 15,       // repeat an active alarm this often
  hysteresisC: 1,        // temperature must recover this far before clearing
  snoozeUntil: 0,        // silences REPEAT notifications until this time (ms)
  rules: {
    tempHigh: { enabled: true, value: 30, delayMin: 2 },
    tempLow:  { enabled: true, value: 10, delayMin: 2 },
    stale:    { enabled: true, delayMin: 10 },   // no MQTT message at all from the heater
    offline:  { enabled: true, delayMin: 2 },    // heater reports/LWT "offline"
    error:    { enabled: true, delayMin: 0 },    // heater error code (always on)
    battery:  { enabled: true, value: 11.8, delayMin: 5 }, // always on
  },
};

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// check() -> true (breaching), false (ok), null (no data: keep current state)
export const RULES = {
  tempHigh: {
    title: 'Cabin too hot', needsArmed: true,
    check(s, c, cfg, active) {
      const t = n(s.values.TempCurrent); if (t === null) return null;
      return active ? t > c.value - cfg.hysteresisC : t > c.value;
    },
    msg: (s, c) => `Cabin is ${s.values.TempCurrent}°C (limit ${c.value}°C)`,
  },
  tempLow: {
    title: 'Cabin too cold', needsArmed: true,
    check(s, c, cfg, active) {
      const t = n(s.values.TempCurrent); if (t === null) return null;
      return active ? t < c.value + cfg.hysteresisC : t < c.value;
    },
    msg: (s, c) => `Cabin is ${s.values.TempCurrent}°C (limit ${c.value}°C)`,
  },
  stale: {
    title: 'No data from heater', needsArmed: true,
    check(s, c, cfg, active, now) {
      if (!s.lastMsg) return null;
      return now - s.lastMsg > 60_000; // breach window; delayMin applies on top
    },
    msg: (s, c, now) => `No messages from the heater for ${Math.round((now - s.lastMsg) / 60000)} min`,
  },
  offline: {
    title: 'Heater offline', needsArmed: true,
    check(s) { return s.online === null ? null : s.online === false; },
    msg: () => 'The heater reports it is offline',
  },
  error: {
    title: 'Heater error', needsArmed: false,
    check(s) {
      const e = s.values.ErrorString; if (typeof e !== 'string') return null;
      return !e.startsWith('E-00');
    },
    msg: (s) => `Heater error: ${s.values.ErrorString}`,
  },
  battery: {
    title: 'Low battery', needsArmed: false,
    check(s, c, cfg, active) {
      const v = n(s.values.InputVoltage); if (v === null) return null;
      return active ? v < c.value + 0.3 : v < c.value;
    },
    msg: (s, c) => `Battery ${s.values.InputVoltage} V (limit ${c.value} V)`,
  },
};

export class Engine {
  constructor({ getState, getConfig, notify, log }) {
    this.getState = getState; this.getConfig = getConfig; this.notify = notify; this.log = log;
    this.st = Object.fromEntries(Object.keys(RULES).map((k) => [k, { since: null, active: false, lastNotified: 0, msg: '' }]));
  }

  active() {
    return Object.entries(this.st).filter(([, s]) => s.active)
      .map(([k, s]) => ({ rule: k, title: RULES[k].title, msg: s.msg, since: s.activeSince }));
  }

  tick(now = Date.now()) {
    const s = this.getState(), cfg = this.getConfig();
    let changed = false;
    for (const [k, rule] of Object.entries(RULES)) {
      const c = cfg.rules[k], st = this.st[k];
      const gated = !c.enabled || (rule.needsArmed && !cfg.armed);
      if (gated) {
        if (st.active) { st.active = false; st.since = null; changed = true; this.log({ ts: now, rule: k, kind: 'silenced', msg: 'Rule disabled or disarmed' }); }
        st.since = null; continue;
      }
      const b = rule.check(s, c, cfg, st.active, now);
      if (b === null) continue;
      if (b) {
        if (st.since === null) st.since = now;
        const msg = rule.msg(s, c, now);
        if (!st.active && now - st.since >= (c.delayMin ?? 0) * 60_000) {
          st.active = true; st.activeSince = now; st.msg = msg; st.lastNotified = now; changed = true;
          this.log({ ts: now, rule: k, kind: 'alarm', msg });
          this.notify({ kind: 'alarm', rule: k, title: rule.title, body: msg });
        } else if (st.active) {
          st.msg = msg;
          if (now - st.lastNotified >= cfg.renotifyMin * 60_000) {
            st.lastNotified = now;                       // repeat timer always advances
            if (now >= cfg.snoozeUntil) {
              this.log({ ts: now, rule: k, kind: 'repeat', msg });
              this.notify({ kind: 'alarm', rule: k, title: rule.title, body: msg });
            }
          }
        }
      } else {
        st.since = null;
        if (st.active) {
          st.active = false; changed = true;
          const msg = `${rule.title}: back to normal`;
          this.log({ ts: now, rule: k, kind: 'cleared', msg });
          this.notify({ kind: 'cleared', rule: k, title: 'Cleared', body: msg });
        }
      }
    }
    return changed;
  }
}

// Validate/merge a partial config update; throws Error on bad input.
export function mergeConfig(cur, patch) {
  const out = structuredClone(cur);
  const num = (v, lo, hi, name) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${name} must be a number ${lo}..${hi}`);
    return v;
  };
  if ('armed' in patch) out.armed = !!patch.armed;
  if ('renotifyMin' in patch) out.renotifyMin = num(patch.renotifyMin, 1, 1440, 'renotifyMin');
  if ('hysteresisC' in patch) out.hysteresisC = num(patch.hysteresisC, 0, 10, 'hysteresisC');
  for (const [k, p] of Object.entries(patch.rules || {})) {
    if (!out.rules[k]) throw new Error(`unknown rule ${k}`);
    if ('enabled' in p) out.rules[k].enabled = !!p.enabled;
    if ('delayMin' in p) out.rules[k].delayMin = num(p.delayMin, 0, 1440, `${k}.delayMin`);
    if ('value' in p) {
      if (!('value' in out.rules[k])) throw new Error(`${k} has no value`);
      out.rules[k].value = k === 'battery' ? num(p.value, 6, 16, 'battery.value') : num(p.value, -30, 80, `${k}.value`);
    }
  }
  if (out.rules.tempLow.value >= out.rules.tempHigh.value) throw new Error('low limit must be below high limit');
  return out;
}
