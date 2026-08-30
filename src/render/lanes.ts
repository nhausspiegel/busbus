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
  /** The node the road's own canonical direction starts from. */
  forward: string;
}

/**
 * Which end of each segment the lane ladder is measured from.
 *
 * The frame only has to give the routes on a segment a SHARED reference so
 * their order is stable; which of the two ends it picks is arbitrary. What it
 * must never do is reverse along a road, because every route on that segment
 * then mirrors at once and the whole bundle swaps sides mid-street.
 *
 * Three ways to choose it are wrong, each differently:
 *
 * - The travel direction of the lowest-id route is continuous along a shared
 *   stretch but changes across a junction, where the route set changes.
 * - Comparing the segment's own endpoints is independent of the routes but
 *   flips at any bend that turns back across the axis compared -- 19 flips
 *   over 60 run boundaries. There is no fixed reference direction that avoids
 *   this: a street lying along the tie boundary flips segment to segment.
 * - Orienting the road GRAPH as a flow cannot work at all. A junction of three
 *   segments has no orientation that lets all three agree, so it left 16 flips.
 *
 * The mistake in that last one is asking for more than is needed. Nothing
 * requires the third arm of a junction to agree with the other two -- only
 * that a frame not reverse where a route CONTINUES from one segment to the
 * next, which is exactly where a reversal is visible. That is a parity
 * constraint per consecutive pair, and consecutive pairs constrain far fewer
 * things than a flow does.
 *
 * Two routes driving one stretch in opposite directions impose the SAME
 * constraint, so they never conflict. Only an odd cycle can, which is
 * geometry that genuinely cannot be oriented; those are counted and the
 * constraint dropped rather than silently satisfied.
 */
function orientSegments(shapes: Map<string, LatLng[]>): Map<string, string> {
  // Union-find over segments, carrying the parity of each node against its
  // root: 0 means "same orientation as the root", 1 means "reversed".
  const parent = new Map<string, string>(), parity = new Map<string, number>();

  const find = (x: string): { root: string; p: number } => {
    const up = parent.get(x);
    if (up === undefined) { parent.set(x, x); parity.set(x, 0); return { root: x, p: 0 }; }
    if (up === x) return { root: x, p: 0 };
    const r = find(up);
    const p = parity.get(x)! ^ r.p;
    parent.set(x, r.root); parity.set(x, p);          // path compression
    return { root: r.root, p };
  };

  /** Require bit(x) XOR bit(y) === d. False if that contradicts what is known. */
  const join = (x: string, y: string, d: number): boolean => {
    const fx = find(x), fy = find(y);
    if (fx.root === fy.root) return (fx.p ^ fy.p) === d;
    parent.set(fx.root, fy.root);
    parity.set(fx.root, fx.p ^ fy.p ^ d);
    return true;
  };

  /** 0 if travelling a -> b runs along the key's own low-to-high order. */
  const travelBit = (k: string, a: LatLng) => (k.slice(0, k.indexOf("|")) === endKey(a) ? 0 : 1);

  // An odd cycle -- a route that turns back on itself -- cannot have every
  // constraint satisfied, so one per cycle must be dropped, and a dropped
  // constraint is a reversal on screen. WHERE it is dropped is the whole
  // question: taking them in route order drops whichever the walk happens to
  // reach last, which put a reversal on a dead-straight stretch of road.
  //
  // So satisfy the straightest first. A reversal at a hairpin is where the
  // road doubles back anyway; a reversal mid-street is the defect. Sorting by
  // turn angle is not a threshold -- nothing is classified, every constraint
  // is still tried, and only the order changes.
  const K = 111_320;
  const wants: { k0: string; k1: string; d: number; turn: number; seq: string }[] = [];
  for (const routeId of [...shapes.keys()].sort()) {
    const pts = shapes.get(routeId)!;
    const KX = K * Math.cos((pts[0]!.lat * Math.PI) / 180);
    for (let i = 2; i < pts.length; i++) {
      const k0 = segKey(pts[i - 2]!, pts[i - 1]!), k1 = segKey(pts[i - 1]!, pts[i]!);
      if (k0 === k1) continue;                        // a turnaround constrains nothing
      const ux = (pts[i - 1]!.lng - pts[i - 2]!.lng) * KX, uy = (pts[i - 1]!.lat - pts[i - 2]!.lat) * K;
      const vx = (pts[i]!.lng - pts[i - 1]!.lng) * KX, vy = (pts[i]!.lat - pts[i - 1]!.lat) * K;
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      const turn = lu < 1e-9 || lv < 1e-9
        ? 0 : Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
      wants.push({ k0, k1, d: travelBit(k0, pts[i - 2]!) ^ travelBit(k1, pts[i - 1]!),
                   turn, seq: `${routeId}:${String(i).padStart(5, "0")}` });
    }
  }
  wants.sort((a, b) => a.turn - b.turn || (a.seq < b.seq ? -1 : 1));

  contradictions = 0;
  for (const w of wants) if (!join(w.k0, w.k1, w.d)) contradictions++;

  const from = new Map<string, string>();
  for (const pts of shapes.values())
    for (let i = 1; i < pts.length; i++) {
      const k = segKey(pts[i - 1]!, pts[i]!);
      const bar = k.indexOf("|");
      from.set(k, find(k).p === 0 ? k.slice(0, bar) : k.slice(bar + 1));
    }
  return from;
}

