/**
 * Routes as a graph of shared corridors, not as a pile of independent lines.
 *
 * The previous design asked "which other routes are near me?" at every 10m
 * sample, sorted the answer, and displaced that vertex accordingly. Nothing
 * made two adjacent samples agree, so the lane assignment oscillated -- on
 * route 3302, eighteen times around one loop, roughly every 30m -- and each
 * flip stepped the line sideways by a full lane gap. Those steps are the
 * spurs, the acute wedges and the kinks in a straight street.
 *
 * That is not a bug in the search. It is what a per-vertex answer to a
 * topological question looks like. Four attempts to damp it -- a median
 * despeckle, a quantised sort key, ordering by a per-run median, and matching
 * every shape to the street network -- moved the defect count by nothing, or
 * made it worse.
 *
 * This is the shape the published work uses (LOOM, `transitmap`): an EDGE is a
 * stretch of street carrying a fixed SET of routes. Each route is ranked once
 * per edge, and its offset is one number held constant for the whole edge, so
 * there is no per-vertex decision left to wobble. Lines move sideways only at
 * a node, where the set genuinely changes, and that movement is deliberate.
 *
 * Membership is EQUALITY, not a distance test: `shareCorridors` has already
 * put routes that share a street on identical coordinates, so "same corridor"
 * is a map lookup rather than a threshold nobody can tune.
 */
import { roundCorners, type Pt } from "./bundle";

/** A stretch of one route carrying a fixed set of routes. */
export interface Edge {
  /** Index of the route this edge belongs to. */
  line: number;
  /** First and last vertex of the stretch, inclusive. */
  from: number;
  to: number;
  /** Every route on this stretch, sorted. The set is constant along it. */
  members: number[];
  /** Where this route sits across the corridor, 0 being the far side. */
  rank: number;
}

/** Coordinates within this are the same point. `shareCorridors` writes exactly
 *  equal values, so this only has to absorb floating-point noise. */
const SAME_M = 0.05;

const keyOf = (p: Pt) =>
  `${Math.round(p.x / SAME_M)},${Math.round(p.y / SAME_M)}`;

/** Unit tangent at `i`. */
function tangentAt(path: Pt[], i: number): Pt {
  const a = path[Math.max(0, i - 1)]!;
  const b = path[Math.min(path.length - 1, i + 1)]!;
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
}

/**
 * Cut every route into edges, and rank the routes within each.
 *
 * Ranking is decided ONCE per edge and by something that cannot flicker: the
 * direction each route runs relative to the edge, then its index. Two
 * directions of one street therefore always land on opposite sides, and two
 * routes running together always keep the same relative order for the whole
 * stretch.
 */
export function buildEdges(paths: Pt[][], minEdgeVerts = 1): Edge[] {
  // Which routes occupy each shared coordinate.
  const at = new Map<string, number[]>();
  paths.forEach((path, l) => {
    for (const p of path) {
      const k = keyOf(p);
      const here = at.get(k);
      if (!here) at.set(k, [l]);
      else if (!here.includes(l)) here.push(l);
    }
  });

  const edges: Edge[] = [];
  paths.forEach((path, l) => {
    const membersAt = path.map((p) => {
      const m = at.get(keyOf(p)) ?? [l];
      return [...m].sort((a, b) => a - b);
    });

    let start = 0;
    while (start < path.length) {
      const sig = membersAt[start]!.join(",");
      let end = start;
      while (end + 1 < path.length && membersAt[end + 1]!.join(",") === sig) end++;

      const members = membersAt[start]!;
      // Rank on which way each member runs along THIS edge, decided once from
      // the middle of the stretch where the geometry is least ambiguous.
      const mid = (start + end) >> 1;
      const ours = tangentAt(path, mid);
      const facing = members.map((m) => {
        if (m === l) return { m, with: 1 };
        // The same shared coordinate on the other route.
        const j = paths[m]!.findIndex((q) => keyOf(q) === keyOf(path[mid]!));
        if (j < 0) return { m, with: 1 };
        const t = tangentAt(paths[m]!, j);
        return { m, with: t.x * ours.x + t.y * ours.y >= 0 ? 1 : -1 };
      });
      facing.sort((a, b) => a.with - b.with || a.m - b.m);

      edges.push({
        line: l, from: start, to: end, members,
        rank: facing.findIndex((f) => f.m === l),
      });
      start = end + 1;
    }
  });
  return minEdgeVerts > 1 ? contract(paths, edges, minEdgeVerts) : edges;
}

/**
 * Absorb edges too short to be a real change of corridor.
 *
 * `shareCorridors` only merges points that are each other's nearest, so along
 * a shared street the membership can alternate between {A} and {A,B} vertex by
 * vertex where one sample failed to pair. Measured before contracting, the
 * median edge on the Connector was 2 vertices -- 20 metres -- which is not a
 * street, it is a gap in the pairing.
 *
 * Each too-short edge takes the membership of its longer neighbour, and
 * touching edges that end up identical are merged. This is a decision about
 * TOPOLOGY -- is this a corridor at all -- not a filter over a continuous
 * signal, which is what the earlier despeckling attempts were and why they
 * achieved nothing.
 */
