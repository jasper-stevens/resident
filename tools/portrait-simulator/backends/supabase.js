let cachedConfig = null;

export async function loadSupabaseConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    const res = await fetch("./supabase.config.json", { cache: "no-store" });
    if (!res.ok) return null;
    const cfg = await res.json();
    if (!cfg?.url || !cfg?.anonKey || !cfg?.bucket) return null;
    cachedConfig = cfg;
    return cfg;
  } catch {
    return null;
  }
}

function headers(cfg, extra = {}) {
  return {
    apikey: cfg.anonKey,
    Authorization: `Bearer ${cfg.anonKey}`,
    ...extra,
  };
}

export async function uploadClip(cfg, deviceId, clip, wavBlob) {
  const storagePath = `${deviceId}/${clip.id}.wav`;
  const uploadUrl = `${cfg.url}/storage/v1/object/${cfg.bucket}/${storagePath}`;

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: headers(cfg, { "Content-Type": "audio/wav", "x-upsert": "true" }),
    body: wavBlob,
  });
  if (!uploadRes.ok) {
    throw new Error(`storage upload failed: ${uploadRes.status}`);
  }

  const row = {
    id: clip.id,
    device_id: deviceId,
    gps_label: clip.gps,
    duration_ms: clip.durationMs,
    waveform: clip.wave,
    storage_path: storagePath,
    group_id: clip.groupId ?? 1,
    capture_index: clip.captureIndex ?? 1,
    uploaded: true,
  };

  const insertRes = await fetch(`${cfg.url}/rest/v1/recordings`, {
    method: "POST",
    headers: headers(cfg, {
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    }),
    body: JSON.stringify(row),
  });
  if (!insertRes.ok) {
    throw new Error(`recordings insert failed: ${insertRes.status}`);
  }

  return storagePath;
}

export async function listCloudClips(cfg, deviceId) {
  const url = new URL(`${cfg.url}/rest/v1/recordings`);
  url.searchParams.set(
    "select",
    "id,device_id,created_at,gps_label,duration_ms,waveform,storage_path,group_id,capture_index",
  );
  url.searchParams.set("device_id", `eq.${deviceId}`);
  url.searchParams.set("order", "group_id.asc,capture_index.asc");

  const res = await fetch(url, { headers: headers(cfg) });
  if (!res.ok) throw new Error(`list recordings failed: ${res.status}`);
  return res.json();
}

export async function fetchAudioBlob(cfg, storagePath) {
  const url = `${cfg.url}/storage/v1/object/${cfg.bucket}/${storagePath}`;
  const res = await fetch(url, { headers: headers(cfg) });
  if (!res.ok) throw new Error(`fetch audio failed: ${res.status}`);
  return res.blob();
}

export function isConfigured(cfg) {
  return !!(cfg?.url && cfg?.anonKey && cfg?.bucket);
}