/** Consecutive-pair constraints that could not be satisfied at once: odd
 *  cycles in the road graph. Read by the tests; 0 today. */
export let contradictions = 0;

export function laneIndex(shapes: Map<string, LatLng[]>): Map<string, SegmentLanes> {
  const oriented = orientSegments(shapes);
  const on = new Map<string, Set<string>>();
  for (const [routeId, pts] of shapes)
    for (let i = 1; i < pts.length; i++) {
      const k = segKey(pts[i - 1]!, pts[i]!);
      (on.get(k) ?? on.set(k, new Set()).get(k)!).add(routeId);
    }
  return new Map([...on].map(([k, set]) =>
    [k, { users: [...set].sort(), forward: oriented.get(k)! }]));
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

/**
 * Let each route hold the side it is already on.
 *
 * Ordering the routes on a segment by id never crosses two lines, but it is
 * indifferent to what came before: a route's slot is decided by WHO ITS
 * NEIGHBOURS ARE, not by where it already was. Purple paired with blue takes
 * index 0; a block later, paired with green instead, the same purple takes
 * index 1 and jumps to the other side of the road -- with the group the same
 * size both times. Reported at Angell, and it is not the centring, it is the
 * ordering.
 *
 * There is no formula for the right order; it is a preference each line has,
 * settled against its neighbours. So each segment solves a small assignment:
 * every route wishes for the side it holds on the segments either side of this
 * one, and the ordering chosen is the one that grants those wishes most
 * closely. Sorting by the wish is not enough -- a sort cannot satisfy two
 * routes that want the same side, it just pushes the conflict next door, which
 * measured WORSE than doing nothing. With at most a handful of routes on any
 * segment the orderings can simply all be tried.
 *
 * Repeating that settles into an arrangement where a line running straight
 * through a junction stays put and the lines joining it slot in around it.
 * Centring is untouched: only the ORDER is being chosen.
 */
function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i++) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const p of permutations(rest)) out.push([xs[i]!, ...p]);
  }
  return out;
}

