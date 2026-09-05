import type { LatLng } from "../data/types";

/**
 * Draw routes as lanes along the roads they share.
 *
 * This replaces the bundler. That code decided "are these two lines the same
 * street?" per vertex, at render time, from proximity and angle -- because
 * nothing in the data said which road a line was on. Nine mechanisms existed to
 * survive that guess and each produced a symptom: a lane gap held in METRES
 * that grew from 3.7px at zoom 13 to 13.5px at zoom 18, a corner radius clamped
 * dead by resampling, apexes cut off inside corners.
 *
 * Routes now arrive snapped to OSM road centrelines as sequences of shared
 * nodes, so two routes down one street have IDENTICAL coordinates there. "Same
 * street" is an equality on a segment, and the only question left is which lane
 * a route is in and how many pixels wide a lane is.
 *
 * The displacement itself is left to MapLibre's `line-offset`, which is
 * specified in PIXELS and applied on the GPU with proper joins. That is why
 * there is no geometry in this file. Computing offset geometry by hand needed
 * something else to survive it at every turn -- a miter, then a bevel, then
 * simplification to stop a 33m offset self-intersecting 10m of road detail --
 * and each addition was a fresh way to be wrong. Nothing here is recomputed per
 * zoom: a lane offset is a constant number of pixels.
 */

/** A segment is the unordered pair of node coordinates. Shared nodes give
 *  byte-identical floats, so string equality is exact -- no tolerance. */
function segKey(a: LatLng, b: LatLng): string {
  const p = `${a.lng},${a.lat}`, q = `${b.lng},${b.lat}`;
  return p < q ? `${p}|${q}` : `${q}|${p}`;
}

const endKey = (p: LatLng) => `${p.lng},${p.lat}`;

export interface SegmentLanes {
  /** Routes on this segment, sorted by id. */
  users: string[];
  /** The node this segment is entered from by the side-defining route. */
  forward: string;
}

/**
 * Which routes use each segment, in a fixed order, and which way is "right".
 *
 * Sorted by route id so a route keeps the same side of the road along its whole
 * length; without a stable key the order changes segment by segment and lines
 * swap sides at junctions for no reason.
 *
 * `forward` records the travel direction of the LOWEST-id route on the segment.
 * MapLibre offsets to the right of a feature's own direction, so two routes
 * driving one street in opposite directions would otherwise put lane 0 and lane
 * 1 on the SAME side -- measured at exactly 0.00px between the two Evening
 * routes at every zoom. Pinning the side to one route's direction makes it a
 * property of the road, which is what it has to be.
 */
export function laneIndex(shapes: Map<string, LatLng[]>): Map<string, SegmentLanes> {
  const on = new Map<string, { users: Set<string>; from: Map<string, string> }>();
  for (const [routeId, pts] of shapes)
    for (let i = 1; i < pts.length; i++) {
      const k = segKey(pts[i - 1]!, pts[i]!);
      const e = on.get(k) ?? on.set(k, { users: new Set(), from: new Map() }).get(k)!;
      e.users.add(routeId);
      e.from.set(routeId, endKey(pts[i - 1]!));
    }
  return new Map([...on].map(([k, e]) => {
    const users = [...e.users].sort();
    return [k, { users, forward: e.from.get(users[0]!)! }];
  }));
}

/** The signed lane offset, in pixels, for one route on one segment. */
function offsetFor(
  lanes: Map<string, SegmentLanes>, routeId: string, a: LatLng, b: LatLng, gapPx: number,
): number {
  const seg = lanes.get(segKey(a, b));
  const users = seg?.users ?? [routeId];
  // Centred on the road: a route alone sits ON the centreline, two straddle it.
  const lane = (users.indexOf(routeId) - (users.length - 1) / 2) * gapPx;
  return (seg ? seg.forward === endKey(a) : true) ? lane : -lane;
}

/** One drawable run: consecutive segments on which a route holds one lane. */
export interface LaneRun {
  routeId: string;
  /** Signed offset in DEVICE PIXELS. Constant; never recomputed per zoom. */
  offsetPx: number;
  path: LatLng[];
}

/**
 * Split every route into runs of constant lane.
 *
 * A route changes lane only where another route joins or leaves, so a run is a
 * maximal stretch carrying the same set of routes. Runs overlap by one node so
 * consecutive runs meet on screen instead of leaving a gap.
 */
