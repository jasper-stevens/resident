export function captureIndexToLetter(captureIndex) {
  const n = Number(captureIndex) || 1;
  if (n < 1) return "A";
  if (n <= 26) return String.fromCharCode(64 + n);
  // 27 -> AA, 28 -> AB, …
  let s = "";
  let v = n;
  while (v > 0) {
    v -= 1;
    s = String.fromCharCode(65 + (v % 26)) + s;
    v = Math.floor(v / 26);
  }
  return s;
}

export function formatClipLabel(groupId, captureIndex) {
  const g = String(groupId).padStart(3, "0");
  return `${g}.${captureIndexToLetter(captureIndex)}`;
}

export function compareClips(a, b) {
  const ga = a.group_id ?? a.groupId ?? 0;
  const gb = b.group_id ?? b.groupId ?? 0;
  if (ga !== gb) return ga - gb;
  const ca = a.capture_index ?? a.captureIndex ?? 0;
  const cb = b.capture_index ?? b.captureIndex ?? 0;
  return ca - cb;
}

export function maxGroupId(clips) {
  return clips.reduce((m, c) => Math.max(m, c.group_id ?? c.groupId ?? 0), 0);
}
