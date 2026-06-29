-- Detect orientation and build coordinate wrappers.
-- Real device: portrait (135×240). Simulator: landscape (240×135).
-- In landscape mode every shape is rotated 90° CCW so the layout
-- matches portrait exactly. Text glyphs appear rotated (read with a
-- head-tilt) — that's a simulator-only trade-off.
local _SW = screen.width()
local _SH = screen.height()
local IS_L = _SW > _SH        -- true in simulator
local VW   = IS_L and _SH or _SW   -- virtual portrait width  = 135
local VH   = IS_L and _SW or _SH   -- virtual portrait height = 240

local function sfr(px, py, pw, ph, r, g, b)
  if not IS_L then screen.fill_rect(px, py, pw, ph, r, g, b)
  else              screen.fill_rect(py, VW-px-pw, ph, pw, r, g, b) end
end
local function srt(px, py, pw, ph, r, g, b)
  if not IS_L then screen.rect(px, py, pw, ph, r, g, b)
  else              screen.rect(py, VW-px-pw, ph, pw, r, g, b) end
end
local function stx(px, py, str, sz, r, g, b)
  if not IS_L then screen.text(px, py, str, sz, r, g, b)
  else              screen.text(py, VW-px-sz*8, str, sz, r, g, b) end
end

-- Stub recorder (replace with real C driver on device)
local _rem   = 7
local _dev   = 3
local _upl   = 2
local _rec   = false
local _rec_t = 0
local _sync  = false
local _wifi  = true
local _tick  = 0
local _wave  = {}
local _gps   = "51.5074N 0.1278W"

local rec = {
  clips_remaining     = function() return _rem end,
  is_recording        = function() return _rec end,
  amplitude           = function() return abs(sin(_tick * 0.15)) * 0.7 + 0.3 end,
  is_syncing          = function() return _sync end,
  clips_uploaded      = function() return _upl end,
  clips_on_device     = function() return _dev end,
  delete_all_uploaded = function()
    _rem = _rem + _upl; _dev = _dev - _upl; _upl = 0
  end,
}

local function pad3(n)
  local s = tostring(n)
  while #s < 3 do s = "0" .. s end
  return s
end
local function inum(n) return tostring(floor(n)):match("^-?%d+") or "0" end
local function fmt_hm(h, m)
  local hs = tostring(h); local ms = tostring(m)
  if #hs < 2 then hs = "0"..hs end
  if #ms < 2 then ms = "0"..ms end
  return hs..":"..ms
end

local _groups = {
  { id = 1, clips = {
    { ts = "Jun 28 09:14", gps = "51.5074N 0.1278W",
      wave = {0.4,0.7,0.9,0.6,0.8,0.5,0.9,0.7,0.6,0.8,
              0.9,0.5,0.7,0.8,0.6,0.9,0.7,0.5,0.8,0.6} },
    { ts = "Jun 28 09:31", gps = "51.5074N 0.1278W",
      wave = {0.3,0.5,0.8,0.9,0.7,0.4,0.6,0.9,0.8,0.5,
              0.6,0.8,0.9,0.7,0.5,0.4,0.8,0.9,0.6,0.7} },
  }},
  { id = 2, clips = {
    { ts = "Jun 28 14:22", gps = "51.5201N 0.0891W",
      wave = {0.2,0.6,0.8,0.5,0.9,0.7,0.4,0.8,0.6,0.9,
              0.7,0.5,0.8,0.4,0.9,0.6,0.7,0.8,0.5,0.3} },
  }},
}

local N_BARS  = 20
local REC_DUR = 10000
local DCLICK  = 350
local SAMP_T  = 5

local view     = "main"
local gc       = 1
local a_pend   = false
local a_pend_t = 0
local play_id    = nil
local play_c     = nil
local play_start = 0

local function clip_list()
  local list = {}
  for _, g in ipairs(_groups) do
    for ci, c in ipairs(g.clips) do
      table.insert(list, { id = pad3(g.id).."."..ci, c = c })
    end
  end
  return list
end

