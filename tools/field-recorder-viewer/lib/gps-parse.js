const GPS_LABEL_RE = /^([\d.]+)([NS])\s+([\d.]+)([EW])$/i;

export function parseGpsLabel(label) {
  if (!label || typeof label !== "string") return null;
  const trimmed = label.trim();
  if (trimmed === "no fix" || trimmed === "locating…" || trimmed === "unavailable") {
    return null;
  }
  const m = trimmed.match(GPS_LABEL_RE);
  if (!m) return null;
  let lat = parseFloat(m[1]);
  let lon = parseFloat(m[3]);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  if (m[2].toUpperCase() === "S") lat = -lat;
  if (m[4].toUpperCase() === "W") lon = -lon;
  return { lat, lon };
}
