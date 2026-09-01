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

/** How far back from the junction each run is pulled, in pixels. Enough to make
 *  room for a curve that reads as a curve; small enough that the straight parts
 *  still dominate. */
export const NODE_CLEAR_PX = 7;

/** Points on the flattened curve. Eight is below the point where more stops
 *  being visible at any zoom this app reaches. */
const CURVE_STEPS = 8;

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
export function laneLinks(
  runs: LaneRun[], mpp: number, clearPx = NODE_CLEAR_PX,
): { runs: LaneRun[]; links: LaneLink[] } {
  const clear = clearPx * mpp;
  const byRoute = new Map<string, LaneRun[]>();
  for (const r of runs) (byRoute.get(r.routeId) ?? byRoute.set(r.routeId, []).get(r.routeId)!).push(r);

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
      const k = Math.max(span * 0.4, 1e-6);
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
