# Portrait Simulator (local)

In-browser Resident sandbox with a **135×240 portrait** display. Matches the
relay protocol of `resident.inanimate.tech` but uses vertical layout instead of
the official landscape M5Stick simulator.

Apps drive the screen as primary output and respond to button presses. IMU and
buzzer are stubbed (no-op / static readings) like the online simulator.

## Hardware

**TFT screen:** 135×240 pixels in **portrait** orientation (135 wide, 240 tall).
Coordinates 0-based, origin top-left. Colours 0–255 per channel.
Double-buffered: draw off-screen, then `screen.flip()` to push the frame.

**Buttons:** Two virtual buttons, indexed 0 (A) and 1 (B). Surface as
`button` events with an `index` field.

**IMU:** Stub — `accel()` returns `(0, 0, 1)`, `gyro()` returns zeros.

**Buzzer:** Stub — `beep` / `tone` / `stop` are no-ops.

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

### imu.*
```lua
local ax, ay, az = imu.accel()  -- stub: 0, 0, 1
local gx, gy, gz = imu.gyro()   -- stub: 0, 0, 0
```

### buzzer.*
```lua
buzzer.beep(440, 80)   -- no-op in simulator
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
  end
end
```

## Constraints

- Screen: **135×240 portrait** — design layouts for tall/narrow, not 240×135.
- Two buttons (index 0 and 1).
- IMU and buzzer are stubs only.

## Validation stubs

```lua
screen = setmetatable({
  width  = function() return 135 end,
  height = function() return 240 end,
}, { __index = function() return function() end end })

imu = setmetatable({
  accel = function() return 0, 0, 1 end,
  gyro  = function() return 0, 0, 0 end,
}, { __index = function() return function() end end })

button = setmetatable({
  press_count = function() return 0 end,
}, { __index = function() return function() end end })
```
