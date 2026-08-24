/**
 * Push coincident polylines apart into parallel lanes with a minimum gap.
 *
 * General geometry, flat plane, no map and no transit in it. Given N polylines,
 * wherever two or more run close together and roughly parallel, spread them
 * just far enough apart to clear a minimum separation, and leave every stretch
 * where a line runs by itself exactly where it was.
 *
 * Three rules earn their place, each because breaking it shipped a visible
 * defect:
 *
 * 1. ORDER THE BUNDLE PHYSICALLY. Members are sorted by their position across
 *    the bundle, not by anything belonging to an individual line. Resolving a
 *    lane in each line's own "right of travel" frame sends the two directions
 *    of one loop to the SAME side, because -0.5 and +0.5 are mirror images of
 *    each other.
 *
 * 2. THE GAP IS A FLOOR, NOT A TARGET. Lines already further apart than the
 *    minimum are left untouched. A rule that forces an exact spacing cannot
 *    tell "one street traced twice" from "two genuinely parallel streets", and
 *    drags the second case off its roads.
 *
 * 3. NEVER BUILD A PARALLEL CURVE. A true parallel needs the miter,
 *    d / sin(t/2), and that miter IS the spike -- at a 64 degree corner it is
 *    1.9x the offset, at 30 degrees nearly 4x, and it is a fixed length in the
 *    output whatever the scale. Each vertex is moved along its own normal
 *    instead. Corners pinch a little rather than spiking, and no displacement
 *    can ever exceed the gap being opened.
 */

export interface Pt { x: number; y: number }
export interface Line { id: string; points: Pt[] }

export interface BundleOptions {
  /** How close two lines must run to count as sharing. */
  thresholdM: number;
  /** How parallel they must be, compared modulo 180 so opposite directions of
   *  one street still count and a crossing does not. */
  headingTolDeg: number;
  /** Resampling step for the analysis. */
  stepM: number;
  /** Distance over which a line eases into and out of a bundle. */
  taperM: number;
}

/**
 * Sensible defaults, measured on the reference cases in test/fixtures.
 *
 * `taperM` is the one worth understanding: it is how far a line takes to ease
 * into its lane, and it is what makes the result look drawn rather than
 * computed. At 40 the ramp put a 7.5 degree kink in the line where a bundle
 * begins; at 140 that is 1.3 degrees and invisible. It costs nothing but a
 * longer approach.
 */
export const DEFAULT_OPTIONS: BundleOptions = {
  thresholdM: 25,
  headingTolDeg: 30,
  stepM: 10,
  taperM: 60,
};

/** Everything about one line that does not depend on the gap, computed once. */
export interface LaneProfile {
  id: string;
  /** The line, densified. Original vertices are all present. */
  path: Pt[];
  /** Where every member of this point's bundle sits across it, ascending. */
  across: number[][];
  /** Which entry of `across[i]` is this line. */
  self: number[];
  /** Unit normal to displace along at each point. Continuous along the line. */
  normal: Pt[];
  /** +1 where `normal` already points the canonical way, -1 where it is the
   *  mirror of it. `across` and `self` are expressed in the canonical frame;
   *  multiplying by this brings a displacement back into `normal`'s frame,
   *  which is the one that varies smoothly and can therefore be averaged. */
  canonSign: number[];
  /** Extra travel each vertex needs to hold a parallel through its corner,
   *  capped at MITER_LIMIT. 1 on a straight run. */
  miter: number[];
  /** Taper window, in samples. */
  smoothWindow: number;
  /** Whether the line's ends meet, so the taper wraps rather than clamping. */
  closed: boolean;
}

const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const len = (a: Pt) => Math.hypot(a.x, a.y);

/** Insert points so no gap exceeds `step`, keeping every original vertex. */
function densify(points: Pt[], step: number): Pt[] {
  if (points.length < 2) return points.slice();
  const out: Pt[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d === 0) continue;
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++)
      out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/** Direction of travel at each point, from the segments either side. */
function tangents(path: Pt[]): Pt[] {
  return path.map((_, i) => {
    const a = path[Math.max(0, i - 1)]!, b = path[Math.min(path.length - 1, i + 1)]!;
    const t = { x: b.x - a.x, y: b.y - a.y };
    const l = len(t) || 1;
    return { x: t.x / l, y: t.y / l };
  });
}

