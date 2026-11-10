import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, DEFAULTS, mergeConfig } from '../src/engine.js';

function rig(over = {}) {
  const s = { online: true, lastMsg: 0, values: { TempCurrent: 21, ErrorString: 'E-00: OK', InputVoltage: 13.4 } };
  const cfg = mergeConfig(DEFAULTS, { armed: true, ...over });
  const sent = [], logs = [];
  const e = new Engine({ getState: () => s, getConfig: () => cfg, notify: (n) => sent.push(n), log: (l) => logs.push(l) });
  return { s, cfg, sent, logs, e };
}
const MIN = 60_000;

test('high temp fires only after the delay, repeats, then clears with hysteresis', () => {
  const { s, cfg, sent, e } = rig();
  s.lastMsg = 0; let t = 1_000_000; s.lastMsg = t;
  s.values.TempCurrent = 31; e.tick(t);
  assert.equal(sent.length, 0);                       // inside the 2 min delay
  t += 2 * MIN; s.lastMsg = t; e.tick(t);
  assert.equal(sent.length, 1); assert.equal(sent[0].rule, 'tempHigh');
  t += 10 * MIN; s.lastMsg = t; e.tick(t);
  assert.equal(sent.length, 1);                       // before renotify (15 min)
  t += 6 * MIN; s.lastMsg = t; e.tick(t);
  assert.equal(sent.length, 2);                       // repeat
  s.values.TempCurrent = 29.5; t += MIN; s.lastMsg = t; e.tick(t);
  assert.equal(e.active().length, 1);                 // within hysteresis (limit 30, hyst 1)
  s.values.TempCurrent = 28.9; t += MIN; s.lastMsg = t; e.tick(t);
  assert.equal(e.active().length, 0); assert.equal(sent.at(-1).kind, 'cleared');
});

test('a short spike under the delay never alarms', () => {
  const { s, sent, e } = rig(); let t = 5_000_000; s.lastMsg = t;
  s.values.TempCurrent = 35; e.tick(t);
  t += MIN; s.lastMsg = t; s.values.TempCurrent = 22; e.tick(t);
  t += 5 * MIN; s.lastMsg = t; e.tick(t);
  assert.equal(sent.length, 0);
});

test('disarmed: temperature rules are silent but error rule still fires', () => {
  const { s, sent, e } = rig({ armed: false }); const t = 9_000_000; s.lastMsg = t;
  s.values.TempCurrent = 40; s.values.ErrorString = 'E-05: Glow plug';
  e.tick(t);
  assert.deepEqual(sent.map((n) => n.rule), ['error']);   // error has delayMin 0
});

test('stale data and offline rules', () => {
  const { s, sent, e } = rig(); let t = 20_000_000; s.lastMsg = t;
  e.tick(t); assert.equal(sent.length, 0);
  t += 11 * MIN; e.tick(t);                            // starts the 10 min delay window
  t += 10 * MIN; e.tick(t);
  assert.ok(sent.some((n) => n.rule === 'stale'));
  s.online = false; e.tick(t); t += 2 * MIN; e.tick(t);
  assert.ok(sent.some((n) => n.rule === 'offline'));
});

test('snooze silences repeats but not the first alarm', () => {
  const { s, cfg, sent, e } = rig(); let t = 30_000_000; s.lastMsg = t;
  s.values.TempCurrent = 35; e.tick(t); t += 2 * MIN; s.lastMsg = t; e.tick(t);
  assert.equal(sent.length, 1);
  cfg.snoozeUntil = t + 60 * MIN;
  t += 16 * MIN; s.lastMsg = t; e.tick(t);
  assert.equal(sent.length, 1);
});

test('mergeConfig validates', () => {
  assert.throws(() => mergeConfig(DEFAULTS, { rules: { tempHigh: { value: 5 } } }));       // below low limit
  assert.throws(() => mergeConfig(DEFAULTS, { rules: { nope: {} } }));
  assert.throws(() => mergeConfig(DEFAULTS, { renotifyMin: 'x' }));
  assert.equal(mergeConfig(DEFAULTS, { armed: true }).armed, true);
});
