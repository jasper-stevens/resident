import {
  fetchAudioBlob,
  isConfigured,
  listDeviceIds,
  listRecordings,
  loadSupabaseConfig,
} from "./lib/supabase.js";
import { formatClipLabel } from "./lib/groups.js";
import { drawWalkMap, hitTestClip } from "./lib/walk-map.js";

const els = {
  status: document.getElementById("status"),
  viewDevices: document.getElementById("view-devices"),
  viewDevice: document.getElementById("view-device"),
  viewSetup: document.getElementById("view-setup"),
  deviceList: document.getElementById("device-list"),
  deviceTitle: document.getElementById("device-title"),
  clipList: document.getElementById("clip-list"),
  walkMap: document.getElementById("walk-map"),
};

let cfg = null;
let devices = [];
let clips = [];
let selectedId = null;
let hoveredId = null;
let playingId = null;
let audio = new Audio();
let objectUrl = null;

function setStatus(text, tone = "muted") {
  els.status.textContent = text;
  els.status.dataset.tone = tone;
}

function showView(name) {
  els.viewDevices.classList.toggle("hidden", name !== "devices");
  els.viewDevice.classList.toggle("hidden", name !== "device");
  els.viewSetup.classList.toggle("hidden", name !== "setup");
}

function parseRoute() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const match = hash.match(/^\/device\/(.+)$/);
  if (match) return { view: "device", deviceId: decodeURIComponent(match[1]) };
  return { view: "devices" };
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(ms) {
  const sec = Math.round((Number(ms) || 0) / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderWaveform(wave) {
  const bars = Array.isArray(wave) ? wave : [];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 20; i++) {
    const amp = Number(bars[i]) || 0;
    const el = document.createElement("span");
    const h = amp > 0 ? Math.max(2, Math.round(amp * 18)) : 2;
    el.style.height = `${h}px`;
    if (amp > 0.05) el.classList.add("on");
    frag.appendChild(el);
  }
  return frag;
}

function stopPlayback() {
  audio.pause();
  audio.removeAttribute("src");
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  playingId = null;
}

function deviceKind(deviceId) {
  if (String(deviceId).startsWith("sim-")) return "simulator";
  return "device";
}

function renderDevices() {
  els.deviceList.innerHTML = "";
  if (devices.length === 0) {
    els.deviceList.innerHTML =
      '<p class="empty-state">No recordings yet. Upload from a simulator or M5Stick with Supabase configured.</p>';
    return;
  }
  for (const dev of devices) {
    const kind = deviceKind(dev.device_id);
    const row = document.createElement("a");
    row.className = "device-row";
    row.href = `#/device/${encodeURIComponent(dev.device_id)}`;
    row.innerHTML = `
      <span class="device-id">${escapeHtml(dev.device_id)}</span>
      <span class="device-kind" data-kind="${kind}">${kind}</span>
      <span class="device-meta">${dev.count} clip${dev.count === 1 ? "" : "s"}</span>
      <span class="device-meta">${escapeHtml(fmtTime(dev.latest_at))}</span>
    `;
    els.deviceList.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderClips() {
  els.clipList.innerHTML = "";
  if (clips.length === 0) {
    els.clipList.innerHTML = '<p class="empty-state">No clips for this device.</p>';
    return;
  }

  for (const clip of clips) {
    const label = formatClipLabel(clip.group_id, clip.capture_index);
    const card = document.createElement("div");
    card.className = "clip-card";
    card.dataset.id = clip.id;
    if (clip.id === selectedId) card.classList.add("selected");
    if (clip.id === playingId) card.classList.add("playing");

    const wave = document.createElement("div");
    wave.className = "clip-wave";
    wave.appendChild(renderWaveform(clip.waveform));

    card.innerHTML = `
      <span class="clip-label">${escapeHtml(label)}</span>
      <div class="clip-info">
        <div class="clip-meta">${escapeHtml(fmtTime(clip.created_at))} · ${fmtDuration(clip.duration_ms)}</div>
        <div class="clip-meta">${escapeHtml(clip.gps_label || "no fix")}</div>
      </div>
      <div class="clip-actions"></div>
    `;
    card.querySelector(".clip-info").appendChild(wave);

    const btn = document.createElement("button");
    const isPlaying = clip.id === playingId;
    btn.textContent = isPlaying ? "Stop" : "Play";
    btn.className = isPlaying ? "stop" : "";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void togglePlay(clip);
    });
    card.querySelector(".clip-actions").appendChild(btn);

    card.addEventListener("click", () => {
      selectedId = clip.id;
      renderClips();
      redrawMap();
    });
    card.addEventListener("mouseenter", () => {
      hoveredId = clip.id;
      redrawMap();
    });
    card.addEventListener("mouseleave", () => {
      hoveredId = null;
      redrawMap();
    });

    els.clipList.appendChild(card);
  }
}

function redrawMap() {
  drawWalkMap(els.walkMap, clips, { selectedId, hoveredId });
}

async function togglePlay(clip) {
  if (playingId === clip.id) {
    stopPlayback();
    renderClips();
    return;
  }

  stopPlayback();
  playingId = clip.id;
  selectedId = clip.id;
  renderClips();
  setStatus("Loading audio…", "warn");

  try {
    const blob = await fetchAudioBlob(cfg, clip.storage_path);
    objectUrl = URL.createObjectURL(blob);
    audio.src = objectUrl;
    audio.onended = () => {
      stopPlayback();
      renderClips();
      setStatus("", "muted");
    };
    await audio.play();
    setStatus(`Playing ${formatClipLabel(clip.group_id, clip.capture_index)}`, "ok");
    renderClips();
    redrawMap();
  } catch (err) {
    console.error("[viewer] play failed:", err);
    stopPlayback();
    renderClips();
    setStatus(`Playback failed: ${err.message}`, "error");
  }
}

async function loadDevices() {
  setStatus("Loading devices…", "muted");
  devices = await listDeviceIds(cfg);
  renderDevices();
  setStatus(devices.length ? `${devices.length} device(s)` : "No devices", "ok");
}

async function loadDevice(deviceId) {
  setStatus("Loading recordings…", "muted");
  els.deviceTitle.textContent = deviceId;
  clips = await listRecordings(cfg, deviceId);
  selectedId = null;
  hoveredId = null;
  stopPlayback();
  renderClips();
  redrawMap();
  setStatus(`${clips.length} recording(s)`, "ok");
}

async function route() {
  const routeInfo = parseRoute();

  if (!cfg || !isConfigured(cfg)) {
    showView("setup");
    setStatus("Configure Supabase to continue", "warn");
    return;
  }

  if (routeInfo.view === "devices") {
    showView("devices");
    await loadDevices();
    return;
  }

  showView("device");
  await loadDevice(routeInfo.deviceId);
}

function onMapPointer(e) {
  const id = hitTestClip(els.walkMap, clips, e.clientX, e.clientY);
  if (id) {
    selectedId = id;
    renderClips();
    redrawMap();
  }
}

function init() {
  audio.addEventListener("ended", () => {
    stopPlayback();
    renderClips();
  });

  els.walkMap.addEventListener("click", onMapPointer);
  els.walkMap.addEventListener("mousemove", (e) => {
    const id = hitTestClip(els.walkMap, clips, e.clientX, e.clientY);
    if (id !== hoveredId) {
      hoveredId = id;
      redrawMap();
      els.walkMap.style.cursor = id ? "pointer" : "default";
    }
  });
  els.walkMap.addEventListener("mouseleave", () => {
    hoveredId = null;
    redrawMap();
  });

  window.addEventListener("hashchange", () => void route());
  window.addEventListener("resize", () => redrawMap());

  void (async () => {
    cfg = await loadSupabaseConfig();
    await route();
  })();
}

init();
