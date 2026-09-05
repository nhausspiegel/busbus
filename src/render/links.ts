import type { LatLng } from "../data/types";
import type { LaneRun } from "./lanes";

/**
 * The join MapLibre cannot make.
 *
 * `line-offset` is a per-FEATURE paint property, so a route whose lane changes
 * has to be cut into several features -- and MapLibre only builds a join WITHIN
 * a feature. Every cut is therefore a join it cannot make. Measured on the five
 * Brown routes: 47 boundaries, every one of them visible.
 *
 * Two separate things make a boundary visible, and only the first is obvious:
 *
 *   - the offset CHANGES, so the two features are drawn at different distances
 *     from the road and the line steps sideways. Median 3.4px, max 10px.
 *   - the two features meet at a CORNER, so their last and first segments have
 *     different normals and their ends part by `offset * |n1 - n2|` -- up to
 *     8px -- even when the offset either side is IDENTICAL. 17 of the 47.
 *
 * No cap style touches either: round caps make a nub, butt caps make a notch.
 * Changing the cap only chooses which artefact appears, which is why it was
 * tried twice.
 *
 * So stop trying to make the features meet. Pull them apart deliberately and
 * draw the connection, which is what LOOM does (Bast/Brosi/Storandt, "Efficient
 * Generation of Geographically Accurate Transit Maps", stage 3: "free node
 * area", then "render inner connections... cubic Bezier curves").
 *
 * The straight runs keep GPU `line-offset` exactly as before -- untouched, and
 * still exact. Only these short curves are geometry, and a curve between two
 * ports a few pixels apart cannot fold, which is the difference from offsetting
 * the whole line by hand. That was tried twice and folded 20 times over at the
 * zoom the app opens at.
 */

const K = 111_320;

/**
 * The knobs this rendering actually has, in one place and settable at runtime.
 *
 * They are here rather than baked in because every value below was first set by
 * guessing, then corrected once the owner looked at the map -- twice for the
 * miter threshold alone. A number that can only be judged by eye should be
 * adjustable by the eye judging it. `?tune` in the URL puts sliders on the map.
 *
 * All in DEVICE PIXELS, so they mean the same thing at every zoom.
 */
export const TUNING = {
  /** Clear space between two routes sharing a street. */
  laneGapPx: 5,
  /** How far each run is pulled back from a junction to make room for the
   *  curve. Enough that the curve reads as a curve; small enough that the
   *  straight parts still dominate. */
  clearPx: 7,
  /** How far `line-offset`'s mitered vertex may run PAST the offset before the
   *  corner is handed to the connector instead. See MITER note below. */
  miterExcessPx: 0.9,
  /** Control-point reach as a fraction of the gap being crossed. Higher bulges
   *  the curve outward, lower flattens it toward a straight cut. */
  curveTension: 0.4,
};

/** Kept as a named export because tests and callers read it. */
export const NODE_CLEAR_PX = TUNING.clearPx;

/** Points on the flattened curve. Eight is below the point where more stops
 *  being visible at any zoom this app reaches. */
const CURVE_STEPS = 8;

/** How far MapLibre's offset vertex may run PAST the offset, in pixels, before
 *  the corner is handed to the connector instead.
 *
 *  `line-offset` puts the displaced vertex on the MITER, so a corner of interior
 *  angle t pushes it out to offset / sin(t/2) -- unbounded as the corner
 *  sharpens, and independent of `line-join`, which only rounds whatever the
 *  spike leaves behind.
 *
 *  The threshold is on the EXCESS, not on the angle, because the spike scales
 *  with the offset: the same 95-degree corner overshoots by 1.2px in a two-wide
 *  group and 2.4px in a three-wide one. An angle alone would either miss the
 *  visible ones or split twenty corners that look fine.
 *
 *  The threshold was first set at 1.5px, from the three worst corners alone --
 *  2.11-2.21px, the inside lane of a three-wide corner pushing a 5px offset out
 *  to 7.2px against a 4.5px stroke. The owner then reported a corner on Hope
 *  Street that looked the same and measures 1.10px, and there are 0.95-0.97px
 *  corners on that street too. Three samples were not the distribution.
 *
 *  Measured over every corner in the network, the excess clusters: 32 corners
 *  above 0.9px, then a gap, then nothing until 2.11px. 0.9 takes the whole
 *  cluster -- about a fifth of the 4.5px stroke, which is where it starts to
 *  read as a lump rather than a corner. A gentle bend is still left to the
 *  miter, because a curve there would be ceremony. */


interface XY { x: number; y: number }

/** A route's connection across one junction, already displaced -- so it is drawn
 *  with `laneOffset: 0` and needs nothing from the GPU. */
export interface LaneLink {
  routeId: string;
  path: LatLng[];
}

const proj = (lat0: number) => {
  const KX = K * Math.cos((lat0 * Math.PI) / 180);
  return {
    to: (p: LatLng): XY => ({ x: p.lng * KX, y: p.lat * K }),
    from: (p: XY): LatLng => ({ lat: p.y / K, lng: p.x / KX }),
  };
};

/** Walk `dist` metres in from one end of a path, returning the shortened path.
 *  `fromStart` trims the head, otherwise the tail. Never eats more than 40% of
 *  the run, so a short run between two junctions survives. */
