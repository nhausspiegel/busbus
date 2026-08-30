import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStaticFeed } from "../src/data/gtfs";
import { parseRoutePaths, fillMissingShapes } from "../src/data/routePaths";
import { parseSnapped } from "../src/data/snappedShapes";
import { laneIndex, laneRuns } from "../src/render/lanes";
import type { LatLng } from "../src/data/types";

/**
 * The snapped geometry, checked the way the old checks could not.
 *
 * A one-way "how far is each trace point from the drawn line" measure reported
 * p90 of 0.0-5.3m for paths that were THREE TIMES too long and reversed
 * direction 275 times -- a path zigzagging along the correct road is still
 * near every trace point. Length and the reverse direction are what catch that.
 */
const feed = fillMissingShapes(
  parseStaticFeed(new Uint8Array(readFileSync("public/gtfs/google_transit.zip"))),
  parseRoutePaths(JSON.parse(readFileSync("test/fixtures/route-paths.json", "utf8"))));
const snapped = parseSnapped(
  JSON.parse(readFileSync("public/gtfs/shapes-snapped.json", "utf8")));

const K = 111_320, KX = K * Math.cos((41.8265 * Math.PI) / 180);
const xy = (p: LatLng) => ({ x: p.lng * KX, y: p.lat * K });
const len = (pts: LatLng[]) => pts.slice(1).reduce((t, p, i) =>
  t + Math.hypot(xy(p).x - xy(pts[i]!).x, xy(p).y - xy(pts[i]!).y), 0);

function toLine(p: LatLng, line: LatLng[]): number {
  const d = xy(p);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = xy(line[i - 1]!), b = xy(line[i]!);
    const vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy;
    const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((d.x - a.x) * vx + (d.y - a.y) * vy) / L2));
    best = Math.min(best, Math.hypot(d.x - (a.x + t * vx), d.y - (a.y + t * vy)));
  }
  return best;
}
function turn(a: LatLng, b: LatLng, c: LatLng): number {
  const A = xy(a), B = xy(b), C = xy(c);
  const ax = B.x - A.x, ay = B.y - A.y, bx = C.x - B.x, by = C.y - B.y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 0.5 || lb < 0.5) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) * 180) / Math.PI;
}

describe("every route is snapped to the roads it drives", () => {
  for (const [routeId, path] of snapped) {
    const trace = feed.routes.get(routeId)!.shape;

    it(`${routeId} is the same length as its trace`, () => {
      // The check that would have caught the disaster in one run: 9.33km of
      // snapped path against a 3.18km route.
      expect(len(path) / len(trace)).toBeGreaterThan(0.9);
      expect(len(path) / len(trace)).toBeLessThan(1.1);
    });

    it(`${routeId} never doubles back`, () => {
      // The Connector really does turn round on Allens Avenue, and the trace
      // agrees, so one reversal is the route and not a defect.
      const rev = path.slice(2).filter((_, i) => turn(path[i]!, path[i + 1]!, path[i + 2]!) > 150);
      expect(rev.length).toBeLessThanOrEqual(1);
    });

    it(`${routeId} follows its trace in BOTH directions`, () => {
      // Both directions on purpose. Trace-to-path alone cannot see a detour;
      // path-to-trace is what notices the line going somewhere the route does
      // not. The residual ~7m is the trace being drawn down one side of the
      // road while the path is the centreline -- exactly the offset being
      // removed.
      const there = trace.map((p) => toLine(p, path)).sort((a, b) => a - b);
      const back = path.map((p) => toLine(p, trace)).sort((a, b) => a - b);
      expect(there[Math.floor(there.length * 0.9)]!).toBeLessThan(12);
      expect(back[Math.floor(back.length * 0.9)]!).toBeLessThan(12);
    });
  }
});

describe("lanes are pixels, not metres", () => {
  it("gives routes sharing a segment distinct, evenly spaced lanes", () => {
    const lanes = laneIndex(snapped);
    const shared = [...lanes.values()].filter((s) => s.users.length > 1);
    expect(shared.length).toBeGreaterThan(100);

    // Offsets are multiples of half the gap, centred on the road, and every
    // route on a segment gets its own.
    const runs = laneRuns(snapped, 5);
    const offsets = new Set(runs.map((r) => r.offsetPx));
    for (const o of offsets) expect(Math.abs(o * 2) % 5).toBeCloseTo(0, 6);
    expect(offsets.size).toBeGreaterThan(1);
  });

  it("does not depend on the zoom at all", () => {
    // The whole defect was a gap that grew from 3.7px at zoom 13 to 13.5px at
    // zoom 18. laneRuns takes no scale, so there is nowhere for a metre to
    // enter: the same call gives the same pixels forever.
    const a = laneRuns(snapped, 5).map((r) => r.offsetPx);
    const b = laneRuns(snapped, 5).map((r) => r.offsetPx);
    expect(a).toEqual(b);
    expect(new Set(a)).toEqual(new Set([-5, -2.5, 0, 2.5, 5]));
  });
});

describe("a lane change is never shorter than the junction that caused it", () => {
  // The lane is decided per road segment, so where a crossing route shares a
  // metre or two of the same OSM way at a corner, membership goes 2 -> 3 -> 2
  // and a stub feature is emitted at its own offset. Every feature boundary is
  // a join MapLibre cannot build -- it joins only within one feature -- which
  // is the nub under round caps and the notch under butt caps.
  //
  // Before this was fixed, six runs measured 4.0-7.1m; the shortest real
  // street block is 34.2m.
  it("emits no run shorter than a road junction", () => {
    const K = 111_320, KX = K * Math.cos((41.8265 * Math.PI) / 180);
    const metres = (path: LatLng[]) => {
      let m = 0;
      for (let i = 1; i < path.length; i++)
        m += Math.hypot((path[i]!.lng - path[i - 1]!.lng) * KX,
                        (path[i]!.lat - path[i - 1]!.lat) * K);
      return m;
    };
    const shortest = Math.min(...laneRuns(snapped, 5).map((r) => metres(r.path)));
    expect(shortest).toBeGreaterThan(25);
  });
});
