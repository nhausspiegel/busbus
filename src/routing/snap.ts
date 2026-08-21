import type { LatLng } from "../data/types";
import type { OffsetPiece } from "./parallel";

const M_PER_DEG_LAT = 111_320;
const mPerDegLng = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

/** Local planar coordinates in metres, good enough over a campus. */
function toXY(p: LatLng, originLat: number): { x: number; y: number } {
  return { x: p.lng * mPerDegLng(originLat), y: p.lat * M_PER_DEG_LAT };
}
function toLatLng(x: number, y: number, originLat: number): LatLng {
  return { lat: y / M_PER_DEG_LAT, lng: x / mPerDegLng(originLat) };
}

interface Projection { point: LatLng; distance: number; dx: number; dy: number }

/** Closest point on one segment, with the segment's direction. */
function projectOntoSegment(p: LatLng, a: LatLng, b: LatLng, originLat: number): Projection {
  const P = toXY(p, originLat), A = toXY(a, originLat), B = toXY(b, originLat);
  const dx = B.x - A.x, dy = B.y - A.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / lenSq));
  const x = A.x + dx * t, y = A.y + dy * t;
  return {
    point: toLatLng(x, y, originLat),
    distance: Math.hypot(P.x - x, P.y - y),
    dx, dy,
  };
}

/**
 * Put a vehicle on the line it is actually drawn as riding.
 *
 * Two corrections, both needed for a bus to look like it is on its route:
 *
 * 1. Snap to the route shape. GPS puts Brown's buses 5-45m off their own
 *    polyline; Passio's own feed carries a `snapDistance` for the same reason.
 * 2. Displace into the route's lane. Coincident routes are drawn side by side
 *    with a pixel offset, so a bus left on the unoffset centreline sits beside
 *    its own line by construction -- which is exactly what it looks like.
 *
 * The lane displacement is in PIXELS on screen, so it has to be converted with
 * the map's current metres-per-pixel and recomputed as the rider zooms.
 */
export function snapToLane(
  position: LatLng,
  routeId: string,
  pieces: OffsetPiece[],
  metresPerPixel: number,
  lanePx: number,
): LatLng {
  const mine = pieces.filter((p) => p.routeId === routeId && p.path.length >= 2);
  if (mine.length === 0) return position;

  let best: Projection | null = null;
  let bestLane = 0;
  for (const piece of mine) {
    for (let i = 1; i < piece.path.length; i++) {
      const proj = projectOntoSegment(position, piece.path[i - 1]!, piece.path[i]!, position.lat);
      if (!best || proj.distance < best.distance) {
        best = proj;
        bestLane = piece.lane;
      }
    }
  }
  if (!best) return position;
  if (bestLane === 0) return best.point;

  // Perpendicular to the segment, matching MapLibre's line-offset convention:
  // a positive offset moves the line to the right of its direction of travel.
  const len = Math.hypot(best.dx, best.dy);
  if (len === 0) return best.point;
  const shift = bestLane * lanePx * metresPerPixel;
  const nx = best.dy / len, ny = -best.dx / len;

  const base = toXY(best.point, position.lat);
  return toLatLng(base.x + nx * shift, base.y + ny * shift, position.lat);
}

/** Ground distance one screen pixel covers at this latitude and zoom. */
export function metresPerPixel(lat: number, zoom: number): number {
  return (156_543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}
