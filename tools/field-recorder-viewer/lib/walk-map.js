import { parseGpsLabel } from "./gps-parse.js";

const GROUP_COLORS = [
  "#5b8cff",
  "#3dd68c",
  "#f5c451",
  "#ff6b9d",
  "#9b7bff",
  "#4ecdc4",
];

function groupColor(groupId) {
  const idx = (Number(groupId) || 1) - 1;
  return GROUP_COLORS[((idx % GROUP_COLORS.length) + GROUP_COLORS.length) % GROUP_COLORS.length];
}

function prepareClips(clips) {
  return clips.map((clip) => {
    const coords = parseGpsLabel(clip.gps_label);
    return { clip, coords };
  });
}

function computeBounds(points) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const { coords } of points) {
    minLat = Math.min(minLat, coords.lat);
    maxLat = Math.max(maxLat, coords.lat);
    minLon = Math.min(minLon, coords.lon);
    maxLon = Math.max(maxLon, coords.lon);
  }
  const latSpan = maxLat - minLat || 0.0001;
  const lonSpan = maxLon - minLon || 0.0001;
  const padLat = latSpan * 0.1;
  const padLon = lonSpan * 0.1;
  return {
    minLat: minLat - padLat,
    maxLat: maxLat + padLat,
    minLon: minLon - padLon,
    maxLon: maxLon + padLon,
  };
}

function project(coords, bounds, width, height, margin) {
  const innerW = width - margin * 2;
  const innerH = height - margin * 2;
  const lonSpan = bounds.maxLon - bounds.minLon || 1;
  const latSpan = bounds.maxLat - bounds.minLat || 1;
  const x = margin + ((coords.lon - bounds.minLon) / lonSpan) * innerW;
  const y = margin + ((bounds.maxLat - coords.lat) / latSpan) * innerH;
  return { x, y };
}

function groupClips(clips) {
  const groups = new Map();
  for (const clip of clips) {
    const gid = clip.group_id ?? 1;
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid).push(clip);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (a.capture_index ?? 0) - (b.capture_index ?? 0));
  }
  return groups;
}

export function drawWalkMap(canvas, clips, { selectedId = null, hoveredId = null } = {}) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 400;
  const cssH = canvas.clientHeight || 400;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const width = cssW;
  const height = cssH;
  const margin = 24;

  ctx.fillStyle = "#0a0c10";
  ctx.fillRect(0, 0, width, height);

  const prepared = prepareClips(clips);
  const withCoords = prepared.filter((p) => p.coords);

  if (withCoords.length === 0) {
    ctx.fillStyle = "#8b93a7";
    ctx.font = "14px IBM Plex Sans, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No GPS fixes", width / 2, height / 2);
    return;
  }

  const bounds = computeBounds(withCoords);
  const posById = new Map();

  for (const { clip, coords } of withCoords) {
    posById.set(clip.id, project(coords, bounds, width, height, margin));
  }

  const groups = groupClips(clips);

  for (const [groupId, groupClipsList] of groups) {
    const pathPoints = groupClipsList
      .map((c) => posById.get(c.id))
      .filter(Boolean);
    if (pathPoints.length < 2) continue;

    ctx.beginPath();
    ctx.moveTo(pathPoints[0].x, pathPoints[0].y);
    for (let i = 1; i < pathPoints.length; i++) {
      ctx.lineTo(pathPoints[i].x, pathPoints[i].y);
    }
    ctx.strokeStyle = groupColor(groupId);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  for (const { clip, coords } of withCoords) {
    if (!coords) continue;
    const pos = posById.get(clip.id);
    if (!pos) continue;

    const isSelected = clip.id === selectedId;
    const isHovered = clip.id === hoveredId;
    const radius = isSelected ? 7 : isHovered ? 6 : 4;
    const color = groupColor(clip.group_id ?? 1);

    if (isSelected || isHovered) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius + 4, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? "rgba(91, 140, 255, 0.25)" : "rgba(91, 140, 255, 0.15)";
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = isSelected ? "#fff" : "rgba(255,255,255,0.5)";
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.stroke();
  }
}

export function hitTestClip(canvas, clips, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;

  const prepared = prepareClips(clips);
  const withCoords = prepared.filter((p) => p.coords);
  if (withCoords.length === 0) return null;

  const bounds = computeBounds(withCoords);
  const width = canvas.clientWidth || 400;
  const height = canvas.clientHeight || 400;
  const margin = 24;

  let best = null;
  let bestDist = Infinity;

  for (const { clip, coords } of withCoords) {
    const pos = project(coords, bounds, width, height, margin);
    const dist = Math.hypot(pos.x - x, pos.y - y);
    if (dist <= 12 && dist < bestDist) {
      bestDist = dist;
      best = clip.id;
    }
  }
  return best;
}