/**
 * How much further than `d` a vertex must travel for the line to stay a true
 * parallel through a corner -- and the cap on it.
 *
 * At a corner of interior angle t the exact figure is 1 / sin(t/2): 1.41x at a
 * right angle, 1.89x at 64 degrees, unbounded as the corner closes. Ignoring it
 * altogether pinches the corner, and on the two-directions-of-one-loop case
 * that pulled a 12 gap down to 7.2 at every corner. Following it exactly is the
 * spike that made MapLibre's own line-offset unusable here.
 *
 * So it is capped, which is precisely what SVG's stroke-miterlimit does: honour
 * the miter up to a limit, accept a slightly pinched corner past it. At 2 a
 * right angle is exact and nothing can ever travel more than twice the gap it
 * is opening.
 */
const MITER_LIMIT = 2;

/**
 * The two segments meeting at vertex i.
 *
 * On a closed line the first and last vertices are the SAME corner, and both
 * must see the segment on either side of it. Clamping instead makes the
 * closing vertex see its incoming segment twice, so a right-angled corner
 * reads as straight: measured, that left the loop's seam corner at miter 1.00
 * where it needed 1.41, and pinched the gap there from 12 to 7.2.
 */
function joinAt(segNormals: Pt[], i: number, closed: boolean): [Pt, Pt] {
  const n = segNormals.length;
  if (closed) return [segNormals[(i - 1 + n) % n]!, segNormals[i % n]!];
  return [segNormals[Math.max(0, i - 1)]!, segNormals[Math.min(i, n - 1)]!];
}

function miters(path: Pt[], segNormals: Pt[], closed: boolean): number[] {
  return path.map((_, i) => {
    const [prev, next] = joinAt(segNormals, i, closed);
    // |average of the two segment normals| is cos(half the turn), which is
    // sin(half the interior angle) -- the reciprocal is the miter.
    const half = len({ x: (prev.x + next.x) / 2, y: (prev.y + next.y) / 2 });
    return half < 1e-6 ? MITER_LIMIT : Math.min(1 / half, MITER_LIMIT);
  });
}

/** Same street? Compared modulo 180 so a corridor driven backwards counts and
 *  two lines merely crossing do not. */
function parallel(a: Pt, b: Pt, tolDeg: number): boolean {
  const c = Math.abs(dot(a, b));                    // |cos| folds direction away
  return c >= Math.cos((tolDeg * Math.PI) / 180);
}

/**
 * Widen each run of displacement to the taper window before smoothing it.
 *
 * Because the gap is a MINIMUM, a line's wanted displacement is zero right up
 * until it is already too close to its neighbour -- so a ramp that begins there
 * is always late, and the two lines visibly pinch together just before they
 * separate. Taking the largest displacement in a window either side lets a line
 * start moving BEFORE it needs to, which is what makes a merge read as two
 * lines converging rather than two lines colliding and recoiling.
 *
 * It also protects the plateau: smoothing a run shorter than the window would
 * otherwise never reach full displacement, which is why a long taper used to
 * stop a short shared stretch from ever reaching the gap.
 */
function dilate(v: number[], window: number, closed: boolean): number[] {
  if (window < 2) return v;
  const half = Math.floor(window / 2);
  const n = v.length;
  return v.map((_, i) => {
    let best = 0;
    for (let k = -half; k <= half; k++) {
      let j = i + k;
      if (closed) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) continue;
      if (Math.abs(v[j]!) > Math.abs(best)) best = v[j]!;
    }
    return best;
  });
}

/** Moving average, which is what turns a lane change into a ramp. Smoothing a
 *  SCALAR is safe; smoothing coordinates bends the line off its path.
 *
 *  Wraps for a closed line. Clamping at the ends instead averages over fewer
 *  samples there, so a loop's displacement tapers towards its seam and the two
 *  ends stop meeting -- the ring visibly thins and breaks open at one corner. */
function smooth(v: number[], window: number, closed: boolean): number[] {
  if (window < 2) return v;
  const half = Math.floor(window / 2);
  const n = v.length;
  const once = (src: number[]) => src.map((_, i) => {
    let sum = 0, count = 0;
    for (let k = -half; k <= half; k++) {
      let j = i + k;
      if (closed) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) continue;
      sum += src[j]!; count++;
    }
    return sum / count;
  });
  // Twice. One pass is a box filter: its ramp starts and stops abruptly, and
  // each of those two corners is a visible kink in the drawn line -- measured
  // at 21 degrees of extra turn on the Y-merge. Two passes make it a
  // triangular kernel, whose slope is continuous, and the kink goes away.
  return once(once(v));
}

