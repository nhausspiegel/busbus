/**
 * The geometry primitives the route renderer needs.
 *
 * This file used to hold a bundler that decided every vertex's lane on its own,
 * from a distance search over traces that weave. That question has no stable
 * answer, so the lane assignment oscillated and the drawn line stepped
 * sideways -- the spurs, wedges and kinks that were visible on the map. It was
 * replaced by src/render/graph.ts, which decides a corridor once and holds one
 * offset for the whole of it, and the 500 lines of searching, sorting,
 * smoothing, dilating and despeckling that propped up the old answer went with
 * it. What is left is the arithmetic that is still true.
 */

/** How many segments a rounded corner is drawn with. Six is enough that the
 *  arc reads as a curve at street zoom without inflating the geometry. */
const ARC_STEPS = 6;

const len = (a: Pt) => Math.hypot(a.x, a.y);

export interface Pt { x: number; y: number }
export interface Line { id: string; points: Pt[] }


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
