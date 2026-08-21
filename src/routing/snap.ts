import type { LatLng } from "../data/types";

const M_PER_DEG_LAT = 111_320;
const mPerDegLng = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

/** Local planar coordinates in metres, good enough over a campus. */
function toXY(p: LatLng, originLat: number): { x: number; y: number } {
  return { x: p.lng * mPerDegLng(originLat), y: p.lat * M_PER_DEG_LAT };
}
function toLatLng(x: number, y: number, originLat: number): LatLng {
  return { lat: y / M_PER_DEG_LAT, lng: x / mPerDegLng(originLat) };
}

/**
 * Put a vehicle on the line it is actually drawn as riding.
 *
 * GPS puts Brown's buses 5-45m off their own polyline -- Passio's own feed
 * carries a `snapDistance` for the same reason -- so a bus left where the feed
 * reports it floats beside its route.
 *
 * `path` is the line as DRAWN, lane offset already baked into its geometry by
 * offsetPath(). Snapping to the raw shape instead would put every bus on the
 * centreline, beside its own line, by construction.
 */
export function snapToPath(position: LatLng, path: LatLng[]): LatLng {
  if (path.length < 2) return position;
  const originLat = position.lat;
  const P = toXY(position, originLat);

  let bestX = 0, bestY = 0, bestDist = Infinity;
  for (let i = 1; i < path.length; i++) {
    const A = toXY(path[i - 1]!, originLat), B = toXY(path[i]!, originLat);
    const dx = B.x - A.x, dy = B.y - A.y;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / lenSq));
    const x = A.x + dx * t, y = A.y + dy * t;
    const dist = Math.hypot(P.x - x, P.y - y);
    if (dist < bestDist) { bestDist = dist; bestX = x; bestY = y; }
  }
  return toLatLng(bestX, bestY, originLat);
}

/** Ground distance one screen pixel covers at this latitude and zoom. */
export function metresPerPixel(lat: number, zoom: number): number {
  return (156_543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}
