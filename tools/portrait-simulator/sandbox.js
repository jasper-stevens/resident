import { FONT_DATA } from "./font-data.js";

function fengari() {
  const f = globalThis.fengari;
  if (!f) {
    throw new Error("Fengari not loaded — refresh after vendor/fengari-web.js loads");
  }
  return f;
}

export const WIDTH = 135;
export const HEIGHT = 240;
const TICK_MS = 100;
const FONT_ROWS = 5;
const GLYPH_BITS = 8;
const CHAR_BASE = 6;

function glyphByte(ch, row) {
  if (ch < 32 || ch > 126) return 0;
  return FONT_DATA[(ch - 32) * FONT_ROWS + row];
}

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.floor(v)));
}

function smolHash(x, y) {
  let h = (x | 0) * 0x8da6b343 ^ (y | 0) * 0xd8163841;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h & 0xffffff) / 0xffffff;
}

export function createSandbox(canvas, { getButtonPressCount = () => 0, backends = null } = {}) {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari();
  const isNil = (L, idx) => !!lua.lua_isnoneornil(L, idx);
  const luaString = (L, idx) => {
    const raw = lua.lua_tolstring(L, idx);
    if (raw != null) return to_jsstring(raw);
    return lua.lua_tojsstring(L, idx) ?? "";
  };
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) throw new Error("Could not acquire 2D context");

  if (canvas.width !== WIDTH || canvas.height !== HEIGHT) {
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
  }

  const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 3);

  const setPixel = (x, y, r, g, b) => {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
    const i = (y * WIDTH + x) * 3;
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
  };

  const fillSpan = (x, y, w, r, g, b) => {
    if (y < 0 || y >= HEIGHT || w <= 0) return;
    const x0 = Math.max(0, x);
    const x1 = Math.min(WIDTH, x + w);
    for (let px = x0; px < x1; px++) setPixel(px, y, r, g, b);
  };

  const drawLine = (x0, y0, x1, y1, r, g, b) => {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (;;) {
      setPixel(x, y, r, g, b);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  };

  const drawRect = (x, y, w, h, r, g, b) => {
    if (w <= 0 || h <= 0) return;
    if (h === 1) {
      fillSpan(x, y, w, r, g, b);
      return;
    }
    if (w === 1) {
      for (let py = y; py < y + h; py++) setPixel(x, py, r, g, b);
      return;
    }
    fillSpan(x, y, w, r, g, b);
    fillSpan(x, y + h - 1, w, r, g, b);
    for (let py = y + 1; py < y + h - 1; py++) {
      setPixel(x, py, r, g, b);
      setPixel(x + w - 1, py, r, g, b);
    }
  };

  const fillTriangle = (x0, y0, x1, y1, x2, y2, r, g, b) => {
    if (y0 > y1) [x0, x1] = [x1, x0], [y0, y1] = [y1, y0];
    if (y1 > y2) [x1, x2] = [x2, x1], [y1, y2] = [y2, y1];
    if (y0 > y1) [x0, x1] = [x1, x0], [y0, y1] = [y1, y0];

    if (y0 === y2) {
      const left = Math.min(x0, x1, x2);
      const right = Math.max(x0, x1, x2);
      for (let y = y0; y <= y2; y++) fillSpan(left, y, right - left + 1, r, g, b);
      return;
    }

    const dx01 = x1 - x0;
    const dy01 = y1 - y0;
    const dx02 = x2 - x0;
    const dy02 = y2 - y0;
    const dx12 = x2 - x1;
    const dy12 = y2 - y1;
    const flat = y1 === y2 ? y1 : y1 - 1;

    for (let y = y0; y <= flat; y++) {
      const xa = x0 + Math.round((dx01 * (y - y0)) / dy01);
      const xb = x0 + Math.round((dx02 * (y - y0)) / dy02);
      fillSpan(Math.min(xa, xb), y, Math.abs(xb - xa) + 1, r, g, b);
    }
    for (let y = flat + 1; y <= y2; y++) {
      const xa = x1 + Math.round((dx12 * (y - y1)) / dy12);
      const xb = x0 + Math.round((dx02 * (y - y0)) / dy02);
      fillSpan(Math.min(xa, xb), y, Math.abs(xb - xa) + 1, r, g, b);
    }
  };

  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  const screen = {
    clear() {
      const r = clampByte(lua.lua_tonumber(L, 1) || 0);
      const g = clampByte(lua.lua_tonumber(L, 2) || 0);
      const b = clampByte(lua.lua_tonumber(L, 3) || 0);
      for (let i = 0; i < pixels.length; i += 3) {
        pixels[i] = r;
        pixels[i + 1] = g;
        pixels[i + 2] = b;
      }
      return 0;
    },
    fill_rect() {
      const x = Math.floor(lua.lua_tonumber(L, 1));
      const y = Math.floor(lua.lua_tonumber(L, 2));
      const w = Math.floor(lua.lua_tonumber(L, 3));
      const h = Math.floor(lua.lua_tonumber(L, 4));
      const r = clampByte(lua.lua_tonumber(L, 5));
      const g = clampByte(lua.lua_tonumber(L, 6));
      const b = clampByte(lua.lua_tonumber(L, 7));
      for (let py = y; py < y + h; py++) {
        for (let px = x; px < x + w; px++) setPixel(px, py, r, g, b);
      }
      return 0;
    },
    rect() {
      drawRect(
        Math.floor(lua.lua_tonumber(L, 1)),
        Math.floor(lua.lua_tonumber(L, 2)),
        Math.floor(lua.lua_tonumber(L, 3)),
        Math.floor(lua.lua_tonumber(L, 4)),
        clampByte(lua.lua_tonumber(L, 5)),
        clampByte(lua.lua_tonumber(L, 6)),
        clampByte(lua.lua_tonumber(L, 7)),
      );
      return 0;
    },
    line() {
      drawLine(
        Math.floor(lua.lua_tonumber(L, 1)),
        Math.floor(lua.lua_tonumber(L, 2)),
        Math.floor(lua.lua_tonumber(L, 3)),
        Math.floor(lua.lua_tonumber(L, 4)),
        clampByte(lua.lua_tonumber(L, 5)),
        clampByte(lua.lua_tonumber(L, 6)),
        clampByte(lua.lua_tonumber(L, 7)),
      );
      return 0;
    },
    triangle() {
      const args = Array.from({ length: 9 }, (_, i) => {
        if (i < 6) return Math.floor(lua.lua_tonumber(L, i + 1));
        return clampByte(lua.lua_tonumber(L, i + 1));
      });
      drawLine(args[0], args[1], args[2], args[3], args[6], args[7], args[8]);
      drawLine(args[2], args[3], args[4], args[5], args[6], args[7], args[8]);
      drawLine(args[4], args[5], args[0], args[1], args[6], args[7], args[8]);
      return 0;
    },
    fill_triangle() {
      fillTriangle(
        Math.floor(lua.lua_tonumber(L, 1)),
        Math.floor(lua.lua_tonumber(L, 2)),
        Math.floor(lua.lua_tonumber(L, 3)),
        Math.floor(lua.lua_tonumber(L, 4)),
        Math.floor(lua.lua_tonumber(L, 5)),
        Math.floor(lua.lua_tonumber(L, 6)),
        clampByte(lua.lua_tonumber(L, 7)),
        clampByte(lua.lua_tonumber(L, 8)),
        clampByte(lua.lua_tonumber(L, 9)),
      );
      return 0;
    },
    pixel() {
      setPixel(
        Math.floor(lua.lua_tonumber(L, 1)),
        Math.floor(lua.lua_tonumber(L, 2)),
        clampByte(lua.lua_tonumber(L, 3)),
        clampByte(lua.lua_tonumber(L, 4)),
        clampByte(lua.lua_tonumber(L, 5)),
      );
      return 0;
    },
    text() {
      const x = Math.floor(lua.lua_tonumber(L, 1));
      const y = Math.floor(lua.lua_tonumber(L, 2));
      const text = String(luaString(L, 3));
      const size = isNil(L, 4) ? 2 : Math.max(1, Math.floor(lua.lua_tonumber(L, 4)));
      const r = isNil(L, 5) ? 255 : clampByte(lua.lua_tonumber(L, 5));
      const g = isNil(L, 6) ? 255 : clampByte(lua.lua_tonumber(L, 6));
      const b = isNil(L, 7) ? 255 : clampByte(lua.lua_tonumber(L, 7));
      const step = CHAR_BASE * size;
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        const gx = x + i * step;
        for (let row = 0; row < FONT_ROWS; row++) {
          const bits = glyphByte(code, row);
          if (!bits) continue;
          for (let col = 0; col < GLYPH_BITS; col++) {
            if (!(bits & (1 << col))) continue;
            // Font matches the landscape simulator bitmap: each font row is a
            // vertical slice (row→x, col→y) for upright text on portrait.
            const px = gx + row * size;
            const py = y + col * size;
            if (size === 1) setPixel(px, py, r, g, b);
            else {
              for (let sy = 0; sy < size; sy++) {
                for (let sx = 0; sx < size; sx++) setPixel(px + sx, py + sy, r, g, b);
              }
            }
          }
        }
      }
      return 0;
    },
    qr() {
      const x = Math.floor(lua.lua_tonumber(L, 1));
      const y = Math.floor(lua.lua_tonumber(L, 2));
      const scale = isNil(L, 4) ? 4 : Math.max(1, Math.floor(lua.lua_tonumber(L, 4)));
      const r = isNil(L, 5) ? 0 : clampByte(lua.lua_tonumber(L, 5));
      const g = isNil(L, 6) ? 0 : clampByte(lua.lua_tonumber(L, 6));
      const b = isNil(L, 7) ? 0 : clampByte(lua.lua_tonumber(L, 7));
      const side = 29 * scale;
      drawRect(x, y, side, side, r, g, b);
      return 0;
    },
    width() {
      lua.lua_pushinteger(L, WIDTH);
      return 1;
    },
    height() {
      lua.lua_pushinteger(L, HEIGHT);
      return 1;
    },
    flip() {
      return 0;
    },
    set_brightness() {
      return 0;
    },
  };

  const registerModule = (name, fns) => {
    lua.lua_createtable(L, 0, Object.keys(fns).length);
    for (const [key, fn] of Object.entries(fns)) {
      lua.lua_pushjsfunction(L, fn);
      lua.lua_setfield(L, -2, to_luastring(key));
    }
    lua.lua_setglobal(L, to_luastring(name));
  };

  registerModule("screen", screen);
  registerModule("imu", {
    accel() {
      lua.lua_pushnumber(L, 0);
      lua.lua_pushnumber(L, 0);
      lua.lua_pushnumber(L, 1);
      return 3;
    },
    gyro() {
      lua.lua_pushnumber(L, 0);
      lua.lua_pushnumber(L, 0);
      lua.lua_pushnumber(L, 0);
      return 3;
    },
    temp() {
      lua.lua_pushnumber(L, 0);
      return 1;
    },
  });
  registerModule("buzzer", {
    beep() { return 0; },
    tone() { return 0; },
    stop() { return 0; },
  });
  registerModule("button", {
    press_count() {
      lua.lua_pushinteger(L, getButtonPressCount());
      return 1;
    },
  });
  registerModule("log", {
    info() {
      console.log("[lua INFO]", lua.lua_tojsstring(L, 1) ?? "");
      return 0;
    },
    warn() {
      console.warn("[lua WARN]", lua.lua_tojsstring(L, 1) ?? "");
      return 0;
    },
    error() {
      console.error("[lua ERROR]", lua.lua_tojsstring(L, 1) ?? "");
      return 0;
    },
  });
  registerModule("time", {
    is_valid() {
      lua.lua_pushboolean(L, true);
      return 1;
    },
    hour() {
      lua.lua_pushinteger(L, new Date().getHours());
      return 1;
    },
    minute() {
      lua.lua_pushinteger(L, new Date().getMinutes());
      return 1;
    },
    second() {
      lua.lua_pushinteger(L, new Date().getSeconds());
      return 1;
    },
    day_id() {
      lua.lua_pushinteger(L, Math.floor(performance.now() / 86400000));
      return 1;
    },
    has_timezone() {
      lua.lua_pushboolean(L, true);
      return 1;
    },
  });
  registerModule("kv", {
    get() {
      lua.lua_pushnil(L);
      return 1;
    },
    set() {
      lua.lua_pushboolean(L, true);
      return 1;
    },
  });

  if (backends?.rec) {
    const rec = backends.rec;
    registerModule("rec", {
      clips_remaining() {
        lua.lua_pushinteger(L, rec.clips_remaining());
        return 1;
      },
      clips_on_device() {
        lua.lua_pushinteger(L, rec.clips_on_device());
        return 1;
      },
      clips_uploaded() {
        lua.lua_pushinteger(L, rec.clips_uploaded());
        return 1;
      },
      is_recording() {
        lua.lua_pushboolean(L, rec.is_recording());
        return 1;
      },
      is_syncing() {
        lua.lua_pushboolean(L, rec.is_syncing());
        return 1;
      },
      is_playing() {
        lua.lua_pushboolean(L, rec.is_playing());
        return 1;
      },
      amplitude() {
        lua.lua_pushnumber(L, rec.amplitude());
        return 1;
      },
      start() {
        const ok = rec.clips_remaining() > 0 && !rec.is_recording();
        if (ok) void rec.start();
        lua.lua_pushboolean(L, ok);
        return 1;
      },
      stop() {
        const ok = rec.is_recording();
        if (ok) void rec.stop();
        lua.lua_pushboolean(L, ok);
        return 1;
      },
      play() {
        const id = luaString(L, 1);
        if (id) void rec.play(id);
        lua.lua_pushboolean(L, !!id);
        return 1;
      },
      stop_playback() {
        void rec.stop_playback();
        lua.lua_pushboolean(L, true);
        return 1;
      },
      delete_uploaded() {
        void rec.delete_uploaded();
        return 0;
      },
      list() {
        const items = rec.list();
        lua.lua_createtable(L, items.length, 0);
        for (let i = 0; i < items.length; i++) {
          const c = items[i];
          lua.lua_createtable(L, 0, 6);
          pushValue(c.id);
          lua.lua_setfield(L, -2, to_luastring("id"));
          pushValue(c.ts);
          lua.lua_setfield(L, -2, to_luastring("ts"));
          pushValue(c.gps);
          lua.lua_setfield(L, -2, to_luastring("gps"));
          pushValue(c.source);
          lua.lua_setfield(L, -2, to_luastring("source"));
          pushValue(c.duration_ms ?? 10000);
          lua.lua_setfield(L, -2, to_luastring("duration_ms"));
          lua.lua_createtable(L, (c.wave ?? []).length, 0);
          for (let w = 0; w < (c.wave ?? []).length; w++) {
            lua.lua_pushnumber(L, c.wave[w]);
            lua.lua_rawseti(L, -2, w + 1);
          }
          lua.lua_setfield(L, -2, to_luastring("wave"));
          lua.lua_rawseti(L, -2, i + 1);
        }
        return 1;
      },
    });
  }

  if (backends?.gps) {
    const gps = backends.gps;
    registerModule("gps", {
      fix() {
        lua.lua_pushboolean(L, gps.fix());
        return 1;
      },
      pending() {
        lua.lua_pushboolean(L, gps.pending());
        return 1;
      },
      string() {
        lua.lua_pushstring(L, to_luastring(gps.string()));
        return 1;
      },
    });
  }

  if (backends?.power) {
    const power = backends.power;
    registerModule("power", {
      level() {
        lua.lua_pushinteger(L, power.level());
        return 1;
      },
      charging() {
        lua.lua_pushboolean(L, power.charging());
        return 1;
      },
      full() {
        lua.lua_pushboolean(L, power.full());
        return 1;
      },
    });
  }

  const registerGlobal = (name, fn) => {
    lua.lua_pushjsfunction(L, fn);
    lua.lua_setglobal(L, to_luastring(name));
  };

  registerGlobal("rgb", () => {
    const r = Math.floor(Math.max(0, Math.min(1, lua.lua_tonumber(L, 1))) * 255);
    const g = Math.floor(Math.max(0, Math.min(1, lua.lua_tonumber(L, 2))) * 255);
    const b = Math.floor(Math.max(0, Math.min(1, lua.lua_tonumber(L, 3))) * 255);
    lua.lua_pushnumber(L, -((r << 16) | (g << 8) | b));
    return 1;
  });
  registerGlobal("fract", () => {
    const x = lua.lua_tonumber(L, 1);
    lua.lua_pushnumber(L, x - Math.floor(x));
    return 1;
  });
  registerGlobal("beat", () => {
    const bpm = lua.lua_tonumber(L, 1);
    const t = lua.lua_tonumber(L, 2);
    lua.lua_pushnumber(L, t / (60000 / bpm));
    return 1;
  });
  registerGlobal("noise2d", () => {
    const x = lua.lua_tonumber(L, 1);
    const y = lua.lua_tonumber(L, 2);
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = smolHash(xi, yi);
    const v = smolHash(xi + 1, yi);
    const w = smolHash(xi, yi + 1);
    const z = smolHash(xi + 1, yi + 1);
    const a = u + (v - u) * xf;
    const b = w + (z - w) * xf;
    lua.lua_pushnumber(L, (a + (b - a) * yf) * 2 - 1);
    return 1;
  });

  for (const [name, fn] of Object.entries({
    floor: (x) => Math.floor(x),
    ceil: (x) => Math.ceil(x),
    abs: (x) => Math.abs(x),
    sin: (x) => Math.sin(x),
    cos: (x) => Math.cos(x),
    tan: (x) => Math.tan(x),
    sqrt: (x) => Math.sqrt(x),
    min: (a, b) => Math.min(a, b),
    max: (a, b) => Math.max(a, b),
    fmod: (a, b) => a % b,
  })) {
    registerGlobal(name, () => {
      const a = lua.lua_tonumber(L, 1);
      const b = lua.lua_gettop(L) >= 2 ? lua.lua_tonumber(L, 2) : undefined;
      lua.lua_pushnumber(L, fn(a, b));
      return 1;
    });
  }

  const popError = () => {
    const msg = lua.lua_tojsstring(L, -1);
    lua.lua_pop(L, 1);
    return msg ?? "unknown error";
  };

  const pushValue = (value) => {
    if (value == null) lua.lua_pushnil(L);
    else if (typeof value === "number") {
      if (Number.isInteger(value)) lua.lua_pushinteger(L, value);
      else lua.lua_pushnumber(L, value);
    } else if (typeof value === "string") lua.lua_pushstring(L, to_luastring(value));
    else if (typeof value === "boolean") lua.lua_pushboolean(L, value);
    else if (typeof value === "object") {
      const keys = Object.keys(value);
      lua.lua_createtable(L, 0, keys.length);
      for (const key of keys) {
        pushValue(value[key]);
        lua.lua_setfield(L, -2, to_luastring(key));
      }
    }
  };

  const emitEvent = (name, data = {}) => {
    const event = { name, ...data };
    return sandboxApi.call("on_event", makeCtxForEvent(), event);
  };

  const makeCtxForEvent = () => {
    const now = new Date();
    return {
      time_ms: 0,
      trigger_count: 0,
      utc_h: now.getUTCHours(),
      utc_m: now.getUTCMinutes(),
      localtime_h: now.getHours(),
      localtime_m: now.getMinutes(),
      day_id: Math.floor(performance.now() / 86400000),
    };
  };

  const sandboxApi = {
    loadSource(source) {
      if (lauxlib.luaL_loadstring(L, to_luastring(source)) !== 0) return popError();
      if (lua.lua_pcall(L, 0, 0, 0) !== 0) return popError();
      return null;
    },
    call(name, ...args) {
      lua.lua_getglobal(L, to_luastring(name));
      if (!lua.lua_isfunction(L, -1)) {
        lua.lua_pop(L, 1);
        return null;
      }
      for (const arg of args) pushValue(arg);
      if (lua.lua_pcall(L, args.length, 0, 0) !== 0) return popError();
      return null;
    },
    paint() {
      const image = ctx2d.createImageData(WIDTH, HEIGHT);
      const out = image.data;
      for (let i = 0; i < WIDTH * HEIGHT; i++) {
        out[i * 4] = pixels[i * 3];
        out[i * 4 + 1] = pixels[i * 3 + 1];
        out[i * 4 + 2] = pixels[i * 3 + 2];
        out[i * 4 + 3] = 255;
      }
      ctx2d.putImageData(image, 0, 0);
    },
    clearDisplay() {
      for (let i = 0; i < pixels.length; i += 3) {
        pixels[i] = 128;
        pixels[i + 1] = 128;
        pixels[i + 2] = 128;
      }
      ctx2d.fillStyle = "rgb(128,128,128)";
      ctx2d.fillRect(0, 0, WIDTH, HEIGHT);
    },
    dispose() {
      lua.lua_close(L);
    },
    tickIntervalMs: TICK_MS,
    emitEvent,
    backends,
  };

  return sandboxApi;
}