function trim(pts: XY[], dist: number, fromStart: boolean): XY[] {
  const p = fromStart ? pts : [...pts].reverse();
  let total = 0;
  for (let i = 1; i < p.length; i++) total += Math.hypot(p[i]!.x - p[i - 1]!.x, p[i]!.y - p[i - 1]!.y);
  const want = Math.min(dist, total * 0.4);
  let walked = 0;
  for (let i = 1; i < p.length; i++) {
    const seg = Math.hypot(p[i]!.x - p[i - 1]!.x, p[i]!.y - p[i - 1]!.y);
    if (walked + seg >= want) {
      const t = seg < 1e-9 ? 0 : (want - walked) / seg;
      const cut = { x: p[i - 1]!.x + (p[i]!.x - p[i - 1]!.x) * t,
                    y: p[i - 1]!.y + (p[i]!.y - p[i - 1]!.y) * t };
      const rest = [cut, ...p.slice(i)];
      return fromStart ? rest : rest.reverse();
    }
    walked += seg;
  }
  return fromStart ? p : p.reverse();
}

/** Unit vector from a to b, and the normal to its RIGHT -- MapLibre offsets to
 *  the right of a feature's own direction, so this has to match. */
function frame(a: XY, b: XY) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
  return { tx: dx / L, ty: dy / L, nx: dy / L, ny: -dx / L };
}

/**
 * Trim every run back from its junctions and return the curves that reconnect
 * them.
 *
 * The ports are computed the way MapLibre displaces a feature's END vertex --
 * along that one segment's normal -- so the curve starts exactly where the
 * stroke stops. That equality is the thing worth testing: it is checkable
 * without rendering anything, and it is where a sign error would hide.
 */
/** Cut a run at any corner sharp enough that `line-offset`'s miter would spike.
 *  The halves keep the same offset, so the connector between them is a curve
 *  ROUND the corner rather than a lane change -- which is what a corner wants,
 *  and what a miter cannot give. */
function splitAtSharpCorners(run: LaneRun): LaneRun[] {
  if (Math.abs(run.offsetPx) < 1e-9 || run.path.length < 3) return [run];
  const off = Math.abs(run.offsetPx);
  const { to } = proj(run.path[0]!.lat);
  const out: LaneRun[] = [];
  let start = 0;
  for (let i = 1; i < run.path.length - 1; i++) {
    const a = to(run.path[i - 1]!), b = to(run.path[i]!), c = to(run.path[i + 1]!);
    const u = (p: XY, q: XY) => {
      const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy) || 1;
      return { x: dx / L, y: dy / L };
    };
    const t1 = u(a, b), t2 = u(b, c);
    const interior = Math.PI - Math.acos(Math.max(-1, Math.min(1, t1.x * t2.x + t1.y * t2.y)));
    const sin = Math.sin(interior / 2);
    if (sin < 1e-6 || off * (1 / sin - 1) <= TUNING.miterExcessPx) continue;
    out.push({ ...run, path: run.path.slice(start, i + 1) });
    start = i;                       // the halves share the corner vertex
  }
  out.push({ ...run, path: run.path.slice(start) });
  return out.filter((r) => r.path.length >= 2);
}

export function laneLinks(
  runs: LaneRun[], mpp: number, clearPx = TUNING.clearPx,
): { runs: LaneRun[]; links: LaneLink[] } {
  const clear = clearPx * mpp;
  const byRoute = new Map<string, LaneRun[]>();
  for (const r of runs.flatMap(splitAtSharpCorners))
    (byRoute.get(r.routeId) ?? byRoute.set(r.routeId, []).get(r.routeId)!).push(r);

  const outRuns: LaneRun[] = [];
  const links: LaneLink[] = [];

  for (const [routeId, rs] of byRoute) {
    const { to, from } = proj(rs[0]!.path[0]!.lat);
    const xy = rs.map((r) => r.path.map(to));

    // Trim first, so the ports below are taken from the shortened ends and the
    // curve meets the stroke rather than the centreline it came from.
    const cut = xy.map((pts, i) => {
      let p = pts;
      if (i > 0) p = trim(p, clear, true);
      if (i < xy.length - 1) p = trim(p, clear, false);
      return p;
    });

    cut.forEach((pts, i) => outRuns.push({ ...rs[i]!, path: pts.map(from) }));

    for (let i = 1; i < cut.length; i++) {
      const A = cut[i - 1]!, B = cut[i]!;
      if (A.length < 2 || B.length < 2) continue;
      const offA = rs[i - 1]!.offsetPx * mpp, offB = rs[i]!.offsetPx * mpp;

      const fa = frame(A[A.length - 2]!, A[A.length - 1]!);
      const fb = frame(B[0]!, B[1]!);
      const pa = { x: A[A.length - 1]!.x + fa.nx * offA, y: A[A.length - 1]!.y + fa.ny * offA };
      const pb = { x: B[0]!.x + fb.nx * offB, y: B[0]!.y + fb.ny * offB };

      // Control points along each side's own direction, so the curve leaves and
      // arrives tangent to the stroke and there is no visible corner at either
      // port. Scaled to the gap being crossed, not to a constant, or a long
      // junction gets a flat curve and a short one an overshooting loop.
      const span = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      const k = Math.max(span * TUNING.curveTension, 1e-6);
      const c1 = { x: pa.x + fa.tx * k, y: pa.y + fa.ty * k };
      const c2 = { x: pb.x - fb.tx * k, y: pb.y - fb.ty * k };

      const path: LatLng[] = [];
      for (let s = 0; s <= CURVE_STEPS; s++) {
        const t = s / CURVE_STEPS, u = 1 - t;
        path.push(from({
          x: u * u * u * pa.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * pb.x,
          y: u * u * u * pa.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * pb.y,
        }));
      }
      links.push({ routeId, path });
    }
  }
  return { runs: outRuns, links };
}