local function n_items()
  return 1 + (_wifi and #clip_list() or 0)
end

local function item_for(i)
  if i == 1 then
    if not _wifi     then return "No WiFi", nil
    elseif _dev == 0 then return "All clear", nil
    elseif _upl > 0  then return inum(_upl).." to free", nil
    else                   return inum(_dev).." captures", nil end
  end
  local list = clip_list()
  local e = list[i - 1]
  if not e then return "?", nil end
  return e.id, e.c
end

local function save_rec(ctx)
  _rec = false; _rem = max(0, _rem-1); _dev = _dev+1
  local ts = "Today "..fmt_hm(ctx.utc_h, ctx.utc_m)
  local g  = _groups[#_groups]
  if not g then g = { id=1, clips={} }; table.insert(_groups, g) end
  table.insert(g.clips, { ts=ts, gps=_gps, wave=_wave })
  _wave = {}
end

-- n_played: bars already played (overlaid white); 0 = no overlay
local function draw_wave(wave, n_fill, n_played, cx, cy, bh_max)
  local bw = 4; local gap = 2
  local sx = cx - floor(N_BARS * (bw+gap) / 2)
  for i = 1, N_BARS do
    local amp = wave[i] or 0.12
    local bh  = max(2, floor(amp * bh_max))
    local bx  = sx + (i-1) * (bw+gap)
    if i <= n_played then    sfr(bx, cy-bh, bw, bh*2, 255, 255, 255)
    elseif i <= n_fill then  sfr(bx, cy-bh, bw, bh*2, 0,   210, 90)
    else                     sfr(bx, cy-2,  bw, 4,     35,  35,  35) end
  end
end

local function draw_main(ctx)
  screen.clear()
  if _sync and floor(ctx.time_ms/400)%2==0 then
    stx(2, 4, "syncing", 1, 0, 200, 255)
  end
  local rem = rec.clips_remaining()
  local ns = 8
  local s  = inum(rem)
  local nx = floor((VW - #s*ns*6) / 2)
  if _rec then
    stx(nx, 10, s, ns, 255, 255, 255)
    stx(floor((VW-108)/2), 82, "recording", 2, 220, 60, 60)
    local full = {}
    for i = 1, N_BARS do full[i] = _wave[i] or 0.12 end
    draw_wave(full, #_wave, 0, floor(VW/2), 175, 38)
  else
    stx(nx, 70, s, ns, 255, 255, 255)
    local cap = "remaining"
    stx(floor((VW - #cap*6) / 2), 142, cap, 1, 110, 110, 110)
    if rem == 0 then
      stx(4, VH-36, "Connect WiFi",  1, 210, 110, 40)
      stx(4, VH-24, "to free space", 1, 210, 110, 40)
    else
      stx(32, VH-16, "A: record", 1, 65, 65, 65)
    end
  end
  screen.flip()
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
      sfr(0, iy-2, VW, 30, 255, 220, 40)
      stx(6, iy+6, label, 2, 0, 0, 0)
    else
      stx(6, iy+6, label, 2, 200, 200, 200)
    end
  end
  stx(4, VH-14, "A:next  AA:open  B:back", 1, 65, 65, 65)
  screen.flip()
end

local function draw_play(ctx)
  if not play_c then view = "gallery"; return end
  screen.clear()
  stx(2, 10, play_id, 3, 255, 220, 40)
  stx(2, 46, play_c.ts,  1, 210, 210, 210)
  stx(2, 60, play_c.gps, 1, 80, 170, 255)
  local n_played = min(N_BARS, floor((ctx.time_ms - play_start) / REC_DUR * N_BARS))
  draw_wave(play_c.wave, N_BARS, n_played, floor(VW/2), 140, 52)
  stx(34, VH-16, "B: back", 1, 65, 65, 65)
  screen.flip()
end

local function gallery_action(ctx)
  local label, clip = item_for(gc)
  if gc == 1 and _upl > 0 then
    rec.delete_all_uploaded()
  elseif clip then
    play_id = label; play_c = clip; play_start = ctx.time_ms; view = "play"
  end
end

function init(ctx)  draw_main(ctx) end

function on_tick(ctx, dt_ms)
  _tick = _tick + 1
  if _rec then
    if _tick % SAMP_T == 0 and #_wave < N_BARS then
      table.insert(_wave, rec.amplitude())
    end
    if ctx.time_ms - _rec_t >= REC_DUR then save_rec(ctx) end
  end
  if a_pend and ctx.time_ms - a_pend_t >= DCLICK then
    a_pend = false
    if view == "play" then play_start = ctx.time_ms
    else gc = gc % n_items() + 1 end
  end
  if view == "main"    then draw_main(ctx)
  elseif view == "gallery" then draw_gallery(ctx)
  else draw_play(ctx) end
end

function on_event(ctx, e)
  if e.name == "button" then
    if e.index == 1 then
      a_pend = false
      if view == "play"    then view = "gallery"
      elseif view == "gallery" then view = "main"
      else view = "gallery" end
    elseif view == "main" then
      if not _rec and _rem > 0 then
        _rec = true; _rec_t = ctx.time_ms; _wave = {}
      end
    elseif view == "play" then
      if a_pend and ctx.time_ms - a_pend_t < DCLICK then
        a_pend = false; view = "gallery"   -- double-click: close
      else a_pend = true; a_pend_t = ctx.time_ms end  -- single: arm replay
    else
      if a_pend and ctx.time_ms - a_pend_t < DCLICK then
        a_pend = false; gallery_action(ctx)
      else a_pend = true; a_pend_t = ctx.time_ms end
    end
  elseif e.name == "recording_started"  then
    _rec = true; _rec_t = ctx.time_ms; _wave = {}
  elseif e.name == "recording_finished" then save_rec(ctx)
  elseif e.name == "upload_complete"    then
    _upl = _upl + 1
    table.insert(_groups, { id=#_groups+1, clips={} })
  elseif e.name == "wifi_connected"     then _wifi = true
  elseif e.name == "wifi_disconnected"  then _wifi = false
  end
end
