import type { LatLng } from "../data/types";

/**
 * A route's drawable centreline plus, for every point on it, how far sideways
 * that point should be pushed so coincident routes draw side by side.
 *
 * The lane is a NUMBER PER POINT, not per line. That is the whole design.
 * MapLibre's `line-offset` is constant per feature, which forces a choice
 * between three things a transit map needs all of:
 *
 *   a. a line never jumps sideways mid-route,
 *   b. a line sits ON its street where no other route runs there,
 *   c. parallel lines stay the same distance apart at every zoom.
 *
 * One offset per feature can give any two. Splitting a route into per-lane
 * features breaks (a) -- it drew the Connector as two orange lines meeting in
 * an X. One lane for the whole route breaks (b) -- every route floated beside
 * its street even running alone. So the offset moves into the geometry, where
 * it can ramp smoothly from 0 to half a lane over ~80m, and gets rebuilt when
 * the zoom changes to keep (c).
 */
export interface LaneProfile {
  routeId: string;
  /** The route's own shape with points inserted so no gap exceeds STEP_M.
   *  Every added point lies exactly on the source polyline. */
  path: LatLng[];
  /** Lane per point of `path`. 0 is the street centreline; two routes sharing
   *  a corridor get -0.5 and +0.5, three get -1, 0, +1. Smoothed, so it slides
   *  between values rather than stepping. */
  lanes: number[];
  /** Unit normal per point, pointing right of travel, in local metre space. */
  normals: { nx: number; ny: number }[];
}

/** Point spacing, metres. Sets how sharply a lane change can taper and how
 *  finely two routes can be compared -- shapes arrive at wildly different
 *  densities (route 3469 has 24 points ~500m apart, 3302 has 177 at ~10m). */
const STEP_M = 10;

/** Two points this close, heading the same way, are on the same street. */
const CORRIDOR_M = 22;

/** Heading tolerance. Without it two routes crossing at an intersection would
 *  count as sharing that block and be pushed apart for no reason. */
const HEADING_TOL_RAD = (35 * Math.PI) / 180;

/** Moving average over the lane numbers, applied twice. Five points at 10m,
 *  twice, ramps a lane change over about 80m -- roughly a block, which is what
 *  a transit map does when a line enters a shared corridor. */
const SMOOTH_WINDOW = 5;
const SMOOTH_PASSES = 2;

/** Ceiling on the sideways shift, metres. Zoomed right out a pixel is 100m+ of
 *  ground, and a bundle held at its full pixel spacing would smear the network
 *  across the city. Above roughly z13.5 this never binds; below it the lanes
 *  gently close up onto their streets, which is what you want when the lines
 *  are a few pixels apart anyway. */
const MAX_OFFSET_M = 60;

/** Ends this close mean a loop, so smoothing and normals wrap around. Every
 *  Brown route is a loop; not wrapping leaves a visible kink at the seam. */
const CLOSED_M = 30;

const M_PER_DEG_LAT = 111_320;
const mPerDegLng = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

function metresBetween(a: LatLng, b: LatLng): number {
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  const dx = (b.lng - a.lng) * mPerDegLng((a.lat + b.lat) / 2);
  return Math.hypot(dx, dy);
}

/** Insert points so no gap exceeds STEP_M, keeping every source vertex. The
 *  route is not smoothed or approximated -- every point lies on the original
 *  polyline, so corners stay exactly where the shape puts them.
 *
 *  Exported because anything drawn ALONG a route line needs the same treatment:
 *  a three-vertex itinerary snapped onto the drawn line sits on it only at
 *  those three points and cuts straight across every bend between them. */
export function densify(shape: LatLng[]): LatLng[] {
  const out: LatLng[] = [shape[0]!];
  for (let i = 1; i < shape.length; i++) {
    const a = shape[i - 1]!, b = shape[i]!;
    const len = metresBetween(a, b);
    if (len < 1e-6) continue;
    const n = Math.max(1, Math.ceil(len / STEP_M));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
    }
  }
  return out;
}

/** Unit direction of each segment, in metre space. */
function segmentDirs(path: LatLng[]): { dx: number; dy: number }[] {
  const out: { dx: number; dy: number }[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!;
    const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
    const dx = (b.lng - a.lng) * mPerDegLng(a.lat);
    const len = Math.hypot(dx, dy) || 1;
    out.push({ dx: dx / len, dy: dy / len });
  }
  return out;
}

/** Are two headings the same street? Compared modulo 180 degrees, so a route
 *  running the corridor backwards still shares it -- the Evening CW and CCW
 *  loops do exactly that. */
function sameStreet(a: number, b: number): boolean {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d <= HEADING_TOL_RAD;
}

function smooth(v: number[], closed: boolean): number[] {
  const half = (SMOOTH_WINDOW - 1) / 2;
  let cur = v;
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const out = new Array<number>(cur.length);
    for (let i = 0; i < cur.length; i++) {
      let sum = 0, n = 0;
      for (let k = -half; k <= half; k++) {
        const j = closed ? (i + k + cur.length) % cur.length : i + k;
        if (j < 0 || j >= cur.length) continue;
        sum += cur[j]!; n++;
      }
      out[i] = sum / n;
    }
    cur = out;
  }
  return cur;
}