export function laneRuns(shapes: Map<string, LatLng[]>, gapPx: number): LaneRun[] {
  const lanes = laneIndex(shapes);
  const out: LaneRun[] = [];

  for (const [routeId, pts] of shapes) {
    if (pts.length < 2) continue;
    let path: LatLng[] = [pts[0]!];
    let current: number | null = null;

    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!, b = pts[i]!;
      const off = offsetFor(lanes, routeId, a, b, gapPx);
      if (current === null) current = off;
      else if (Math.abs(off - current) > 1e-9) {
        if (path.length >= 2) out.push({ routeId, offsetPx: current, path });
        path = [a];                        // overlap by one node so runs meet
        current = off;
      }
      path.push(b);
    }
    if (path.length >= 2 && current !== null)
      out.push({ routeId, offsetPx: current, path });
  }
  return out;
}

/**
 * Where a point on a route's centreline is actually drawn.
 *
 * Stops and buses must sit on the line a rider can see, not on the centreline
 * underneath it, so they need the same displacement MapLibre applies to the
 * line. Everything else about them is unchanged.
 */
export function laneSnap(
  shapes: Map<string, LatLng[]>, lanes: Map<string, SegmentLanes>,
  routeId: string, at: LatLng, gapPx: number, mpp: number,
): LatLng {
  const pts = shapes.get(routeId);
  if (!pts || pts.length < 2) return at;
  const K = 111_320, KX = K * Math.cos((at.lat * Math.PI) / 180);
  const P = (p: LatLng) => ({ x: p.lng * KX, y: p.lat * K });
  const t0 = P(at);

  let best = Infinity, bi = 1, bx = t0.x, by = t0.y;
  for (let i = 1; i < pts.length; i++) {
    const a = P(pts[i - 1]!), b = P(pts[i]!);
    const vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy;
    const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((t0.x - a.x) * vx + (t0.y - a.y) * vy) / L2));
    const qx = a.x + t * vx, qy = a.y + t * vy;
    const d = Math.hypot(t0.x - qx, t0.y - qy);
    if (d < best) { best = d; bi = i; bx = qx; by = qy; }
  }
  const a = pts[bi - 1]!, b = pts[bi]!;
  const offM = offsetFor(lanes, routeId, a, b, gapPx) * mpp;
  const A = P(a), B = P(b);
  const L = Math.hypot(B.x - A.x, B.y - A.y) || 1;
  // Right of travel, matching MapLibre's sign convention.
  const nx = (B.y - A.y) / L, ny = -(B.x - A.x) / L;
  return { lat: (by + ny * offM) / K, lng: (bx + nx * offM) / KX };
}

/**
 * The lane lines as GEOMETRY, for snapping only.
 *
 * MapLibre draws the offset itself, so nothing here is rendered. But stops,
 * buses and the ridden slice of a trip all have to land on the line a rider can
 * SEE, and that line is the centreline displaced. Each vertex is moved by its
 * own segment's offset -- no joins, no miters, because a stop only needs to be
 * within a pixel of the stroke, not to reproduce it.
 */
export function laneApprox(
  shapes: Map<string, LatLng[]>, gapPx: number, mpp: number,
): Map<string, LatLng[]> {
  const lanes = laneIndex(shapes);
  const K = 111_320;
  const out = new Map<string, LatLng[]>();
  for (const [routeId, pts] of shapes) {
    if (pts.length < 2) { out.set(routeId, pts.slice()); continue; }
    const KX = K * Math.cos((pts[0]!.lat * Math.PI) / 180);
    const moved = pts.map((p, i) => {
      const j = i === 0 ? 1 : i;               // the segment this vertex is on
      const a = pts[j - 1]!, b = pts[j]!;
      const offM = offsetFor(lanes, routeId, a, b, gapPx) * mpp;
      const ax = a.lng * KX, ay = a.lat * K, bx = b.lng * KX, by = b.lat * K;
      const L = Math.hypot(bx - ax, by - ay) || 1;
      const nx = (by - ay) / L, ny = -(bx - ax) / L;
      return { lat: (p.lat * K + ny * offM) / K, lng: (p.lng * KX + nx * offM) / KX };
    });
    out.set(routeId, moved);
  }
  return out;
}

