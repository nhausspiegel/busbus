import type { LatLng } from "../data/types";

/** One drawable run of a route, with the lane it should be offset into. */
export interface OffsetPiece {
  routeId: string;
  path: LatLng[];
  /** 0 is centred. A corridor shared by N routes uses lanes centred on 0:
   *  two routes get -0.5 and +0.5, three get -1, 0, +1. Multiplied by a pixel
   *  constant at render time, so spacing is constant at every zoom. */
  lane: number;
}

/** Resample spacing, metres. Route shapes arrive with wildly different point
 *  densities -- route 3469 has 24 points ~500m apart, route 3302 has 177 about
 *  10m apart -- so comparing raw vertices finds no overlap at all. Everything
 *  is resampled to a common spacing first. */
const STEP_M = 12;

/** Corridor cell size, metres. Two routes counted as sharing a corridor when
 *  their resampled segments fall in the same cell facing the same way. */
const CELL_M = 20;

/** Bearing buckets. Without this, two routes crossing at an intersection would
 *  be treated as sharing that block and pushed apart for no reason. */
const BEARING_BUCKETS = 6;   // 180 degrees / 6 = 30 degree tolerance

const M_PER_DEG_LAT = 111_320;
const mPerDegLng = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

function metresBetween(a: LatLng, b: LatLng): number {
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  const dx = (b.lng - a.lng) * mPerDegLng((a.lat + b.lat) / 2);
  return Math.hypot(dx, dy);
}

/** Walk a polyline emitting a point every STEP_M. Keeps the final vertex so a
 *  route's end is never clipped. */
function resample(shape: LatLng[]): LatLng[] {
  if (shape.length < 2) return shape.slice();
  const out: LatLng[] = [shape[0]!];
  let carry = 0;
  for (let i = 1; i < shape.length; i++) {
    const a = shape[i - 1]!, b = shape[i]!;
    const len = metresBetween(a, b);
    if (len === 0) continue;
    let t = (STEP_M - carry) / len;
    while (t <= 1) {
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
      t += STEP_M / len;
    }
    carry = (carry + len) % STEP_M;
  }
  const last = shape[shape.length - 1]!;
  const tail = out[out.length - 1]!;
  if (metresBetween(tail, last) > 1) out.push(last);
  return out;
}

/** Key identifying "this stretch of this street, in this orientation".
 *  Orientation is taken modulo 180 so a route running the corridor backwards
 *  still shares it -- the Evening CW and CCW loops do exactly that. */
function corridorKey(a: LatLng, b: LatLng): string {
  const midLat = (a.lat + b.lat) / 2;
  const midLng = (a.lng + b.lng) / 2;
  const cellY = Math.round((midLat * M_PER_DEG_LAT) / CELL_M);
  const cellX = Math.round((midLng * mPerDegLng(midLat)) / CELL_M);
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  const dx = (b.lng - a.lng) * mPerDegLng(midLat);
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  deg = ((deg % 180) + 180) % 180;              // direction-agnostic
  const bucket = Math.round(deg / (180 / BEARING_BUCKETS)) % BEARING_BUCKETS;
  return `${cellX},${cellY},${bucket}`;
}

/**
 * Split coincident route lines into lanes so a shared corridor draws as
 * parallel lines rather than one line hiding the rest.
 *
 * Pure and deterministic: lanes are assigned by sorted route id, so the same
 * input always produces the same output and the map does not reshuffle
 * between renders.
 */
export function offsetColinearRoutes(
  routes: { id: string; shape: LatLng[] }[],
): OffsetPiece[] {
  const usable = routes.filter((r) => r.shape.length >= 2);

  // Pass 1: which routes occupy each corridor cell.
  const sampled = new Map<string, LatLng[]>();
  const occupants = new Map<string, Set<string>>();
  for (const r of usable) {
    const pts = resample(r.shape);
    sampled.set(r.id, pts);
    for (let i = 1; i < pts.length; i++) {
      const key = corridorKey(pts[i - 1]!, pts[i]!);
      const set = occupants.get(key) ?? new Set<string>();
      set.add(r.id);
      occupants.set(key, set);
    }
  }

  // Pass 2: per segment, this route's lane within its corridor.
  const pieces: OffsetPiece[] = [];
  for (const r of usable) {
    const pts = sampled.get(r.id)!;
    if (pts.length < 2) continue;

    const lanes: number[] = [];
    for (let i = 1; i < pts.length; i++) lanes.push(laneAt(pts, i, r.id, occupants));
    smoothLanes(lanes);

    let runStart = 0;
    for (let i = 1; i <= lanes.length; i++) {
      if (i < lanes.length && lanes[i] === lanes[runStart]) continue;
      pieces.push({ routeId: r.id, path: pts.slice(runStart, i + 1), lane: lanes[runStart]! });
      runStart = i;
    }
  }
  return pieces;
}

/** Shortest run of segments worth drawing in its own lane. */
const MIN_RUN = 5;

/** Absorb runs too short to be a real corridor.
 *
 *  Cell boundaries make lane assignment flicker: a route crossing the corner
 *  of a shared cell picks up a lane for one 12m segment and drops it again.
 *  Left alone that produced 82 pieces for a 24-point route and a visible
 *  stutter in the line. Short runs adopt the lane before them. */
function smoothLanes(lanes: number[]): void {
  let start = 0;
  while (start < lanes.length) {
    let end = start;
    while (end + 1 < lanes.length && lanes[end + 1] === lanes[start]) end++;
    const runLength = end - start + 1;
    if (runLength < MIN_RUN && start > 0) {
      const prev = lanes[start - 1]!;
      for (let i = start; i <= end; i++) lanes[i] = prev;
    }
    start = end + 1;
  }
  // A short opening run adopts whatever follows it.
  if (lanes.length > MIN_RUN) {
    let firstChange = 0;
    while (firstChange + 1 < lanes.length && lanes[firstChange + 1] === lanes[0]) firstChange++;
    if (firstChange + 1 < MIN_RUN) {
      const next = lanes[firstChange + 1]!;
      for (let i = 0; i <= firstChange; i++) lanes[i] = next;
    }
  }
}

function laneAt(
  pts: LatLng[], i: number, routeId: string, occupants: Map<string, Set<string>>,
): number {
  const key = corridorKey(pts[i - 1]!, pts[i]!);
  const set = occupants.get(key);
  if (!set || set.size <= 1) return 0;
  const ids = [...set].sort();
  const idx = ids.indexOf(routeId);
  // Centre the bundle: 2 routes -> -0.5/+0.5, 3 -> -1/0/+1.
  return idx - (ids.length - 1) / 2;
}