/**
 * Work out, point by point, which routes share each stretch of street, and
 * hand back a lane number per point.
 *
 * Pure and deterministic: routes are processed in sorted id order and lanes
 * come from that same order, so the same input always draws the same map.
 */
export function laneProfiles(routes: { id: string; shape: LatLng[] }[]): LaneProfile[] {
  const usable = routes
    .filter((r) => r.shape.length >= 2)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (usable.length === 0) return [];

  const paths = usable.map((r) => densify(r.shape));
  const dirs = paths.map(segmentDirs);
  const closed = paths.map((p) => metresBetween(p[0]!, p[p.length - 1]!) < CLOSED_M);

  // Heading at each point: the segment leaving it, or the one arriving at the
  // final point. Points are <= STEP_M apart so this is never degenerate.
  const heads = paths.map((p, r) =>
    p.map((_, i) => {
      const d = dirs[r]![Math.min(i, dirs[r]!.length - 1)]!;
      return Math.atan2(d.dy, d.dx);
    }));

  // Spatial hash at the corridor radius, so finding a point's neighbours is a
  // 3x3 cell lookup instead of a scan over every other route.
  const grid = new Map<string, { r: number; i: number }[]>();
  const cellOf = (p: LatLng) => [
    Math.floor((p.lng * mPerDegLng(p.lat)) / CORRIDOR_M),
    Math.floor((p.lat * M_PER_DEG_LAT) / CORRIDOR_M),
  ] as const;
  paths.forEach((p, r) => p.forEach((q, i) => {
    const [cx, cy] = cellOf(q);
    const key = `${cx},${cy}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push({ r, i }); else grid.set(key, [{ r, i }]);
  }));

  return usable.map((route, r) => {
    const path = paths[r]!;
    const raw = path.map((q, i) => {
      // Every route on this stretch of street, this one included, each with the
      // heading it is travelling here.
      const here = new Map<number, number>([[r, heads[r]![i]!]]);
      const [cx, cy] = cellOf(q);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (const n of grid.get(`${cx + ox},${cy + oy}`) ?? []) {
            if (here.has(n.r)) continue;
            if (metresBetween(q, paths[n.r]![n.i]!) > CORRIDOR_M) continue;
            if (!sameStreet(heads[r]![i]!, heads[n.r]![n.i]!)) continue;
            here.set(n.r, heads[n.r]![n.i]!);
          }
        }
      }
      // Rank within the group, in the same sorted id order everywhere, so a
      // route keeps its side of the street from one corridor to the next
      // instead of swapping across as its company changes. Highest rank takes
      // the rightmost side, which puts each of a pair running opposite ways on
      // its OWN right -- the side traffic actually uses, and the side Passio
      // has already drawn its shape on. Order them the other way and the
      // offset drags the two directions together instead of apart.
      const group = [...here.keys()].sort((a, b) => a - b);
      const side = (group.length - 1) / 2 - group.indexOf(r);

      // Sides are shared out in ONE route's frame -- the lowest-numbered in the
      // group -- and then translated into this route's own. A lane means "this
      // far right of MY direction of travel", so the Evening CW and CCW loops,
      // which run the same streets in reverse, would take -0.5 and +0.5 and
      // land on the SAME side of the street. Measured on the real feed that
      // moved them from 1.27px apart to 1.55px, which is to say not at all.
      const reference = here.get(group[0]!)!;
      return Math.cos(heads[r]![i]! - reference) >= 0 ? side : -side;
    });

    const lanes = smooth(raw, closed[r]!);
    const seg = dirs[r]!;
    const normals = path.map((_, i) => {
      // Average the segments either side so the offset line turns corners
      // cleanly rather than kinking at every vertex.
      const before = seg[closed[r]! && i === 0 ? seg.length - 1 : Math.max(0, i - 1)]!;
      const after = seg[closed[r]! && i >= seg.length ? 0 : Math.min(i, seg.length - 1)]!;
      const dx = before.dx + after.dx, dy = before.dy + after.dy;
      const len = Math.hypot(dx, dy);
      // A hairpin cancels the two directions out; fall back to one of them.
      const t = len < 1e-6 ? after : { dx: dx / len, dy: dy / len };
      return { nx: t.dy, ny: -t.dx };      // right of travel
    });

    return { routeId: route.id, path, lanes, normals };
  });
}

/**
 * Push a profile's points into their lanes for the map's current scale.
 *
 * Lane spacing is in screen pixels, so this has to be recomputed whenever the
 * zoom changes -- that is the price of putting the offset in the geometry, and
 * it is what keeps parallel lines the same distance apart at every zoom.
 */
export function offsetPath(p: LaneProfile, metresPerPixel: number, lanePx: number): LatLng[] {
  return p.path.map((q, i) => {
    const lane = p.lanes[i]!;
    if (lane === 0) return q;
    const raw = lane * lanePx * metresPerPixel;
    const d = Math.max(-MAX_OFFSET_M, Math.min(MAX_OFFSET_M, raw));
    const n = p.normals[i]!;
    return {
      lat: q.lat + (n.ny * d) / M_PER_DEG_LAT,
      lng: q.lng + (n.nx * d) / mPerDegLng(q.lat),
    };
  });
}
