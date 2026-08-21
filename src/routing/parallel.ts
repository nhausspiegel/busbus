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
 * Give each route a lane so coincident routes draw side by side instead of one
 * hiding the rest.
 *
 * A route keeps ONE lane for its whole length. Assigning lanes per segment
 * looked correct in the abstract and terrible in practice: wherever a route
 * gained or lost a corridor-mate its line jumped sideways by the full lane
 * width, which on the real map drew the Connector as two parallel orange lines
 * meeting in an X. Transit maps hold a line's offset end to end, and so does
 * this.
 *
 * Pure and deterministic: lanes are assigned in sorted route-id order, so the
 * same input always produces the same output and the map never reshuffles.
 */
export function offsetColinearRoutes(
  routes: { id: string; shape: LatLng[] }[],
): OffsetPiece[] {
  const usable = routes.filter((r) => r.shape.length >= 2);
  if (usable.length === 0) return [];

  // Which routes share any corridor with which. Resampling to a common
  // spacing first is what makes this work at all -- shapes arrive at wildly
  // different densities and raw vertices never coincide.
  const occupants = new Map<string, Set<string>>();
  for (const r of usable) {
    const pts = resample(r.shape);
    for (let i = 1; i < pts.length; i++) {
      const key = corridorKey(pts[i - 1]!, pts[i]!);
      const set = occupants.get(key) ?? new Set<string>();
      set.add(r.id);
      occupants.set(key, set);
    }
  }

  const shares = new Map<string, Set<string>>(usable.map((r) => [r.id, new Set<string>()]));
  for (const set of occupants.values()) {
    if (set.size < 2) continue;
    for (const a of set)
      for (const b of set)
        if (a !== b) shares.get(a)?.add(b);
  }

  // Smallest slot not taken by a route this one shares with. Routes that never
  // share anything all sit in slot 0, on the street centreline.
  const slot = new Map<string, number>();
  for (const r of [...usable].sort((a, b) => a.id.localeCompare(b.id))) {
    const taken = new Set<number>();
    for (const other of shares.get(r.id) ?? [])
      if (slot.has(other)) taken.add(slot.get(other)!);
    let s = 0;
    while (taken.has(s)) s++;
    slot.set(r.id, s);
  }

  // Centre each bundle so a pair straddles the street rather than both sitting
  // to one side of it.
  const maxSlot = Math.max(...slot.values());
  return usable.map((r) => ({
    routeId: r.id,
    path: r.shape,
    lane: slot.get(r.id)! - maxSlot / 2,
  }));
}

