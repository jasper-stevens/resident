local letter = ""
local alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
local letter_r, letter_g, letter_b = 255, 220, 50
local bg_r, bg_g, bg_b = 0, 0, 0

local function draw()
  screen.clear(bg_r, bg_g, bg_b)
  if letter == "" then
    screen.text(8, 110, "press btn A", 2, 150, 150, 150)
  else
    screen.text(40, 100, letter, 6, letter_r, letter_g, letter_b)
  end
  screen.flip()
end

function init(ctx)
  draw()
end

function on_event(ctx, e)
  if e.name == "button" and e.index == 0 then
    local n = noise2d(ctx.time_ms, ctx.trigger_count)
    local idx = floor((n + 1) * 13) % 26 + 1
    letter = string.sub(alpha, idx, idx)
    letter_r = floor((noise2d(ctx.time_ms, ctx.trigger_count + 1) + 1) * 127.5)
    letter_g = floor((noise2d(ctx.time_ms + 17, ctx.trigger_count + 2) + 1) * 127.5)
    letter_b = floor((noise2d(ctx.time_ms + 31, ctx.trigger_count + 3) + 1) * 127.5)
    bg_r = floor((noise2d(ctx.time_ms + 53, ctx.trigger_count + 4) + 1) * 127.5)
    bg_g = floor((noise2d(ctx.time_ms + 71, ctx.trigger_count + 5) + 1) * 127.5)
    bg_b = floor((noise2d(ctx.time_ms + 89, ctx.trigger_count + 6) + 1) * 127.5)
    draw()
  end
end
