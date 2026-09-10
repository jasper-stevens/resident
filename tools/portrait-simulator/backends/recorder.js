import { createAudioEngine, N_BARS } from "./audio.js";
import { createStorage, MAX_CLIPS } from "./storage.js";
import { createGps } from "./gps.js";
import { formatClipLabel, maxGroupId } from "./groups.js";
import {
  fetchAudioBlob,
  isConfigured,
  listCloudClips,
  loadSupabaseConfig,
  uploadClip,
} from "./supabase.js";

const REC_DUR_MS = 10000;

function makeId() {
  return crypto.randomUUID();
}

function mergeWaves(live, stored, n = N_BARS) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.max(Number(live[i]) || 0, Number(stored[i]) || 0));
  }
  return out;
}

function fmtTs(date = new Date()) {
  const h = date.getHours();
  const m = date.getMinutes();
  const hs = h < 10 ? `0${h}` : String(h);
  const ms = m < 10 ? `0${m}` : String(m);
  return `Today ${hs}:${ms}`;
}

function toListEntry(c, source, extra = {}) {
  const groupId = c.groupId ?? c.group_id ?? 1;
  const captureIndex = c.captureIndex ?? c.capture_index ?? 1;
  const sortMsRaw =
    c.sort_ms ?? c.createdAt ?? (c.created_at ? Date.parse(c.created_at) : null);
  const sortMs = Number.isFinite(sortMsRaw) ? sortMsRaw : 0;
  return {
    id: c.id,
    label: formatClipLabel(groupId, captureIndex),
    group_id: groupId,
    capture_index: captureIndex,
    ts: c.ts,
    gps: c.gps,
    wave: c.wave ?? [],
    source,
    duration_ms: c.durationMs ?? c.duration_ms ?? REC_DUR_MS,
    uploaded: !!c.uploaded,
    sort_ms: sortMs,
    ...extra,
  };
}

