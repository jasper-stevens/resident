local VW = screen.width()
local VH = screen.height()

local N_BARS  = 20
local REC_DUR = 10000
local DCLICK  = 350
local SAMP_T  = 5

local view     = "main"
local gc       = 1
local a_pend   = false
local a_pend_t = 0
local play_id  = nil
local play_c   = nil
local play_start = 0
local _wave    = {}
local _tick    = 0
local _wifi    = false

local function inum(n) return tostring(floor(n)):match("^-?%d+") or "0" end

local function status_color(on)
  if on then return 255, 255, 255 else return 90, 90, 90 end
end

local function draw_wifi_bars(x, y, on)
  local r, g, b = status_color(on)
  local base = y + 10
  local hs = {3, 5, 7, 9}
  for i = 1, 4 do
    local bh = hs[i]
    local bx = x + (i - 1) * 4
    screen.fill_rect(bx, base - bh, 2, bh, r, g, b)
  end
end

local function draw_battery(x, y)
  local pct = power.level() / 100
  local chg = power.charging()
  local full = power.full()
  local r, g, b = 255, 255, 255
  if full then r, g, b = 120, 255, 120 end
  screen.rect(x, y + 1, 18, 9, r, g, b)
  screen.fill_rect(x + 19, y + 3, 2, 5, r, g, b)
  local inner = floor(14 * pct)
  if inner > 0 then
    local ir, ig, ib = r, g, b
    if chg and not full then ir, ig, ib = 255, 220, 40 end
    screen.fill_rect(x + 2, y + 3, inner, 5, ir, ig, ib)
  end
  if chg and not full then
    screen.fill_rect(x + 8, y + 4, 2, 1, 0, 0, 0)
    screen.fill_rect(x + 7, y + 5, 4, 1, 0, 0, 0)
    screen.fill_rect(x + 8, y + 6, 2, 1, 0, 0, 0)
    screen.fill_rect(x + 9, y + 3, 1, 2, 0, 0, 0)
  end
end

local function draw_status_bar()
  local r, g, b = status_color(gps.fix())
  local tag = gps.simulated() and "SIM" or "GPS"
  screen.text(2, 2, tag, 1, r, g, b)
  draw_wifi_bars(30, 2, _wifi)
  draw_battery(VW - 24, 1)
end

local function draw_wave(wave, n_fill, n_played, cx, cy, bh_max)
  local bw = 4; local gap = 2
  local sx = cx - floor(N_BARS * (bw+gap) / 2)
  for i = 1, N_BARS do
    local amp = wave[i] or 0
    local bh  = amp > 0 and max(3, floor(amp * bh_max)) or 2
    local bx  = sx + (i-1) * (bw+gap)
    if i <= n_played then    screen.fill_rect(bx, cy-bh, bw, bh*2, 255, 255, 255)
    elseif i <= n_fill then  screen.fill_rect(bx, cy-bh, bw, bh*2, 0,   210, 90)
    else                     screen.fill_rect(bx, cy-2,  bw, 4,     35,  35,  35) end
  end
end