function relaxOrder(
  shapes: Map<string, LatLng[]>, lanes: Map<string, SegmentLanes>, rounds = 8,
): void {
  const dirSign = (a: LatLng, seg: SegmentLanes) => (seg.forward === endKey(a) ? 1 : -1);
  /** Each route's segments in travel order, with the node it enters by and how
   *  straight it is running through -- 1 dead ahead, 0 at a right-angle turn.
   *
   *  This is what settles an argument. Two routes on one segment often both
   *  want the same side, and one has to give; without a reason, the loser is
   *  whichever sorts first, so a line running dead straight through a junction
   *  gets shoved aside by one that just turned into it. Going straight is the
   *  stronger claim, so it is weighted as one. */
  const walk = new Map<string, { key: string; from: LatLng; straight: number }[]>();
  const K = 111_320;
  for (const [routeId, pts] of shapes) {
    const KX = K * Math.cos((pts[0]!.lat * Math.PI) / 180);
    const P = (p: LatLng) => ({ x: p.lng * KX, y: p.lat * K });
    const w: { key: string; from: LatLng; straight: number }[] = [];
    for (let i = 1; i < pts.length; i++) {
      let straight = 1;
      if (i > 1) {
        const a = P(pts[i - 2]!), b = P(pts[i - 1]!), c = P(pts[i]!);
        const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
        const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
        straight = lu < 1e-9 || lv < 1e-9
          ? 1 : Math.max(0, (ux * vx + uy * vy) / (lu * lv));
      }
      w.push({ key: segKey(pts[i - 1]!, pts[i]!), from: pts[i - 1]!, straight });
    }
    walk.set(routeId, w);
  }

  for (let round = 0; round < rounds; round++) {
    // The side each route currently sits on, in its OWN direction of travel --
    // what a rider sees it keep, and the thing that must not jump.
    const side = new Map<string, number>();
    for (const [routeId, w] of walk)
      for (const { key, from } of w) {
        const seg = lanes.get(key);
        if (!seg) continue;
        const lane = seg.users.indexOf(routeId) - (seg.users.length - 1) / 2;
        side.set(`${routeId}@${key}`, lane * dirSign(from, seg));
      }

    // What each route would like here: the side it holds on either neighbour.
    const wish = new Map<string, { want: number[]; weight: number }>();
    for (const [routeId, w] of walk)
      w.forEach(({ key, straight }, i) => {
        const want: number[] = [];
        for (const n of [i - 1, i + 1]) {
          const nb = w[n];
          if (!nb) continue;
          const v = side.get(`${routeId}@${nb.key}`);
          if (v !== undefined) want.push(v);
        }
        // Straightness of the whole passage: a route that turns in here, or
        // turns out again immediately, has the weaker claim either way.
        const out = w[i + 1]?.straight ?? 1;
        if (want.length) wish.set(`${routeId}@${key}`, { want, weight: straight * out });
      });

    let moved = 0;
    for (const [key, seg] of lanes) {
      if (seg.users.length < 2) continue;
      const entry = new Map<string, LatLng>();
      for (const [routeId, w] of walk)
        for (const step of w) if (step.key === key) entry.set(routeId, step.from);

      let best: string[] | null = null, bestCost = Infinity;
      for (const order of permutations(seg.users)) {
        let cost = 0;
        order.forEach((routeId, idx) => {
          const from = entry.get(routeId);
          if (!from) return;
          const w = wish.get(`${routeId}@${key}`);
          if (!w) return;
          const lane = idx - (order.length - 1) / 2;
          const mine = lane * dirSign(from, seg);
          for (const v of w.want) cost += Math.abs(mine - v) * w.weight;
        });
        // Ties go to the id order, so the result is deterministic and two
        // routes with nothing to say never trade places between runs.
        if (cost < bestCost - 1e-9) { bestCost = cost; best = order; }
      }
      if (best && best.join(",") !== seg.users.join(",")) { seg.users = best; moved++; }
    }
    if (moved === 0) break;                              // settled
  }
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
/**
 * A lane change shorter than a junction is not a lane change.
 *
 * The lane is decided per road segment, and at a corner the crossing route
 * genuinely shares a metre or two of the same OSM way -- so membership goes
 * 2 -> 3 -> 2 over seven metres, everyone re-centres, and a seven-metre
 * feature is emitted at its own offset. Every feature boundary is a join
 * MapLibre cannot build, because it can only join within one feature: a nub
 * under round caps, a notch under butt caps. Changing the cap only changed
 * which artefact appeared.
 *
 * Measured, the six of these run 4.0-7.1m and the shortest real street block
 * is 34.2m, so nothing sits in the gap to be classified wrongly. World metres
 * on purpose: this is a fact about how OSM draws a junction, not about the
 * display, so it must not move with zoom -- unlike the offset itself, which is
 * only ever pixels.
 */
const JUNCTION_M = 25;

/** Per-segment offsets for one route, with junction stubs absorbed. */
function laneOffsets(
  lanes: Map<string, SegmentLanes>, routeId: string, pts: LatLng[], gapPx: number,
): number[] {
  const off = pts.slice(1).map((b, i) => offsetFor(lanes, routeId, pts[i]!, b, gapPx));
  const K = 111_320, KX = K * Math.cos((pts[0]!.lat * Math.PI) / 180);
  const segM = off.map((_, i) =>
    Math.hypot((pts[i + 1]!.lng - pts[i]!.lng) * KX, (pts[i + 1]!.lat - pts[i]!.lat) * K));

  for (;;) {
    const runs: { s: number; e: number; m: number }[] = [];
    for (let i = 0; i < off.length; i++) {
      const last = runs[runs.length - 1];
      if (last && Math.abs(off[i]! - off[last.s]!) < 1e-9) { last.e = i; last.m += segM[i]!; }
      else runs.push({ s: i, e: i, m: segM[i]! });
    }
    if (runs.length < 2) return off;

    let worst = -1;
    for (let r = 0; r < runs.length; r++)
      if (runs[r]!.m < JUNCTION_M && (worst < 0 || runs[r]!.m < runs[worst]!.m)) worst = r;
    if (worst < 0) return off;

    // Absorbed by whichever neighbour holds more road, so a stub never decides
    // the lane of the street it interrupts.
    const prev = runs[worst - 1], next = runs[worst + 1];
    const take = !prev ? next! : !next ? prev : prev.m >= next.m ? prev : next;
    const v = off[take.s]!;
    for (let i = runs[worst]!.s; i <= runs[worst]!.e; i++) off[i] = v;
  }
}

export function laneRuns(shapes: Map<string, LatLng[]>, gapPx: number): LaneRun[] {
  const lanes = laneIndex(shapes);
  relaxOrder(shapes, lanes);
  const out: LaneRun[] = [];

  for (const [routeId, pts] of shapes) {
    if (pts.length < 2) continue;
    const off = laneOffsets(lanes, routeId, pts, gapPx);
    let path: LatLng[] = [pts[0]!];
    let current = off[0]!;

    for (let i = 1; i < pts.length; i++) {
      if (Math.abs(off[i - 1]! - current) > 1e-9) {
        if (path.length >= 2) out.push({ routeId, offsetPx: current, path });
        path = [pts[i - 1]!];              // overlap by one node so runs meet
        current = off[i - 1]!;
      }
      path.push(pts[i]!);
    }
    if (path.length >= 2) out.push({ routeId, offsetPx: current, path });
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
  relaxOrder(shapes, lanes);
  const K = 111_320;
  const out = new Map<string, LatLng[]>();
  for (const [routeId, pts] of shapes) {
    if (pts.length < 2) { out.set(routeId, pts.slice()); continue; }
    const KX = K * Math.cos((pts[0]!.lat * Math.PI) / 180);
    const off = laneOffsets(lanes, routeId, pts, gapPx);
    const moved = pts.map((p, i) => {
      const j = i === 0 ? 1 : i;               // the segment this vertex is on
      const a = pts[j - 1]!, b = pts[j]!;
      const offM = off[j - 1]! * mpp;
      const ax = a.lng * KX, ay = a.lat * K, bx = b.lng * KX, by = b.lat * K;
      const L = Math.hypot(bx - ax, by - ay) || 1;
      const nx = (by - ay) / L, ny = -(bx - ax) / L;
      return { lat: (p.lat * K + ny * offM) / K, lng: (p.lng * KX + nx * offM) / KX };
    });
    out.set(routeId, moved);
  }
  return out;
}
