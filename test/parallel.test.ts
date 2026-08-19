import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { offsetColinearRoutes } from "../src/routing/parallel";
import { parseStaticFeed } from "../src/data/gtfs";
import type { LatLng } from "../src/data/types";

/** A straight run north along one longitude, from lat0 for `metres`. */
function northLine(lat0: number, lng: number, metres: number, points = 3): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i < points; i++)
    out.push({ lat: lat0 + (metres / 111_320) * (i / (points - 1)), lng });
  return out;
}

describe("offsetColinearRoutes", () => {
  it("gives two routes sharing a corridor different lanes", () => {
    const shape = northLine(41.826, -71.4, 400);
    const got = offsetColinearRoutes([{ id: "A", shape }, { id: "B", shape }]);
    const lanes = new Set(got.map((p) => p.lane));
    expect(lanes.size).toBe(2);
    expect([...lanes].sort()).toEqual([-0.5, 0.5]);
  });

  it("leaves a route alone where nothing else runs with it", () => {
    const got = offsetColinearRoutes([{ id: "A", shape: northLine(41.826, -71.4, 400) }]);
    expect(got.every((p) => p.lane === 0)).toBe(true);
  });

  it("recognises a corridor traversed in the opposite direction", () => {
    // The Evening CW and CCW loops run the same streets in reverse. If lane
    // assignment were direction-sensitive they would still overlap exactly.
    const shape = northLine(41.826, -71.4, 400);
    const got = offsetColinearRoutes([
      { id: "A", shape },
      { id: "B", shape: [...shape].reverse() },
    ]);
    expect(new Set(got.map((p) => p.lane)).size).toBe(2);
  });

  it("does not push apart two routes that merely cross", () => {
    // A crossing shares one intersection, not a corridor; offsetting there
    // would bend both lines away from the streets they actually follow.
    const northSouth = northLine(41.824, -71.4, 600);
    const eastWest: LatLng[] = [
      { lat: 41.8267, lng: -71.4035 }, { lat: 41.8267, lng: -71.3965 },
    ];
    const got = offsetColinearRoutes([{ id: "A", shape: northSouth }, { id: "B", shape: eastWest }]);
    const offsetPieces = got.filter((p) => p.lane !== 0);
    const offsetPoints = offsetPieces.reduce((n, p) => n + p.path.length, 0);
    const allPoints = got.reduce((n, p) => n + p.path.length, 0);
    expect(offsetPoints / allPoints).toBeLessThan(0.15);
  });

  it("splits a route where it stops sharing", () => {
    // A runs 800m north; B joins only for the first 300m. A must be offset on
    // the shared stretch and centred after it, so it needs at least 2 pieces.
    const long = northLine(41.820, -71.4, 800, 40);
    const short = northLine(41.820, -71.4, 300, 20);
    const got = offsetColinearRoutes([{ id: "A", shape: long }, { id: "B", shape: short }]);
    const aPieces = got.filter((p) => p.routeId === "A");
    expect(aPieces.length).toBeGreaterThan(1);
    expect(new Set(aPieces.map((p) => p.lane))).toContain(0);
  });

  it("is deterministic across calls", () => {
    const shape = northLine(41.826, -71.4, 400);
    const input = [{ id: "B", shape }, { id: "A", shape }];
    expect(JSON.stringify(offsetColinearRoutes(input)))
      .toBe(JSON.stringify(offsetColinearRoutes(input)));
  });

  it("handles empty and degenerate shapes without throwing", () => {
    expect(offsetColinearRoutes([])).toEqual([]);
    expect(offsetColinearRoutes([{ id: "A", shape: [] }])).toEqual([]);
    expect(offsetColinearRoutes([{ id: "A", shape: [{ lat: 41.8, lng: -71.4 }] }])).toEqual([]);
  });
});

describe("against the real Brown route shapes", () => {
  const feed = parseStaticFeed(new Uint8Array(readFileSync("test/fixtures/gtfs.zip")));
  const active = ["3302", "3469", "3470", "22427", "62487"];
  const routes = active
    .map((id) => feed.routes.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r && r.shape.length >= 2)
    .map((r) => ({ id: r.id, shape: r.shape }));
  const pieces = offsetColinearRoutes(routes);

  it("finds real shared corridors between Brown's routes", () => {
    // The Evening loops and the Daytime Express all run Thayer/Angell. If no
    // piece is offset, the resampling or the tolerance is wrong.
    expect(pieces.some((p) => p.lane !== 0)).toBe(true);
  });

  it("keeps every route drawable", () => {
    for (const r of routes) {
      const mine = pieces.filter((p) => p.routeId === r.id);
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.some((p) => p.path.length >= 2)).toBe(true);
    }
  });

  it("does not hand the renderer thousands of features", () => {
    // One feature per resampled segment would be unusable on a phone.
    expect(pieces.length).toBeLessThan(200);
  });
});
