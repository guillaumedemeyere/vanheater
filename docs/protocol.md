# Heater MQTT protocol notes

What this portal relies on, for anyone adapting it. These notes come from watching a heater's MQTT traffic
(firmware V3.5.5) and from how the stock Afterburner web page behaves. They are **unofficial**, may change between
firmware versions, and the items marked *not verified live* have not been tried against a real heater.

## Topics

All topics sit under the heater's **topic prefix** (set on its comms settings page).

| Topic | Direction | Content |
|---|---|---|
| `<prefix>/status` | heater → you | `online`, or anything else when it is offline (also its last will). |
| `<prefix>/sts/<Key>` | heater → you | One plain-text topic per value, published when it changes. |
| `<prefix>/JSONout` | heater → you | JSON deltas such as `{"FanRPM":2300}`. Also carries keys the `sts` topics lack (Humidity, Pressure) and the full settings dump. |
| `<prefix>/JSONin` | you → heater | Flat JSON commands, for example `{"TempDesired":18}`. |

Settings (thermostat mode, limits, pump range, network details) are only published when asked. The stock page asks on
every connect, and so does this portal:

```json
{"Refresh":1,"SQuery":1,"IQuery":1,"MQuery":1}
```

Be aware that the reply includes network details (WiFi name, addresses). On a public broker anyone who knows your
topic prefix can read it, so treat the prefix like a password.

## Values

| Key | Meaning |
|---|---|
| `TempCurrent` | Cabin temperature in °C (`Temp1Current` to `Temp4Current` are the other sensors). |
| `TempBody` | Heater body temperature. Not the cabin. |
| `TempDesired` | Target. **A temperature in thermostat modes, a pump demand level in Fixed Hz mode.** |
| `Thermostat` | `0` = Fixed Hz mode, `1` = a thermostat mode. |
| `ThermostatMethod` | `0` standard, `1` deadband, `2` linear Hz, `4` stop/start. |
| `ThermMin`, `ThermMax` | Temperature limits for the target. |
| `TempMin`, `TempMax` | Demand range for Fixed Hz mode. |
| `PumpMinActual`, `PumpMaxActual` | Pump rate range in Hz. |
| `PumpFixed`, `PumpActual` | Fixed-Hz setting and actual pump rate, in Hz. They can differ. |
| `RunState`, `RunString` | State code (5 = running, 0 = standby) and its text. |
| `ErrorState`, `ErrorString` | Fault code and text. `E-00: OK` means no fault. |
| `InputVoltage` | Supply voltage. |
| `FanRPM`, `Humidity`, `Pressure` | As named. |
| `FuelRate` | Millilitres per hour. |
| `FuelUsage` | Millilitres since the "Used" counter was last reset (`PumpCal` × `PumpCount`). |
| `TotalFuelUsage`, `SysTotalFuel` | Lifetime total in millilitres. |
| `CyclicOff` | Cyclic mode is enabled when this is greater than 1. `CyclicEnb` is a read-back of it. |

### Fixed Hz demand to pump rate

```
Hz = PumpMinActual + (demand - TempMin) / (TempMax - TempMin) * (PumpMaxActual - PumpMinActual) - 0.05
```

(rounded to one decimal place).

## Commands

Commands that change a stored setting also carry `"NVsave": 8861`, which makes the heater write it to flash.

| Action | Message | Status |
|---|---|---|
| Ask for settings | `{"Refresh":1,"SQuery":1,"IQuery":1,"MQuery":1}` | verified live |
| Set target | `{"TempDesired": n}` | verified live (thermostat mode) |
| Start | `{"RunState":1}` | *not verified live* |
| Stop | `{"RunState":0}` | *not verified live* |
| Reset the "Used" fuel counter | `{"PumpCount":0,"NVsave":8861}` | *not verified live* |
| Thermostat mode | `{"Thermostat":x,"ThermostatMethod":y,"NVsave":8861}` | *not verified live* |
| Cyclic mode on / off | `{"CyclicOff":2,"NVsave":8861}` / `{"CyclicOff":0,"NVsave":8861}` | *not verified live* |

Start/stop, the stop/start thermostat mode and cyclic mode can stop and restart the heater. A restart can produce smoke.
The portal asks for confirmation before sending any of them.

## What the portal does with this

The server only publishes the allow-listed commands above, only after a login, and only when `COMMANDS_ENABLED=true`.
Everything else is refused. See `server/src/commands.js`.