/**
 * Spread sorted positions so consecutive ones clear `gap`, moving them as
 * little as possible.
 *
 * ponytail: greedy from the left then recentre, not the exact least-squares
 * isotonic solution. Swap in pool-adjacent-violators if a bundle ever visibly
 * lurches; for the two and three member bundles that occur in practice the two
 * agree.
 */
export function spread(sorted: number[], gap: number): number[] {
  if (sorted.length < 2) return sorted.slice();
  const out = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++)
    out.push(Math.max(sorted[i]!, out[i - 1]! + gap));
  // Recentre so the bundle straddles where it was rather than drifting right.
  const shift = out.reduce((s, t, i) => s + t - sorted[i]!, 0) / out.length;
  return out.map((t) => t - shift);
}

/**
 * Drop vertices where the offset has folded the line back over itself.
 *
 * Offsetting a polyline by more than its local segment length at a corner
 * self-intersects, and no choice of miter avoids it: the corner slides
 * d x tan(half the turn) ALONG the line, so once that passes the neighbouring
 * vertex the drawn line reverses. Measured on the loop case at a fine sampling
 * step, a full 180 degrees. Every serious offsetting library trims this; here
 * it is enough to drop any vertex that does not advance along the direction of
 * travel.
 */
function trimFolds(pts: Pt[], normals: Pt[], closed: boolean): Pt[] {
  if (pts.length < 3) return pts;
  const out: Pt[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const n = normals[i]!;
    const t = { x: -n.y, y: n.x };               // direction of travel
    const last = out[out.length - 1]!;
    const step = { x: pts[i]!.x - last.x, y: pts[i]!.y - last.y };
    if (step.x * t.x + step.y * t.y <= 0) continue;
    out.push(pts[i]!);
  }
  if (out.length < 2) return pts;
  // A loop must still close -- and the closing segment can fold just like any
  // other, so trailing vertices that do not advance towards the start are
  // dropped before it is re-joined.
  if (closed) {
    const n0 = normals[0]!, t0 = { x: -n0.y, y: n0.x };
    while (out.length > 2) {
      const last = out[out.length - 1]!;
      const step = { x: out[0]!.x - last.x, y: out[0]!.y - last.y };
      if (step.x * t0.x + step.y * t0.y > 0) break;
      out.pop();
    }
    const a = out[0]!, b = out[out.length - 1]!;
    if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) out.push({ x: a.x, y: a.y });
  }
  return out;
}

/** Points sampled along each corner arc. Six reads as a curve rather than a
 *  chamfer without multiplying the vertex count. */
const ARC_STEPS = 6;

/**
 * Replace every corner with an arc of the SAME radius.
 *
 * This is what a transit map looks like -- the Underground and the NYC subway
 * both turn every corner through one constant radius, and it is why their lines
 * read as drawn rather than plotted. Smoothing the offset instead produces a
 * long lazy S, which is a smear, not a corner.
 *
 * The cut is clamped to 40% of each adjoining segment so a short segment cannot
 * be consumed and folded back on itself; a corner tighter than that simply gets
 * a smaller radius rather than a broken line. Near-straight vertices pass
 * through untouched, so a densified straight run does not acquire wobble.
 *
 * The radius is a RENDER quantity: on a map it is pixels converted to ground
 * units at the current scale, exactly like the gap, so a corner looks the same
 * at every zoom. Baking a fixed ground radius in would cut visible corners off
 * the route when zoomed in and do nothing at all when zoomed out.
 */
