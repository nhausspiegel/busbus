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

const lerp = (a: LatLng, b: LatLng, t: number): LatLng =>
  ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });

/** Where a point falls on the shape: `t` of the way along the segment ending
 *  at vertex `i`. Projects onto the SEGMENTS, not to the nearest vertex: route
 *  3469's vertices are ~500m apart, so snapping to a vertex would move a bus a
 *  quarter of a kilometre. The plane is flat-earth about the point's own
 *  latitude, which is linear in lat/lng, so lerping the result back in degrees
 *  lands on the same coordinate. */
function locate(shape: LatLng[], p: LatLng): { i: number; t: number } {
  const lat0 = p.lat;
  const x = (q: LatLng) => q.lng * mPerDegLng(lat0), y = (q: LatLng) => q.lat * M_PER_DEG_LAT;
  const px = x(p), py = y(p);
  let best = { i: 1, t: 0 }, bestD = Infinity;
  for (let i = 1; i < shape.length; i++) {
    const ax = x(shape[i - 1]!), ay = y(shape[i - 1]!);
    const dx = x(shape[i]!) - ax, dy = y(shape[i]!) - ay;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
    const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
    if (d < bestD) { bestD = d; best = { i, t }; }
  }
  return best;
}

/**
 * The closest point ON a route's polyline to where a bus says it is.
 *
 * GPS puts Brown's buses a few metres off their own shape -- measured, 0.1 to
 * 7m -- which is invisible zoomed out and a whole dot's width at street zoom.
 * Passio's private feed carries a `snapDistance` field, so they snap too.
 *
 * Takes the shape as drawn, so the bus lands on the line the rider
 * can see, at every zoom, with no dependence on scale.
 */
export function snapToShape(position: LatLng, shape: LatLng[]): LatLng {
  if (shape.length < 2) return position;
  const { i, t } = locate(shape, position);
  return lerp(shape[i - 1]!, shape[i]!, t);
}

/** How far apart two fixes can be ALONG the shape and still be one bus moving.
 *  Brown's routes run the same street twice in places, a few tens of metres
 *  apart, so a jittering fix can snap onto the other pass: metres away, most
 *  of a lap along the line. Past this, the two fixes are not one journey and
 *  the shape is the wrong thing to follow. */
const MAX_GLIDE_M = 1000;

/**
 * The coordinate a fraction `t` of the way from one fix to the next, along the
 * route's own polyline.
 *
 * Passio's vehicle feed only speaks every ten seconds, so a marker set straight
 * from it teleports. Walking the shape between the two fixes instead means a
 * bus rounding a corner goes round it rather than cutting through the block.
 *
 * Falls back to a straight line whenever following the shape would be a lie:
 * no shape, a fix that lands BEHIND the last one (a parked bus's GPS jitter,
 * which read as forwards is a lap of the loop at speed), or a path too long to
 * be one bus's motion. The straight line is also what crosses the seam of a
 * loop shape, where the last coordinate and the first are the same place.
 */
export function pointAlongShape(shape: LatLng[], from: LatLng, to: LatLng, t: number): LatLng {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const path = forwardPath(shape, from, to);
  if (!path) return lerp(from, to, t);

  const legs = path.slice(1).map((p, i) => haversineMeters(path[i]!, p));
  const total = legs.reduce((a, b) => a + b, 0);
  if (total > MAX_GLIDE_M) return lerp(from, to, t);

  let left = total * t;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    if (left <= leg) return lerp(path[i]!, path[i + 1]!, leg === 0 ? 0 : left / leg);
    left -= leg;
  }
  return to;
}

/** from -> the vertices between -> to, or null if `to` is not ahead of `from`. */
function forwardPath(shape: LatLng[], from: LatLng, to: LatLng): LatLng[] | null {
  if (shape.length < 2) return null;
  const a = locate(shape, from), b = locate(shape, to);
  if (b.i < a.i || (b.i === a.i && b.t <= a.t)) return null;
  return [from, ...shape.slice(a.i, b.i), to];
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
