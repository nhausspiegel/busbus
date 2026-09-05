import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseSnapped } from "../src/data/snappedShapes";
import { laneRuns } from "../src/render/lanes";
import { laneLinks, NODE_CLEAR_PX } from "../src/render/links";
import type { LatLng } from "../src/data/types";

const snapped = parseSnapped(
  JSON.parse(readFileSync("public/gtfs/shapes-snapped.json", "utf8")));

const K = 111_320, KX = K * Math.cos((41.8265 * Math.PI) / 180);
const metres = (a: LatLng, b: LatLng) =>
  Math.hypot((b.lng - a.lng) * KX, (b.lat - a.lat) * K);
const len = (p: LatLng[]) =>
  p.slice(1).reduce((t, q, i) => t + metres(p[i]!, q), 0);

/** Metres per pixel at Brown, MapLibre's 512px tiles. */
const mppAt = (z: number) => (78_271.51696 * Math.cos((41.8265 * Math.PI) / 180)) / 2 ** z;

describe("the junction connector", () => {
  for (const zoom of [13, 14.2, 16, 18]) {
    const mpp = mppAt(zoom);

    it(`spans every boundary at zoom ${zoom}`, () => {
      const runs = laneRuns(snapped, 5);
      // A boundary is a place where one route's runs meet -- so a route with n
      // runs has n-1 of them.
      const perRoute = new Map<string, number>();
      for (const r of runs) perRoute.set(r.routeId, (perRoute.get(r.routeId) ?? 0) + 1);
      const boundaries = [...perRoute.values()].reduce((t, n) => t + n - 1, 0);
      expect(boundaries).toBeGreaterThan(30);          // 47 today; guard the premise

      // Sharp corners are split too, so there are MORE boundaries out than in.
      // The contract is that every boundary between consecutive output runs is
      // spanned -- one connector per gap, per route.
      const { runs: out, links } = laneLinks(runs, mpp);
      const outPer = new Map<string, number>();
      for (const r of out) outPer.set(r.routeId, (outPer.get(r.routeId) ?? 0) + 1);
      const outBoundaries = [...outPer.values()].reduce((t, n) => t + n - 1, 0);
      expect(outBoundaries).toBeGreaterThanOrEqual(boundaries);
      expect(links.length).toBe(outBoundaries);
    });

    it(`starts and ends exactly where the stroke does, at zoom ${zoom}`, () => {
      // THE assertion. MapLibre displaces a feature's end vertex along that one
      // segment's normal, to the RIGHT of the feature's own direction; the curve
      // has to begin at that point, not near it.
      //
      // The expected value is derived here from first principles rather than
      // from a helper in the module under test. A first attempt imported the
      // module's own port function, so flipping the normal's sign moved the
      // expectation with the code and the test passed either way -- the same
      // lockstep that let the metres-per-pixel bug live in two tests.
      const { runs: trimmed, links } = laneLinks(laneRuns(snapped, 5), mpp);

      /** Independently: last vertex + offset * right-normal of the last segment. */
      const port = (path: LatLng[], offsetPx: number, atStart: boolean): LatLng => {
        const [a, b] = atStart
          ? [path[0]!, path[1]!]
          : [path[path.length - 2]!, path[path.length - 1]!];
        const v = atStart ? a : b;
        const dx = (b.lng - a.lng) * KX, dy = (b.lat - a.lat) * K;
        const L = Math.hypot(dx, dy) || 1;
        const d = offsetPx * mpp;
        return { lat: (v.lat * K - (dx / L) * d) / K, lng: (v.lng * KX + (dy / L) * d) / KX };
      };

      const byRoute = new Map<string, typeof trimmed>();
      for (const r of trimmed)
        (byRoute.get(r.routeId) ?? byRoute.set(r.routeId, []).get(r.routeId)!).push(r);
      const linksOf = new Map<string, typeof links>();
      for (const l of links)
        (linksOf.get(l.routeId) ?? linksOf.set(l.routeId, []).get(l.routeId)!).push(l);

      let checked = 0, worst = 0;
      for (const [routeId, rs] of byRoute) {
        const ls = linksOf.get(routeId) ?? [];
        expect(ls.length).toBe(rs.length - 1);
        for (let i = 1; i < rs.length; i++) {
          const link = ls[i - 1]!;
          worst = Math.max(worst,
            metres(port(rs[i - 1]!.path, rs[i - 1]!.offsetPx, false), link.path[0]!) / mpp,
            metres(port(rs[i]!.path, rs[i]!.offsetPx, true),
                   link.path[link.path.length - 1]!) / mpp);
          checked++;
        }
      }
      // A loop that can skip every iteration proves nothing -- see CLAUDE.md.
      expect(checked).toBeGreaterThan(30);
      expect(worst).toBeLessThan(0.01);
    });

    it(`leaves the straight runs intact at zoom ${zoom}`, () => {
      // Trimming must never eat a run. A run shorter than the clearance is
      // capped at 40%, so every run survives with length.
      const before = laneRuns(snapped, 5);
      const { runs: after } = laneLinks(before, mpp);
      // Splitting a sharp corner adds runs, so this only grows.
      expect(after.length).toBeGreaterThanOrEqual(before.length);
      const total = (rs: typeof before) => rs.reduce((t, r) => t + len(r.path), 0);
      // Trimming removes length; nothing is ever added.
      expect(total(after)).toBeLessThan(total(before));
      let actuallyTrimmed = 0;
      for (const r of after) {
        expect(r.path.length).toBeGreaterThanOrEqual(2);
        expect(len(r.path)).toBeGreaterThan(0);
      }
      for (let i = 0; i < before.length; i++)
        if (total(after) < total(before) - mpp) actuallyTrimmed++;
      expect(actuallyTrimmed).toBeGreaterThan(0);
    });

    it(`draws connectors that are short, at zoom ${zoom}`, () => {
      // A long connector means a trim went wrong and the curve is crossing
      // something it should not. Bounded by the clearance it was given.
      const { links } = laneLinks(laneRuns(snapped, 5), mpp);
      const longest = Math.max(...links.map((l) => len(l.path) / mpp));
      expect(longest).toBeLessThan(NODE_CLEAR_PX * 6);
    });
  }

  it("hands a corner to the connector before its miter spikes", () => {
    // `line-offset` puts the displaced vertex on the MITER, so a corner of
    // interior angle t pushes it out to offset / sin(t/2). Measured before this
    // split existed: three corners at 91-92 degrees pushed a 5px offset out to
    // 7.1-7.2px against a 4.5px stroke -- the spike on the inside lane of a
    // three-wide corner, reported from the map at Waterman.
    //
    // After the split those corners belong to the connector, which rounds them
    // because it never miters at all. So no run may still CONTAIN a corner
    // whose miter overshoots.
    const mpp = mppAt(16);
    const { runs: out } = laneLinks(laneRuns(snapped, 5), mpp);
    let checked = 0, worst = 0;
    for (const r of out) {
      const off = Math.abs(r.offsetPx);
      if (off < 1e-9) continue;
      for (let i = 1; i < r.path.length - 1; i++) {
        const u = (p: LatLng, q: LatLng) => {
          const dx = (q.lng - p.lng) * KX, dy = (q.lat - p.lat) * K;
          const L = Math.hypot(dx, dy) || 1;
          return { x: dx / L, y: dy / L };
        };
        const t1 = u(r.path[i - 1]!, r.path[i]!), t2 = u(r.path[i]!, r.path[i + 1]!);
        const interior = Math.PI - Math.acos(Math.max(-1, Math.min(1, t1.x * t2.x + t1.y * t2.y)));
        const sin = Math.sin(interior / 2);
        if (sin < 1e-6) continue;
        worst = Math.max(worst, off * (1 / sin - 1));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);     // it examined real corners
    expect(worst).toBeLessThanOrEqual(1.5);
  });

  it("does not depend on the lane offsets being equal either side", () => {
    // The corner case that no cap style could fix: two runs at the SAME offset
    // meeting at a bend still part company, because their normals differ. The
    // connector must span that too, not just a lane change.
    const mpp = mppAt(16);
    const { links } = laneLinks(laneRuns(snapped, 5), mpp);
    expect(links.every((l) => l.path.length >= 2)).toBe(true);
    expect(links.every((l) => l.path.every((p) =>
      Number.isFinite(p.lat) && Number.isFinite(p.lng)))).toBe(true);
  });
});