export function roundCorners(pts: Pt[], radius: number, closed: boolean): Pt[] {
  if (radius <= 0 || pts.length < 3) return pts;
  // A closed line repeats its first point at the end; work on the ring.
  const ring = closed ? pts.slice(0, -1) : pts;
  const m = ring.length;
  if (m < 3) return pts;

  const out: Pt[] = [];
  for (let i = 0; i < m; i++) {
    const b = ring[i]!;
    if (!closed && (i === 0 || i === m - 1)) { out.push(b); continue; }
    const a = ring[(i - 1 + m) % m]!, c = ring[(i + 1) % m]!;
    const inV = { x: a.x - b.x, y: a.y - b.y }, outV = { x: c.x - b.x, y: c.y - b.y };
    const inL = len(inV), outL = len(outV);
    if (inL < 1e-9 || outL < 1e-9) { out.push(b); continue; }

    const cosT = (inV.x * outV.x + inV.y * outV.y) / (inL * outL);
    const theta = Math.acos(Math.max(-1, Math.min(1, cosT)));   // interior angle
    if (theta > Math.PI - 0.14) { out.push(b); continue; }       // ~8 degrees: straight

    // Tangent length for a true fillet of this radius, clamped by the segments.
    const cut = Math.min(radius / Math.tan(theta / 2), inL * 0.4, outL * 0.4);
    const p = { x: b.x + (inV.x / inL) * cut, y: b.y + (inV.y / inL) * cut };
    const q = { x: b.x + (outV.x / outL) * cut, y: b.y + (outV.y / outL) * cut };

    // Quadratic Bezier through the corner. Its control point IS the vertex, so
    // the curve is guaranteed to stay inside the corner and can only ever cut
    // it, never bulge past the line the route already followed.
    out.push(p);
    for (let s = 1; s < ARC_STEPS; s++) {
      const t = s / ARC_STEPS, u = 1 - t;
      out.push({
        x: u * u * p.x + 2 * u * t * b.x + t * t * q.x,
        y: u * u * p.y + 2 * u * t * b.y + t * t * q.y,
      });
    }
    out.push(q);
  }
  if (closed && out.length > 0) out.push({ x: out[0]!.x, y: out[0]!.y });
  return out;
}