local function draw_main(ctx)
  screen.clear()
  draw_status_bar()
  if rec.is_syncing() and floor(ctx.time_ms/400)%2==0 then
    screen.text(2, 14, "syncing", 1, 0, 200, 255)
  end
  local rem = rec.clips_remaining()
  local ns = 8
  local s  = inum(rem)
  local nx = floor((VW - #s*ns*6) / 2)
  if rec.is_recording() then
    screen.text(nx, 24, s, ns, 255, 255, 255)
    screen.text(floor((VW-108)/2), 88, "recording", 2, 220, 60, 60)
    local full = {}
    for i = 1, N_BARS do full[i] = _wave[i] or 0 end
    draw_wave(full, #_wave, 0, floor(VW/2), 178, 42)
  else
    screen.text(nx, 76, s, ns, 255, 255, 255)
    local cap = "remaining"
    screen.text(floor((VW - #cap*6) / 2), 148, cap, 1, 110, 110, 110)
    if rem == 0 then
      screen.text(4, VH-36, "Connect WiFi",  1, 210, 110, 40)
      screen.text(4, VH-24, "to free space", 1, 210, 110, 40)
    else
      screen.text(32, VH-16, "A: record", 1, 65, 65, 65)
    end
  end
  screen.flip()
end

local function clip_list()
  return rec.list()
end

local function n_items()
  return 1 + #clip_list()
end

local function item_for(i)
  if i == 1 then
    if not _wifi then
      if rec.clips_uploaded() > 0 then return "No WiFi", nil end
    end
    if rec.clips_on_device() == 0 then return "All clear", nil
    elseif rec.clips_uploaded() > 0 then return inum(rec.clips_uploaded()).." to free", nil
    else return inum(rec.clips_on_device()).." captures", nil end
  end
  local list = clip_list()
  local c = list[i - 1]
  if not c then return "?", nil end
  local label = c.label or "?.?"
  if c.source == "local" then label = label.."*" end
  return label, c
end

local function draw_gallery(ctx)
  screen.clear()
  local n  = n_items()
  local ws = max(1, min(gc-1, max(1, n-5)))
  local we = min(ws+5, n)
  for i = ws, we do
    local iy    = 6 + (i-ws) * 34
    local label = item_for(i)
    if i == gc then
      screen.fill_rect(0, iy-2, VW, 30, 255, 220, 40)
      screen.text(6, iy+6, label, 2, 0, 0, 0)
    else
      screen.text(6, iy+6, label, 2, 200, 200, 200)
    end
  end
  screen.text(4, VH-14, "A:next  AA:open  B:back", 1, 65, 65, 65)
  screen.flip()
end

local function draw_play(ctx)
  if not play_c then view = "gallery"; return end
  screen.clear()
  screen.text(2, 10, play_id, 3, 255, 220, 40)
  screen.text(2, 46, play_c.ts,  1, 210, 210, 210)
  screen.text(2, 60, play_c.gps, 1, 80, 170, 255)
  local dur = play_c.duration_ms or REC_DUR
  local n_played = min(N_BARS, floor((ctx.time_ms - play_start) / dur * N_BARS))
  draw_wave(play_c.wave or {}, N_BARS, n_played, floor(VW/2), 140, 60)
  screen.text(34, VH-16, "B: back", 1, 65, 65, 65)
  screen.flip()
end

local function open_gallery()
  gc = 1
  view = "gallery"
end

local function gallery_action(ctx)
  local label, clip = item_for(gc)
  if gc == 1 and rec.clips_uploaded() > 0 and _wifi then
    rec.delete_uploaded()
  elseif clip then
    if clip.source == "cloud" and not _wifi then return end
    play_id = label
    play_c = clip
    play_start = ctx.time_ms
    view = "play"
    rec.play(clip.id)
  end
end

function init(ctx)
  _wifi = false
  draw_main(ctx)
end

function on_tick(ctx, dt_ms)
  _tick = _tick + 1
  if rec.is_recording() then
    if _tick % SAMP_T == 0 and #_wave < N_BARS then
      table.insert(_wave, rec.amplitude())
    end
  end
  if a_pend and ctx.time_ms - a_pend_t >= DCLICK then
    a_pend = false
    if view == "play" then
      play_start = ctx.time_ms
      rec.play(play_c.id)
    else
      gc = gc % n_items() + 1
    end
  end
  if view == "main"    then draw_main(ctx)
  elseif view == "gallery" then draw_gallery(ctx)
  else draw_play(ctx) end
end

function on_event(ctx, e)
  if e.name == "button" then
    if e.index == 1 then
      a_pend = false
      if view == "play" then
        rec.stop_playback()
        view = "gallery"
      elseif view == "gallery" then view = "main"
      else open_gallery() end
    elseif view == "main" then
      if not rec.is_recording() and rec.clips_remaining() > 0 then
        _wave = {}
        rec.start()
      end
    elseif view == "play" then
      if a_pend and ctx.time_ms - a_pend_t < DCLICK then
        a_pend = false
        rec.stop_playback()
        view = "gallery"
      else
        a_pend = true
        a_pend_t = ctx.time_ms
      end
    else
      if a_pend and ctx.time_ms - a_pend_t < DCLICK then
        a_pend = false
        gallery_action(ctx)
      else
        a_pend = true
        a_pend_t = ctx.time_ms
      end
    end
  elseif e.name == "recording_started" then
    _wave = {}
  elseif e.name == "recording_finished" then
    _wave = {}
  elseif e.name == "wifi_connected" then
    _wifi = true
  elseif e.name == "wifi_disconnected" then
    _wifi = false
    if view == "play" and play_c and play_c.source == "cloud" then
      rec.stop_playback()
      view = "gallery"
    end
  elseif e.name == "playback_finished" then
    if view == "play" then play_start = ctx.time_ms end
  end
end
