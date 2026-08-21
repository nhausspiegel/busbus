import { haversineMeters } from "./walk";
import type { LatLng } from "../data/types";

/** Index of the shape point closest to `p`. */
function nearestIndex(shape: LatLng[], p: LatLng): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < shape.length; i++) {
    const d = haversineMeters(shape[i]!, p);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

const M_PER_DEG_LAT = 111_320;
const mPerDegLng = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

/**
 * The closest point ON a route's polyline to where a bus says it is.
 *
 * GPS puts Brown's buses a few metres off their own shape -- measured, 0.1 to
 * 7m -- which is invisible zoomed out and a whole dot's width at street zoom.
 * Passio's private feed carries a `snapDistance` field, so they snap too.
 *
 * Projects onto the SEGMENTS, not to the nearest vertex: route 3469's vertices
 * are ~500m apart, so snapping to a vertex would move a bus a quarter of a
 * kilometre. Takes the shape as drawn, so the bus lands on the line the rider
 * can see, at every zoom, with no dependence on scale.
 */
export function snapToShape(position: LatLng, shape: LatLng[]): LatLng {
  if (shape.length < 2) return position;
  const lat0 = position.lat;
  const x = (p: LatLng) => p.lng * mPerDegLng(lat0), y = (p: LatLng) => p.lat * M_PER_DEG_LAT;
  const px = x(position), py = y(position);

  let bestX = 0, bestY = 0, bestD = Infinity;
  for (let i = 1; i < shape.length; i++) {
    const ax = x(shape[i - 1]!), ay = y(shape[i - 1]!);
    const dx = x(shape[i]!) - ax, dy = y(shape[i]!) - ay;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
    const qx = ax + dx * t, qy = ay + dy * t;
    const d = Math.hypot(px - qx, py - qy);
    if (d < bestD) { bestD = d; bestX = qx; bestY = qy; }
  }
  return { lat: bestY / M_PER_DEG_LAT, lng: bestX / mPerDegLng(lat0) };
}

/** The portion of a route's polyline actually ridden, from one stop to another.
 *
 *  Drawing the whole route shape for a two-stop hop is misleading -- the rider
 *  is not going round the loop. Shuttle routes are loops, so when the alight
 *  point comes before the boarding point in the shape the correct segment wraps
 *  around the end rather than running backwards. */
export function sliceShape(shape: LatLng[], from: LatLng, to: LatLng): LatLng[] {
  if (shape.length < 2) return [];
  const a = nearestIndex(shape, from);
  const b = nearestIndex(shape, to);
  if (a === b) return [];
  if (a < b) return shape.slice(a, b + 1);
  // Loop wrap: ride to the end of the shape, then on from the start.
  return [...shape.slice(a), ...shape.slice(0, b + 1)];
}