function contract(paths: Pt[][], edges: Edge[], minVerts: number): Edge[] {
  const out: Edge[] = [];
  for (let l = 0; l < paths.length; l++) {
    const mine = edges.filter((e) => e.line === l).sort((a, b) => a.from - b.from);
    if (mine.length === 0) continue;

    // Rewrite the short ones first.
    for (let i = 0; i < mine.length; i++) {
      const e = mine[i]!;
      if (e.to - e.from + 1 >= minVerts) continue;
      const prev = mine[i - 1], next = mine[i + 1];
      const longer = !prev ? next : !next ? prev
        : (prev.to - prev.from) >= (next.to - next.from) ? prev : next;
      if (!longer) continue;
      e.members = longer.members;
      e.rank = longer.rank;
    }

    // Then fuse neighbours that now say the same thing.
    for (const e of mine) {
      const last = out[out.length - 1];
      if (last && last.line === l && last.to + 1 === e.from
          && last.members.join(",") === e.members.join(",") && last.rank === e.rank) {
        last.to = e.to;
        continue;
      }
      out.push({ ...e });
    }
  }
  return out;
}

/**
 * The lateral offset of every vertex, in lane units.
 *
 * One number per EDGE, held for the whole edge, so a straight street cannot
 * acquire a dogleg. Only the joins between edges are eased, over `blend`
 * vertices, because that is where the corridor genuinely changes.
 */
export function laneOffsets(
  paths: Pt[][], edges: Edge[], blend: number,
): number[][] {
  const out = paths.map((p) => new Array<number>(p.length).fill(0));
  for (const e of edges) {
    // NOT centred on the corridor. Centring (rank - (n-1)/2) reads well in
    // isolation and moves every incumbent sideways whenever another route
    // joins: a two-route street at -0.5/+0.5 becomes -1/0/+1 when a third
    // arrives, so all three step across at the junction. That step is the jog
    // in an otherwise straight street.
    //
    // Anchoring at rank 0 instead means a route joining a corridor slots in
    // beside the ones already there and nobody else moves. The bundle grows to
    // one side of the street rather than straddling it, which is what the
    // Underground and NYC maps do at a junction anyway.
    for (let i = e.from; i <= e.to; i++) out[e.line]![i] = e.rank;
  }
  if (blend < 2) return out;

  // Ease only across the joins. A moving average over the whole line would
  // round off the middle of every edge as well, which is the smoothing that
  // turned each old flip into a wedge.
  return out.map((row) => {
    const eased = [...row];
    for (let i = 1; i < row.length; i++) {
      if (row[i] === row[i - 1]) continue;
      const from = row[i - 1]!, to = row[i]!;
      const half = Math.floor(blend / 2);
      for (let k = -half; k <= half; k++) {
        const j = i + k;
        if (j < 1 || j >= row.length) continue;
        const t = (k + half) / (2 * half || 1);
        eased[j] = from + (to - from) * (t * t * (3 - 2 * t));
      }
    }
    return eased;
  });
}

/**
 * The drawn geometry for every route, offset by its lane.
 *
 * Deliberately small: the offset is already decided per edge, so all that is
 * left is to move each vertex sideways along its own normal and round the
 * corners in screen space. There is no search here, nothing to sort, and no
 * signal to smooth -- which is the whole point of deciding the corridor first.
 */
export function drawLanes(
  paths: Pt[][], offsets: number[][], gapM: number, cornerRadiusM: number,
): Pt[][] {
  return paths.map((path, l) => {
    const closed = path.length > 2
      && Math.hypot(path[path.length - 1]!.x - path[0]!.x,
                    path[path.length - 1]!.y - path[0]!.y) < 1;
    // Vertex normal from the two adjoining segments, so a corner keeps a
    // parallel through it rather than pinching.
    const segN: Pt[] = [];
    for (let i = 1; i < path.length; i++) {
      const dx = path[i]!.x - path[i - 1]!.x, dy = path[i]!.y - path[i - 1]!.y;
      const d = Math.hypot(dx, dy) || 1;
      segN.push({ x: dy / d, y: -dx / d });
    }
    const moved = path.map((p, i) => {
      const prev = segN[closed ? (i - 1 + segN.length) % segN.length : Math.max(0, i - 1)]!;
      const next = segN[closed ? i % segN.length : Math.min(i, segN.length - 1)]!;
      const ax = (prev.x + next.x) / 2, ay = (prev.y + next.y) / 2;
      const m = Math.hypot(ax, ay);
      const n = m < 1e-6 ? next : { x: ax / m, y: ay / m };
      // A corner needs more travel to hold a parallel: 1/cos(half-angle),
      // capped so a hairpin does not throw a spike.
      const miter = Math.min(2, m < 1e-6 ? 1 : 1 / m);
      const d = (offsets[l]![i] ?? 0) * gapM * miter;
      return { x: p.x + n.x * d, y: p.y + n.y * d };
    });
    return roundCorners(moved, cornerRadiusM, closed);
  });
}
