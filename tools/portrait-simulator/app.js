import { createSandbox } from "./sandbox.js?v=15";
import { createRecorderBackend } from "./backends/recorder.js";
import { createPower } from "./backends/power.js";

const STORAGE_KEY = "resident-portrait-device-id";
const LAST_APP_KEY = "resident-portrait-last-app";
const WIFI_KEY = "resident-portrait-wifi";
const DEFAULT_RELAY = "resident.inanimate.tech";

const els = {
  canvas: document.getElementById("screen"),
  status: document.getElementById("status"),
  appName: document.getElementById("app-name"),
  deviceId: document.getElementById("device-id"),
  relay: document.getElementById("relay"),
  connectBtn: document.getElementById("connect-btn"),
  copyBtn: document.getElementById("copy-btn"),
  reloadBtn: document.getElementById("reload-btn"),
  wifiBtn: document.getElementById("wifi-btn"),
  dropZone: document.getElementById("drop-zone"),
  btnA: document.getElementById("btn-a"),
  btnB: document.getElementById("btn-b"),
};

let sandbox = null;
let recorder = null;
let power = null;
let tickTimer = null;
let ws = null;
let startedAt = performance.now();
let lastTickAt = performance.now();
let triggerCount = 0;
let wifiConnected = false;
const buttonCounts = [0, 0];

function makeDeviceId() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `sim-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function relayHost() {
  return (els.relay.value || DEFAULT_RELAY).replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function wsUrl(deviceId) {
  return `wss://${relayHost()}/devices/${deviceId}?type=simulator`;
}

function setStatus(text, tone = "muted") {
  els.status.textContent = text;
  els.status.dataset.tone = tone;
}

function setAppName(text) {
  els.appName.textContent = text;
}

function readLastApp() {
  try {
    const raw = localStorage.getItem(LAST_APP_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data?.label === "string" && typeof data?.source === "string") return data;
  } catch {
    /* ignore corrupt storage */
  }
  return null;
}

function saveLastApp(label, source) {
  try {
    localStorage.setItem(LAST_APP_KEY, JSON.stringify({ label, source }));
    els.reloadBtn.disabled = false;
  } catch (err) {
    console.warn("[portrait-sim] could not persist last app:", err);
  }
}

function updateReloadButton() {
  els.reloadBtn.disabled = !readLastApp();
}

function updateWifiButton() {
  els.wifiBtn.textContent = wifiConnected ? "WiFi: on" : "WiFi: off";
  els.wifiBtn.dataset.on = wifiConnected ? "true" : "false";
}

function makeCtx() {
  const now = new Date();
  return {
    time_ms: Math.floor(performance.now() - startedAt),
    trigger_count: triggerCount,
    utc_h: now.getUTCHours(),
    utc_m: now.getUTCMinutes(),
    localtime_h: now.getHours(),
    localtime_m: now.getMinutes(),
    day_id: Math.floor(performance.now() / 86400000),
  };
}

function assertRuntime() {
  if (!globalThis.fengari) {
    throw new Error("Lua runtime missing — hard-refresh the page (Cmd+Shift+R)");
  }
}

function paintIdleScreen() {
  const ctx = els.canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "rgb(128,128,128)";
    ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
  }
  setAppName("idle");
}

function emitEvent(name, data = {}) {
  if (!sandbox) return;
  const err = sandbox.call("on_event", makeCtx(), { name, ...data });
  if (err) console.error("[portrait-sim] on_event:", err);
  sandbox.paint();
}

function ensurePower() {
  if (!power) power = createPower();
  return power;
}

function ensureRecorder() {
  if (recorder) return recorder;
  recorder = createRecorderBackend({
    emitEvent,
    getDeviceId: () => els.deviceId.value.trim(),
    getWifiConnected: () => wifiConnected,
  });
  return recorder;
}

function stopApp() {
  if (tickTimer !== null) {
    window.clearInterval(tickTimer);
    tickTimer = null;
  }
  sandbox?.dispose();
  sandbox = null;
  paintIdleScreen();
}

function ensureSandbox() {
  assertRuntime();
  if (sandbox) return sandbox;
  const rec = ensureRecorder();
  const pwr = ensurePower();
  sandbox = createSandbox(els.canvas, {
    getButtonPressCount: () => buttonCounts[0] + buttonCounts[1],
    backends: {
      rec,
      gps: {
        fix: () => rec.gps_fix(),
        pending: () => rec.gps_pending(),
        string: () => rec.gps_string(),
      },
      power: pwr,
    },
  });
  return sandbox;
}

function startTicking() {
  if (tickTimer !== null) window.clearInterval(tickTimer);
  lastTickAt = performance.now();
  tickTimer = window.setInterval(() => {
    if (!sandbox) return;
    recorder?.tick();
    const now = performance.now();
    const dt = now - lastTickAt;
    lastTickAt = now;
    const err = sandbox.call("on_tick", makeCtx(), dt);
    if (err) console.error("[portrait-sim] on_tick:", err);
    sandbox.paint();
  }, sandbox.tickIntervalMs);
}

