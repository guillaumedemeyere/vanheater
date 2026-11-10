import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/commands.js';

test('start/stop map to RunState', () => {
  assert.deepEqual(build('start'), { RunState: 1 });
  assert.deepEqual(build('stop'), { RunState: 0 });
});
test('setpoint validates and rounds to 0.5', () => {
  assert.deepEqual(build('setpoint', { value: 20 }), { TempDesired: 20 });
  assert.deepEqual(build('setpoint', { value: 20.3 }), { TempDesired: 20.5 });
  for (const bad of [7, 36, 'x', null, NaN, undefined]) assert.throws(() => build('setpoint', { value: bad }));
});
test('fuel reset only touches PumpCount, never the lifetime total', () => {
  const m = build('reset-fuel-used');
  assert.deepEqual(Object.keys(m).sort(), ['NVsave', 'PumpCount']);
  assert.equal(m.PumpCount, 0);
  assert.ok(!('SysTotalFuel' in m) && !('TotalFuelUsage' in m));
});
test('unknown commands are rejected', () => {
  assert.throws(() => build('PumpPrime'));
  assert.throws(() => build('SysTotalFuel'));
});

test('fixed-Hz mode: setpoint is a whole demand level within TempMin..TempMax', () => {
  const ctx = { thermostat: 0, tempMin: 8, tempMax: 35, thermMin: 3, thermMax: 34.5 };
  assert.deepEqual(build('setpoint', { value: 12 }, ctx), { TempDesired: 12 });
  assert.deepEqual(build('setpoint', { value: 12.4 }, ctx), { TempDesired: 12 });
  assert.throws(() => build('setpoint', { value: 7 }, ctx));      // below demand range even though 7 is a valid temperature
  assert.throws(() => build('setpoint', { value: 36 }, ctx));
});
test('thermostat mode uses the heater-reported limits when known', () => {
  const ctx = { thermostat: 1, thermMin: 3, thermMax: 34.5 };
  assert.deepEqual(build('setpoint', { value: 4 }, ctx), { TempDesired: 4 });
  assert.throws(() => build('setpoint', { value: 2 }, ctx));
  assert.throws(() => build('setpoint', { value: 35 }, ctx));
});

test('thermostat modes map to the stock page messages', () => {
  assert.deepEqual(build('thermostat-mode', { mode: 'standard' }), { Thermostat: 1, ThermostatMethod: 0, NVsave: 8861 });
  assert.deepEqual(build('thermostat-mode', { mode: 'deadband' }), { Thermostat: 1, ThermostatMethod: 1, NVsave: 8861 });
  assert.deepEqual(build('thermostat-mode', { mode: 'linearhz' }), { Thermostat: 1, ThermostatMethod: 2, NVsave: 8861 });
  assert.deepEqual(build('thermostat-mode', { mode: 'stopstart' }), { Thermostat: 1, ThermostatMethod: 4, NVsave: 8861 });
  assert.deepEqual(build('thermostat-mode', { mode: 'fixedhz' }, { method: 2 }), { Thermostat: 0, ThermostatMethod: 2, NVsave: 8861 });
  assert.deepEqual(build('thermostat-mode', { mode: 'fixedhz' }), { Thermostat: 0, NVsave: 8861 });
  assert.throws(() => build('thermostat-mode', { mode: 'external' }));
  assert.throws(() => build('thermostat-mode', {}));
});

test('cyclic mode: enable uses CyclicOff>=2, disable is 0, nothing else', () => {
  assert.deepEqual(build('cyclic', { enabled: true }), { CyclicOff: 2, NVsave: 8861 });
  assert.deepEqual(build('cyclic', { enabled: true, off: 3.2 }), { CyclicOff: 3, NVsave: 8861 });
  assert.deepEqual(build('cyclic', { enabled: false }), { CyclicOff: 0, NVsave: 8861 });
  assert.throws(() => build('cyclic', { enabled: true, off: 1 }));
  assert.throws(() => build('cyclic', { enabled: 'yes' }));
  assert.throws(() => build('cyclic', {}));
});