/** The gap-independent half. Run once; cheap to re-apply per scale. */
export function laneProfiles(lines: Line[], o: BundleOptions): LaneProfile[] {
  const usable = lines.filter((l) => l.points.length >= 2);
  const paths = usable.map((l) => densify(l.points, o.stepM));
  const tans = paths.map(tangents);
  const closedFlags = paths.map((path) =>
    Math.hypot(path[path.length - 1]!.x - path[0]!.x,
               path[path.length - 1]!.y - path[0]!.y) <= o.stepM);

  // Vertex normals and miters must come from the SAME construction -- the two
  // adjoining segment normals -- or the miter is measured along one direction
  // and applied along another, and the corner comes out neither square nor
  // parallel. Deriving the normal from a central-difference tangent instead
  // left every right angle turning 14 degrees more than its source.
  const normals: Pt[][] = [];
  const miterOf: number[][] = [];
  paths.forEach((path, l) => {
    const segN: Pt[] = [];
    const segLen: number[] = [];
    for (let i = 1; i < path.length; i++) {
      const dx = path[i]!.x - path[i - 1]!.x, dy = path[i]!.y - path[i - 1]!.y;
      const d = Math.hypot(dx, dy) || 1;
      segN.push({ x: dy / d, y: -dx / d });
    }
    const closed = closedFlags[l]!;
    normals.push(path.map((_, i) => {
      const [prev, next] = joinAt(segN, i, closed);
      const avg = { x: (prev.x + next.x) / 2, y: (prev.y + next.y) / 2 };
      const m = len(avg);
      return m < 1e-6 ? next : { x: avg.x / m, y: avg.y / m };
    }));
    miterOf.push(miters(path, segN, closed));
  });

  // Spatial hash at the threshold: a point's neighbours are a 3x3 cell lookup
  // rather than a scan over every other line.
  const cellOf = (p: Pt) =>
    `${Math.floor(p.x / o.thresholdM)},${Math.floor(p.y / o.thresholdM)}`;
  const grid = new Map<string, { l: number; i: number }[]>();
  paths.forEach((path, l) => path.forEach((p, i) => {
    const k = cellOf(p);
    const bucket = grid.get(k);
    if (bucket) bucket.push({ l, i }); else grid.set(k, [{ l, i }]);
  }));

  return usable.map((line, l) => {
    const path = paths[l]!, normal = normals[l]!, tan = tans[l]!;
    const across: number[][] = [];
    const self: number[] = [];
    const canonSign: number[] = [];

    path.forEach((p, i) => {
      // Rank in a CANONICAL frame, not this line's own. Two directions of one
      // loop have exactly opposite normals, so sorting ascending reverses
      // between them and every tie-break flips with it -- which sends both
      // directions the same physical way, the bug this whole module exists to
      // avoid. Flipping the normal into a fixed half-plane gives both lines
      // the same frame at the same place.
      const own = normal[i]!;
      const flip = own.y < 0 || (own.y === 0 && own.x < 0);
      const n = flip ? { x: -own.x, y: -own.y } : own;
      canonSign.push(flip ? -1 : 1);
      // Everything running with this line here, itself included. Positions are
      // measured across the bundle, along the normal.
      const members: { at: number; l: number; sign: number }[] =
        [{ at: dot(p, n), l, sign: dot(own, n) >= 0 ? 1 : -1 }];
      const seen = new Set<number>([l]);
      // Keep the NEAREST sample of each other line, not the first one the cell
      // scan happens to reach. Taking whichever turned up first made the
      // projected position jitter from point to point, and the smoothing below
      // turned that jitter into visible ripples along the drawn line.
      const nearest = new Map<number, { d: number; at: number; sign: number }>();
      const [cx, cy] = cellOf(p).split(",").map(Number) as [number, number];
      for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++)
          for (const q of grid.get(`${cx + ox},${cy + oy}`) ?? []) {
            if (seen.has(q.l)) continue;
            const other = paths[q.l]![q.i]!;
            const d = Math.hypot(other.x - p.x, other.y - p.y);
            if (d > o.thresholdM) continue;
            if (!parallel(tan[i]!, tans[q.l]![q.i]!, o.headingTolDeg)) continue;
            const held = nearest.get(q.l);
            if (held && held.d <= d) continue;
            nearest.set(q.l, {
              d, at: dot(other, n),
              sign: dot(normals[q.l]![q.i]!, n) >= 0 ? 1 : -1,
            });
          }
      for (const [ol, m] of nearest) members.push({ at: m.at, l: ol, sign: m.sign });
      // Ties are the norm, not the exception: two lines traced from the same
      // source sit at exactly the same position across the bundle, and ranking
      // by value alone hands both of them rank 0 so they never separate.
      //
      // Ties break on `sign` first -- whether that member runs with or against
      // the canonical direction -- so every member ends up displaced to its
      // OWN right. On a straight street that puts the two directions on
      // opposite sides; around a loop walked both ways it produces two
      // concentric rings, one inside the other. Breaking on the line index
      // instead looks fine on a straight street and falls apart on a loop: the
      // index is globally constant while the canonical frame's relationship to
      // each line's own frame flips as the loop turns, so one ring ends up
      // outside along the top edge and inside along the bottom.
      members.sort((a, b) => a.at - b.at || a.sign - b.sign || a.l - b.l);
      across.push(members.map((m) => m.at));
      self.push(members.findIndex((m) => m.l === l));
    });

    return {
      id: line.id, path, across, self, normal, canonSign,
      miter: miterOf[l]!,
      smoothWindow: Math.max(1, Math.round(o.taperM / o.stepM) | 1),
      closed: closedFlags[l]!,
    };
  });
}

/** The gap-dependent half. One pass per scale change. */
export function applyLanes(p: LaneProfile, minGap: number, cornerRadius = 0): Pt[] {
  const wanted = p.across.map((positions, i) => {
    if (positions.length < 2 || minGap <= 0) return 0;
    const target = spread(positions, minGap);
    // Computed in the canonical frame; brought back into this line's own,
    // which is the frame that varies smoothly and can be averaged below.
    return (target[p.self[i]!]! - positions[p.self[i]!]!) * p.canonSign[i]!;
  });
  // Ease in and out, so entering a bundle is a ramp rather than a step.
  // Widen first, then round off. Smoothing alone always ramps too late, and
  // rounding a widened run keeps the plateau at full height.
  const eased = smooth(dilate(wanted, p.smoothWindow, p.closed), p.smoothWindow, p.closed);
  // The miter is applied AFTER smoothing: it is a property of the corner, not
  // of the lane, and averaging it would round off the very corners it exists
  // to hold square.
  const moved = p.path.map((q, i) => {
    const d = eased[i]! * p.miter[i]!;
    return { x: q.x + p.normal[i]!.x * d, y: q.y + p.normal[i]!.y * d };
  });
  return roundCorners(trimFolds(moved, p.normal, p.closed), cornerRadius, p.closed);
}
