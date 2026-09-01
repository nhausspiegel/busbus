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

      const { links } = laneLinks(runs, mpp);
      expect(links.length).toBe(boundaries);
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
      expect(after.length).toBe(before.length);
      let actuallyTrimmed = 0;
      for (let i = 0; i < after.length; i++) {
        expect(after[i]!.path.length).toBeGreaterThanOrEqual(2);
        expect(len(after[i]!.path)).toBeGreaterThan(0);
        expect(len(after[i]!.path)).toBeLessThanOrEqual(len(before[i]!.path) + 1e-6);
        // and room was actually made -- "no longer than before" is also true
        // when nothing was trimmed at all.
        if (len(before[i]!.path) - len(after[i]!.path) > mpp) actuallyTrimmed++;
      }
      expect(actuallyTrimmed).toBeGreaterThan(30);
    });

    it(`draws connectors that are short, at zoom ${zoom}`, () => {
      // A long connector means a trim went wrong and the curve is crossing
      // something it should not. Bounded by the clearance it was given.
      const { links } = laneLinks(laneRuns(snapped, 5), mpp);
      const longest = Math.max(...links.map((l) => len(l.path) / mpp));
      expect(longest).toBeLessThan(NODE_CLEAR_PX * 6);
    });
  }

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