/**
 * Every bead of one station, as ONE object.
 *
 * A station is a place, not a per-route coincidence. Placing each bead on its
 * own route's line looks right while the routes share a street and falls apart
 * the moment they do not: at a corner -- Fones Alley, Pembroke Campus -- the
 * beads land on two different streets and the bar between them runs diagonally
 * across the junction, which is what "the stations are not unified" means.
 *
 * So the station picks ONE reference segment, the nearest to it among the
 * routes it serves, projects onto that once, and lays its lines out along that
 * segment's normal. The result is collinear, perpendicular to the street, and
 * spaced exactly `gapPx` per lane -- by construction, at every zoom, with
 * nothing measured or searched for afterwards.
 *
 * The cost is honest and small: a route that meets the station from the
 * crossing street has its bead a few metres off its own line. A station is one
 * place; drawing it as one is worth more than each dot being on its own line at
 * the two junctions where those disagree.
 */
export function stationLanes(
  shapes: Map<string, LatLng[]>, lanes: Map<string, SegmentLanes>,
  routeIds: string[], at: LatLng, gapPx: number, mpp: number,
): Map<string, LatLng> {
  const out = new Map<string, LatLng>();
  if (routeIds.length === 0) return out;
  const K = 111_320, KX = K * Math.cos((at.lat * Math.PI) / 180);
  const P = (p: LatLng) => ({ x: p.lng * KX, y: p.lat * K });
  const t0 = P(at);

  // The reference segment: nearest to the station across every route it serves.
  let best = Infinity, ref: { a: LatLng; b: LatLng; x: number; y: number } | null = null;
  for (const routeId of routeIds) {
    const pts = shapes.get(routeId);
    if (!pts || pts.length < 2) continue;
    for (let i = 1; i < pts.length; i++) {
      const a = P(pts[i - 1]!), b = P(pts[i]!);
      const vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy;
      const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((t0.x - a.x) * vx + (t0.y - a.y) * vy) / L2));
      const qx = a.x + t * vx, qy = a.y + t * vy;
      const d = Math.hypot(t0.x - qx, t0.y - qy);
      if (d < best) { best = d; ref = { a: pts[i - 1]!, b: pts[i]!, x: qx, y: qy }; }
    }
  }
  // No geometry at all: spread along an arbitrary axis rather than stacking
  // every bead on one point. The bar between them is what gives an interchange
  // its background, and a zero-length one draws nothing.
  if (!ref) ref = { a: at, b: { lat: at.lat + 1e-4, lng: at.lng }, x: t0.x, y: t0.y };

  const A = P(ref.a), B = P(ref.b);
  const L = Math.hypot(B.x - A.x, B.y - A.y) || 1;
  const nx = (B.y - A.y) / L, ny = -(B.x - A.x) / L;

  // Ordered the way a segment orders its users, so where the station's routes
  // DO share the reference street the beads land on their own lines.
  const seg = lanes.get(segKey(ref.a, ref.b));
  const users = seg?.users ?? [];
  const order = [...routeIds].sort((p, q) => {
    const i = users.indexOf(p), j = users.indexOf(q);
    if (i >= 0 && j >= 0) return i - j;
    if (i >= 0) return -1;
    if (j >= 0) return 1;
    return p < q ? -1 : 1;
  });
  // ANCHORED on the lanes the station's own routes HOLD, not centred on the
  // road. The beads are one gap apart whatever this term does; it only decides
  // where that ladder sits, and centring it on the road is right only when the
  // station serves every route on the street. Anchoring on the first held lane
  // puts every route that uses the reference segment exactly on the line it is
  // drawn as -- only a route arriving from the crossing street takes a slot
  // past the end of the block. Centring on the mean instead left the one held
  // route at Cushing & Thayer 2.50px off its own line at every zoom.
  const held = order.map((r) => users.indexOf(r)).filter((i) => i >= 0)
    .map((i) => i - (users.length - 1) / 2);
  // Held lanes with a hole in them cannot all be hit by evenly spaced beads, so
  // fall back to centring on their mean. Spacing and perpendicularity are the
  // invariants and neither term touches them.
  const base = held.length && held.every((v, i) => !i || v === held[i - 1]! + 1)
    ? held[0]!
    : held.reduce((t, v) => t + v, 0) / (held.length || 1) - (order.length - 1) / 2;
  const flip = seg && seg.forward !== endKey(ref.a) ? -1 : 1;

  order.forEach((routeId, i) => {
    const off = (base + i) * gapPx * mpp * flip;
    out.set(routeId, { lat: (ref!.y + ny * off) / K, lng: (ref!.x + nx * off) / KX });
  });
  return out;
}
