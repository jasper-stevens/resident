# Field Recorder — Lua driver API

Stable API contract for the field-recorder app. The portrait simulator
implements this in JavaScript (`tools/portrait-simulator/backends/`). On
device, implement matching C++ drivers (`rec`, `gps`) registered with
`Resident::Sandbox`.

## `rec` module

```lua
local rem = rec.clips_remaining()   -- free recording slots (int)
local dev = rec.clips_on_device()   -- clips stored locally (int)
local upl = rec.clips_uploaded()    -- uploaded, pending delete (int)

local recording = rec.is_recording()
local syncing   = rec.is_syncing()
local playing   = rec.is_playing()
local amp       = rec.amplitude()   -- 0.0–1.0 live mic level

rec.start()           -- begin 10s capture; returns bool
rec.stop()            -- end capture early; returns bool
rec.play(clip_id)     -- play local or cloud clip; returns bool
rec.stop_playback()
rec.delete_uploaded() -- free slots after upload

local clips = rec.list()
-- each entry: { id, label, group_id, capture_index, ts, gps, wave, source, duration_ms }
-- label is e.g. "001.A" (group 001, capture A); source is "local" or "cloud"
```

### Audio format (device target)

- 16 kHz, mono, 16-bit PCM (WAV on simulator; SPIFFS/SD on device)
- Waveform preview: 20 amplitude bars (0.0–1.0) per clip

### Storage limits

- `MAX_CLIPS = 10` total on-device capacity
- `clips_remaining = MAX_CLIPS - clips_on_device`

## `gps` module

```lua
local ok = gps.fix()        -- bool: valid fix
local label = gps.string()  -- e.g. "51.50N 0.12W"
```

On device: NMEA parser from UART GPS module. On simulator: browser
`navigator.geolocation`.

## Events (`on_event`)

| Event | Data | When |
|-------|------|------|
| `recording_started` | — | Mic capture begins |
| `recording_finished` | `id`, `label`, `group_id`, `capture_index`, `ts`, `gps`, `wave`, `duration_ms` | Capture saved locally |
| `sync_started` | — | Upload batch begins |
| `sync_finished` | — | Upload batch ends |
| `upload_complete` | `id` | One clip uploaded |
| `wifi_connected` | — | Network available |
| `wifi_disconnected` | — | Network lost |
| `playback_finished` | `id` | Speaker playback ended |

## Device implementation notes

### RecorderDriver (C++)

Reference: [`examples/m5stick-voice/device/src/main.cpp`](../../examples/m5stick-voice/device/src/main.cpp) for `M5.Mic` capture.

Responsibilities:

1. **Capture** — `M5.Mic.record()` into ring buffer during `rec.start()`…`rec.stop()`
2. **Amplitude** — RMS/peak from latest frame for `rec.amplitude()`
3. **Storage** — write WAV to SPIFFS; enforce slot limit
4. **Playback** — stream PCM through `M5.Speaker`
5. **Upload** — on WiFi connect, `HTTPClient` POST to Supabase Storage + REST insert
6. **Events** — `sendEvent("recording_finished", …)` etc.

Hook WiFi state from Courier:

```cpp
// In main loop or Courier state callback:
if (courier.state() == Courier::State::WifiConnected) {
    recorder.onWifiConnected();
}
```

### GpsDriver (C++)

- UART read NMEA sentences
- `gps.fix()` when `GGA` has valid fix
- `gps.string()` formatted lat/lon label

### Swap checklist

When moving from simulator to device:

1. Flash firmware with `RecorderDriver` + `GpsDriver` in `cfg.extensions`
2. Push the same `field-recorder.lua` — no app changes needed
3. Configure Supabase URL/key in device firmware (not in Lua)
4. Remove simulator-only WiFi toggle (real WiFi drives events)