function loadApp(label, source) {
  stopApp();
  buttonCounts[0] = 0;
  buttonCounts[1] = 0;
  triggerCount = 0;
  startedAt = performance.now();

  try {
    const s = ensureSandbox();
    const err = s.loadSource(source);
    if (err) {
      console.error(`[portrait-sim] load ${label}:`, err);
      setStatus(`Load failed: ${err}`, "error");
      return false;
    }

    const initErr = s.call("init", makeCtx());
    if (initErr) console.error(`[portrait-sim] init ${label}:`, initErr);

    if (wifiConnected) {
      s.call("on_event", makeCtx(), { name: "wifi_connected" });
      void recorder?.onWifiConnected();
    }

    s.paint();
    startTicking();
    setAppName(`${label}.lua`);
    setStatus("Running", "ok");
    saveLastApp(label, source);
    return true;
  } catch (err) {
    console.error(`[portrait-sim] load ${label}:`, err);
    setStatus(`Runtime error: ${err.message}`, "error");
    return false;
  }
}

function pressButton(index) {
  if (!sandbox) return;
  buttonCounts[index] += 1;
  triggerCount += 1;
  const event = {
    name: "button",
    index,
    count: buttonCounts[index],
    ts_ms: Math.floor(performance.now() - startedAt),
    from: "",
  };
  const err = sandbox.call("on_event", makeCtx(), event);
  if (err) console.error("[portrait-sim] on_event:", err);
  sandbox.paint();
}

function setWifi(on) {
  wifiConnected = on;
  localStorage.setItem(WIFI_KEY, on ? "1" : "0");
  updateWifiButton();
  if (!sandbox) return;
  if (on) {
    emitEvent("wifi_connected");
    void recorder?.onWifiConnected();
  } else {
    emitEvent("wifi_disconnected");
    void recorder?.onWifiDisconnected();
  }
}

function toggleWifi() {
  setWifi(!wifiConnected);
}

function connect() {
  const deviceId = els.deviceId.value.trim() || makeDeviceId();
  els.deviceId.value = deviceId;
  localStorage.setItem(STORAGE_KEY, deviceId);

  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }

  setStatus("Connecting…", "warn");
  els.connectBtn.disabled = true;

  let socket;
  try {
    socket = new WebSocket(wsUrl(deviceId));
  } catch (err) {
    setStatus(`Connection failed: ${err.message}`, "error");
    els.connectBtn.disabled = false;
    return;
  }
  ws = socket;

  socket.addEventListener("open", () => {
    setStatus("Connected — push apps to this device ID", "ok");
    els.connectBtn.disabled = false;
  });

  socket.addEventListener("close", () => {
    if (ws === socket) {
      setStatus("Disconnected", "error");
      els.connectBtn.disabled = false;
    }
  });

  socket.addEventListener("error", () => {
    setStatus("Connection error — check relay host and network", "error");
    els.connectBtn.disabled = false;
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload?.type === "app" && typeof payload.code === "string") {
      const name =
        typeof payload.name === "string" && payload.name
          ? payload.name.replace(/\.lua$/, "")
          : "pushed";
      loadApp(name, payload.code);
    }
  });
}

async function loadFile(file) {
  if (!file.name.endsWith(".lua")) {
    setStatus("Drop a .lua file", "warn");
    return;
  }
  const source = await file.text();
  loadApp(file.name.replace(/\.lua$/, ""), source);
}

function init() {
  const saved = localStorage.getItem(STORAGE_KEY);
  els.deviceId.value = saved || makeDeviceId();
  els.relay.value = DEFAULT_RELAY;
  wifiConnected = localStorage.getItem(WIFI_KEY) === "1";
  updateWifiButton();
  paintIdleScreen();

  try {
    assertRuntime();
    setStatus("Tap Connect, then push from your editor", "muted");
  } catch (err) {
    setStatus(err.message, "error");
  }

  updateReloadButton();
  ensureRecorder();

  els.connectBtn.addEventListener("click", connect);
  els.wifiBtn.addEventListener("click", toggleWifi);
  els.reloadBtn.addEventListener("click", () => {
    const last = readLastApp();
    if (!last) {
      setStatus("No app loaded yet — push or drop a .lua file first", "warn");
      return;
    }
    if (loadApp(last.label, last.source)) {
      setStatus(`Reloaded ${last.label}.lua`, "ok");
      if (wifiConnected) void recorder?.onWifiConnected();
    }
  });
  els.copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(els.deviceId.value.trim());
      setStatus("Device ID copied", "ok");
    } catch {
      setStatus("Could not copy device ID", "error");
    }
  });

  els.btnA.addEventListener("click", () => pressButton(0));
  els.btnB.addEventListener("click", () => pressButton(1));

  for (const el of [els.dropZone, document.body]) {
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      els.dropZone.classList.add("drag-over");
    });
    el.addEventListener("dragleave", () => els.dropZone.classList.remove("drag-over"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      els.dropZone.classList.remove("drag-over");
      const file = e.dataTransfer?.files?.[0];
      if (file) void loadFile(file);
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "a" || e.key === "A") pressButton(0);
    if (e.key === "b" || e.key === "B") pressButton(1);
  });
}

init();