export function createRecorderBackend({ emitEvent, getDeviceId, getWifiConnected, gps: gpsIn }) {
  const audio = createAudioEngine();
  const storage = createStorage();
  const gps = gpsIn ?? createGps();

  let syncing = false;
  let recordTimer = null;
  let liveWave = [];
  let cloudClips = [];
  let supabaseCfg = null;
  let playingId = null;

  function cloudMaxGroup() {
    return maxGroupId(
      cloudClips.map((c) => ({
        group_id: c.groupId ?? c.group_id ?? 0,
      })),
    );
  }

  const state = {
    remaining: MAX_CLIPS,
    onDevice: 0,
    uploaded: 0,
    listCache: [],
  };

  async function refreshState() {
    await storage.syncGroupState(cloudMaxGroup());
    state.remaining = await storage.clipsRemaining();
    state.onDevice = await storage.clipsOnDevice();
    state.uploaded = await storage.clipsUploaded();
    state.listCache = await buildList();
  }

  async function buildList() {
    const local = (await storage.list()).map((c) => toListEntry(c, "local"));

    const localIds = new Set(local.map((c) => c.id));
    const merged = [...local];

    if (getWifiConnected()) {
      for (const c of cloudClips) {
        if (!localIds.has(c.id)) {
          merged.push(toListEntry(c, "cloud", { storagePath: c.storagePath }));
        }
      }
    }

    merged.sort((a, b) => (b.sort_ms ?? 0) - (a.sort_ms ?? 0));
    return merged;
  }

  async function init() {
    await storage.init();
    gps.start();
    supabaseCfg = await loadSupabaseConfig();
    if (getWifiConnected()) {
      await refreshCloud();
    }
    await refreshState();
  }

  async function refreshCloud() {
    if (!getWifiConnected() || !isConfigured(supabaseCfg)) {
      cloudClips = [];
      return;
    }
    try {
      const rows = await listCloudClips(supabaseCfg, getDeviceId());
      cloudClips = rows.map((r) => ({
        id: r.id,
        ts: r.created_at ? String(r.created_at).slice(0, 16).replace("T", " ") : "?",
        gps: r.gps_label ?? "no fix",
        wave: Array.isArray(r.waveform) ? r.waveform : [],
        durationMs: r.duration_ms ?? REC_DUR_MS,
        groupId: r.group_id ?? 1,
        captureIndex: r.capture_index ?? 1,
        source: "cloud",
        storagePath: r.storage_path,
        created_at: r.created_at,
      }));
    } catch (err) {
      console.warn("[rec] cloud list failed:", err);
      cloudClips = [];
    }
  }

  async function finishRecording(manual = false) {
    if (recordTimer) {
      clearTimeout(recordTimer);
      recordTimer = null;
    }
    const result = await audio.stopRecording();
    if (!result) return false;

    const id = makeId();
    const audioBytes = await result.wavBlob.arrayBuffer();
    const { groupId, captureIndex } = await storage.nextCaptureSlot(cloudMaxGroup());
    const clip = {
      id,
      ts: fmtTs(),
      gps: gps.string(),
      wave: mergeWaves(liveWave, result.wave),
      durationMs: manual ? result.durationMs : REC_DUR_MS,
      groupId,
      captureIndex,
      source: "local",
      uploaded: false,
      createdAt: Date.now(),
      audioBlob: result.wavBlob,
      audioBytes,
      mimeType: result.mimeType ?? "audio/wav",
    };

    await storage.save(clip);
    liveWave = [];

    emitEvent("recording_finished", {
      id: clip.id,
      label: formatClipLabel(groupId, captureIndex),
      group_id: groupId,
      capture_index: captureIndex,
      ts: clip.ts,
      gps: clip.gps,
      wave: clip.wave,
      duration_ms: clip.durationMs,
    });

    await refreshState();

    if (getWifiConnected()) {
      void syncPending();
    }
    return true;
  }

  async function syncPending() {
    if (syncing || !getWifiConnected() || !isConfigured(supabaseCfg)) return;
    const local = await storage.list();
    const pending = local.filter((c) => !c.uploaded);
    if (pending.length === 0) {
      await refreshCloud();
      await refreshState();
      return;
    }

    syncing = true;
    emitEvent("sync_started", {});

    let uploaded = 0;
    for (const clip of pending) {
      try {
        const blob = clip.audioBlob;
        if (!blob) continue;
        await uploadClip(supabaseCfg, getDeviceId(), clip, blob);
        await storage.markUploaded(clip.id);
        uploaded += 1;
        emitEvent("upload_complete", { id: clip.id });
      } catch (err) {
        console.warn("[rec] upload failed:", clip.id, err);
      }
    }

    syncing = false;
    emitEvent("sync_finished", {});
    await refreshCloud();
    if (uploaded > 0) {
      await storage.advanceGroup(cloudMaxGroup());
    }
    await refreshState();
  }

  const api = {
    clips_remaining() {
      return state.remaining;
    },

    clips_on_device() {
      return state.onDevice;
    },

    clips_uploaded() {
      return state.uploaded;
    },

    is_recording() {
      return audio.isRecording();
    },

    is_syncing() {
      return syncing;
    },

    is_playing() {
      return audio.isPlaying();
    },

    wifi_up() {
      return getWifiConnected();
    },

    amplitude() {
      return audio.getAmplitude();
    },

    async start() {
      if (audio.isRecording()) return false;
      const remaining = await storage.clipsRemaining();
      if (remaining <= 0) return false;

      try {
        await audio.ensureMic();
      } catch (err) {
        console.error("[rec] mic permission denied:", err);
        return false;
      }

      liveWave = [];
      const ok = await audio.startRecording();
      if (!ok) return false;

      emitEvent("recording_started", {});

      recordTimer = setTimeout(() => {
        void finishRecording(false);
      }, REC_DUR_MS);

      return true;
    },

    async stop() {
      if (!audio.isRecording()) return false;
      return finishRecording(true);
    },

    async play(id) {
      if (!id) return false;

      const local = await storage.get(id);
      const blob =
        local?.audioBlob ??
        (local?.audioBytes ? new Blob([local.audioBytes], { type: local.mimeType ?? "audio/wav" }) : null);
      if (blob && blob.size > 0) {
        playingId = id;
        const ok = await audio.playBlob(blob, () => {
          playingId = null;
          emitEvent("playback_finished", { id });
        });
        if (!ok) console.warn("[rec] local play failed:", id);
        return ok;
      }

      if (!getWifiConnected()) return false;

      const cloud = cloudClips.find((c) => c.id === id);
      if (!cloud?.storagePath || !isConfigured(supabaseCfg)) return false;

      try {
        const blob = await fetchAudioBlob(supabaseCfg, cloud.storagePath);
        playingId = id;
        await audio.playBlob(blob, () => {
          playingId = null;
          emitEvent("playback_finished", { id });
        });
        return true;
      } catch (err) {
        console.warn("[rec] cloud play failed:", err);
        return false;
      }
    },

    async stop_playback() {
      await audio.stopPlayback();
      const id = playingId;
      playingId = null;
      if (id) emitEvent("playback_finished", { id });
      return true;
    },

    async delete_uploaded() {
      await storage.deleteUploaded();
      if (getWifiConnected()) await refreshCloud();
      await refreshState();
      return true;
    },

    list() {
      return state.listCache;
    },

    sampleWaveform() {
      if (!audio.isRecording()) return;
      const amp = audio.getAmplitude();
      if (liveWave.length < N_BARS) {
        liveWave.push(amp);
      }
    },

    async onWifiConnected() {
      await refreshCloud();
      await syncPending();
      await refreshState();
    },

    async onWifiDisconnected() {
      cloudClips = [];
      await audio.stopPlayback();
      await refreshState();
    },

    tick() {
      if (audio.isRecording()) {
        audio.tick();
        api.sampleWaveform();
      }
    },

    gps_fix() {
      return gps.fix();
    },

    gps_pending() {
      return gps.pending();
    },

    gps_string() {
      return gps.string();
    },
  };

  void init();

  return api;
}
