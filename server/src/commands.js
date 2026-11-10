// Allow-listed heater commands. Pure: turns a request into the exact JSON the heater's /JSONin expects.
// Formats taken from the stock Afterburner page (sendCMD): flat {"Key": value}; NVsave=8861 persists to flash.
export const NVSAVE = 8861;
export const SETPOINT_MIN = 8, SETPOINT_MAX = 35;   // stock page defaults for ThermMin/ThermMax (heater enforces its own)

export const MODES = {
  fixedhz: { thermostat: 0 },
  standard: { thermostat: 1, method: 0 },
  deadband: { thermostat: 1, method: 1 },
  linearhz: { thermostat: 1, method: 2 },
  stopstart: { thermostat: 1, method: 4 },
};

export function build(name, body = {}, ctx = {}) {
  switch (name) {
    // Same request the stock page sends on every connect: asks the heater to re-publish its settings. Read-only.
    case 'refresh': return { Refresh: 1, SQuery: 1, IQuery: 1, MQuery: 1 };
    case 'start': return { RunState: 1 };
    case 'stop': return { RunState: 0 };
    case 'setpoint': {
      // Thermostat mode: TempDesired is a temperature (°C). Fixed-Hz mode (Thermostat === 0): TempDesired is a pump
      // DEMAND level between TempMin and TempMax that maps linearly onto the pump's Hz range (same as the stock page).
      const v = Number(body.value);
      const hz = ctx.thermostat === 0;
      const lo = hz ? (ctx.tempMin ?? SETPOINT_MIN) : (ctx.thermMin ?? SETPOINT_MIN);
      const hi = hz ? (ctx.tempMax ?? SETPOINT_MAX) : (ctx.thermMax ?? SETPOINT_MAX);
      if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(hz ? `pump demand must be ${lo}..${hi}` : `setpoint must be ${lo}..${hi} °C`);
      return { TempDesired: hz ? Math.round(v) : Math.round(v * 2) / 2 };
    }
    // Thermostat mode, exactly as the stock page sends it: {Thermostat, ThermostatMethod, NVsave}.
    // Fixed Hz sets Thermostat=0 and leaves the method as it is. 'stopstart' (method 4) can stop AND restart the heater.
    case 'thermostat-mode': {
      const m = MODES[body.mode];
      if (!m) throw new Error('unknown thermostat mode');
      const out = { Thermostat: m.thermostat };
      if (m.method !== undefined) out.ThermostatMethod = m.method;
      else if (Number.isInteger(ctx.method)) out.ThermostatMethod = ctx.method;
      out.NVsave = NVSAVE;
      return out;
    }
    // Cyclic mode, as the stock page does it: "enabled" means CyclicOff > 1 (stock default 2 on enabling); 0 = disabled.
    // Enabling lets the heater STOP and RESTART itself by temperature, so this is never exercised in tests.
    case 'cyclic': {
      if (typeof body.enabled !== 'boolean') throw new Error('enabled must be true or false');
      let off = 0;
      if (body.enabled) {
        off = body.off === undefined ? 2 : Number(body.off);
        if (!Number.isFinite(off) || off < 2 || off > 10) throw new Error('cyclic off offset must be 2..10');
        off = Math.round(off * 2) / 2;
      }
      return { CyclicOff: off, NVsave: NVSAVE };
    }
    // Resets ONLY the "Used" counter (PumpCount). Lifetime total (SysTotalFuel) is never touched.
    case 'reset-fuel-used': return { PumpCount: 0, NVsave: NVSAVE };
    default: throw Object.assign(new Error('unknown command'), { code: 404 });
  }
}
