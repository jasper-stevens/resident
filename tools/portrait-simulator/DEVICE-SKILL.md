# Portrait Simulator (local)

In-browser Resident sandbox with a **135×240 portrait** display. Matches the
relay protocol of `resident.inanimate.tech` but uses vertical layout instead of
the official landscape M5Stick simulator.

Apps drive the screen as primary output and respond to button presses. Field
recorder apps can use real microphone, speaker, GPS, and Supabase sync via the
`rec` and `gps` modules.

## Hardware

**TFT screen:** 135×240 pixels in **portrait** orientation (135 wide, 240 tall).
Coordinates 0-based, origin top-left. Colours 0–255 per channel.
Double-buffered: draw off-screen, then `screen.flip()` to push the frame.

**Buttons:** Two virtual buttons, indexed 0 (A) and 1 (B). Surface as
`button` events with an `index` field.

**Microphone / speaker:** Real browser audio via Web Audio API (field recorder).

**GPS:** Browser geolocation (`navigator.geolocation`).

**WiFi:** Simulated with the **WiFi: on/off** meta toggle in the simulator UI.

**IMU:** Stub — `accel()` returns `(0, 0, 1)`, `gyro()` returns zeros.

**Buzzer:** Stub — `beep` / `tone` / `stop` are no-ops (playback uses speaker
via `rec.play()`).

## Lua Modules

### screen.*
**Hardware:** 135×240 portrait, double-buffered.

```lua
screen.clear()                                   -- clear to black
screen.clear(255, 0, 0)                          -- clear to red
screen.text(10, 10, "HELLO")                     -- size 2, white
screen.text(10, 10, "HELLO", 2, 255, 0, 0)       -- size 2, red
screen.fill_rect(x, y, w, h, r, g, b)
screen.rect(x, y, w, h, r, g, b)
screen.line(x0, y0, x1, y1, r, g, b)
screen.fill_triangle(x0, y0, x1, y1, x2, y2, r, g, b)
screen.pixel(x, y, r, g, b)
screen.flip()

local w = screen.width()                         -- 135
local h = screen.height()                        -- 240
```

**MUST:** call `screen.flip()` after every draw sequence.

### rec.*
**Hardware:** Mac mic + speaker, IndexedDB local storage, Supabase cloud sync.

```lua
local rem = rec.clips_remaining()
local dev = rec.clips_on_device()
local upl = rec.clips_uploaded()

if rec.is_recording() then
  local amp = rec.amplitude()   -- 0.0–1.0 for waveform
end

rec.start()                   -- 10s capture from mic
rec.stop()                    -- end early
rec.play(clip_id)             -- local always; cloud when WiFi on
rec.stop_playback()
rec.delete_uploaded()

local clips = rec.list()
-- { id, label, group_id, capture_index, ts, gps, wave, source, duration_ms }
-- label e.g. "001.A" — group increments after each upload batch
```

### gps.*
```lua
local ok = gps.fix()
local label = gps.string()    -- "51.50N 0.12W" or "no fix"
```

### imu.*
```lua
local ax, ay, az = imu.accel()  -- stub: 0, 0, 1
local gx, gy, gz = imu.gyro()   -- stub: 0, 0, 0
```

### button.*
```lua
local n = button.press_count()   -- total presses (both buttons)
```

Prefer `on_event` for button handling:

```lua
function on_event(ctx, e)
  if e.name == "button" and e.index == 0 then
    -- button A
  elseif e.name == "wifi_connected" then
    -- cloud sync enabled
  elseif e.name == "recording_finished" then
    -- e.label e.g. "001.A", e.group_id, e.capture_index
  end
end
```

### Driver events

| Event | When |
|-------|------|
| `recording_started` | Mic capture begins |
| `recording_finished` | Clip saved locally |
| `sync_started` / `sync_finished` | Upload batch |
| `upload_complete` | One clip uploaded (`e.id`) |
| `wifi_connected` / `wifi_disconnected` | WiFi toggle |
| `playback_finished` | Speaker done (`e.id`) |

## Constraints

- Screen: **135×240 portrait** — design layouts for tall/narrow.
- Two buttons (index 0 and 1).
- Supabase config: copy `supabase.config.example.json` → `supabase.config.json`
  (see `SUPABASE.md`).
- Cloud clips (marked `*` in gallery) require WiFi on to play.

## Validation stubs

```lua
screen = setmetatable({
  width  = function() return 135 end,
  height = function() return 240 end,
}, { __index = function() return function() end end })

rec = setmetatable({
  clips_remaining = function() return 7 end,
  clips_on_device = function() return 0 end,
  clips_uploaded  = function() return 0 end,
  is_recording    = function() return false end,
  is_syncing      = function() return false end,
  is_playing      = function() return false end,
  amplitude       = function() return 0.5 end,
  start           = function() return true end,
  stop            = function() return false end,
  play            = function() return true end,
  stop_playback   = function() return true end,
  delete_uploaded = function() end,
  list            = function() return {
    { id = "a", label = "001.A", group_id = 1, capture_index = 1, source = "local",
      ts = "Today 09:14", gps = "51.50N 0.12W", duration_ms = 10000, wave = {} },
  } end,
}, { __index = function() return function() end end })

gps = setmetatable({
  fix    = function() return true end,
  string = function() return "51.50N 0.12W" end,
}, { __index = function() return function() end end })

power = setmetatable({
  level    = function() return 92 end,
  charging = function() return true end,
  full     = function() return false end,
}, { __index = function() return function() end end })

imu = setmetatable({
  accel = function() return 0, 0, 1 end,
  gyro  = function() return 0, 0, 0 end,
}, { __index = function() return function() end end })

button = setmetatable({
  press_count = function() return 0 end,
}, { __index = function() return function() end end })
```
