let cachedConfig = null;

export async function loadSupabaseConfig() {
  if (cachedConfig) return cachedConfig;
  if (typeof window !== "undefined" && window.__SUPABASE__) {
    const cfg = window.__SUPABASE__;
    if (cfg?.url && cfg?.anonKey && cfg?.bucket) {
      cachedConfig = cfg;
      return cfg;
    }
  }
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

export async function listDeviceIds(cfg) {
  const url = new URL(`${cfg.url}/rest/v1/recordings`);
  url.searchParams.set("select", "device_id,created_at");
  url.searchParams.set("order", "created_at.desc");

  const res = await fetch(url, { headers: headers(cfg) });
  if (!res.ok) throw new Error(`list devices failed: ${res.status}`);

  const rows = await res.json();
  const byDevice = new Map();
  for (const row of rows) {
    const id = row.device_id;
    if (!id) continue;
    const existing = byDevice.get(id);
    if (!existing) {
      byDevice.set(id, { device_id: id, count: 1, latest_at: row.created_at });
    } else {
      existing.count += 1;
    }
  }
  return [...byDevice.values()].sort((a, b) =>
    String(b.latest_at ?? "").localeCompare(String(a.latest_at ?? "")),
  );
}

export async function listRecordings(cfg, deviceId) {
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
