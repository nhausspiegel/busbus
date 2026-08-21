import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { offsetColinearRoutes } from "../src/routing/parallel";
import { parseStaticFeed } from "../src/data/gtfs";
import { haversineMeters } from "../src/routing/walk";
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

describe("emitted geometry stays smooth", () => {
  const feed = parseStaticFeed(new Uint8Array(readFileSync("test/fixtures/gtfs.zip")));
  const routes = ["3302", "3469", "3470", "62487"]
    .map((id) => feed.routes.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r && r.shape.length >= 2)
    .map((r) => ({ id: r.id, shape: r.shape }));

  it("does not multiply a route's vertex count", () => {
    // Resampling to 12m for ANALYSIS is necessary -- shapes arrive at wildly
    // different densities. Emitting those samples is not: MapLibre applies
    // line-offset per vertex, so a smooth 500m arc turned into 40 points
    // scallops visibly. Route 3469 went from 24 vertices to 311.
    const pieces = offsetColinearRoutes(routes);
    for (const r of routes) {
      const emitted = pieces
        .filter((p) => p.routeId === r.id)
        .reduce((n, p) => n + p.path.length, 0);
      // Lane splits duplicate a vertex at each join, so allow modest growth.
      expect(emitted).toBeLessThanOrEqual(r.shape.length + 40);
    }
  });

  it("keeps segments as long as the source geometry", () => {
    const pieces = offsetColinearRoutes(routes);
    const lengths: number[] = [];
    for (const p of pieces)
      for (let i = 1; i < p.path.length; i++)
        lengths.push(haversineMeters(p.path[i - 1]!, p.path[i]!));
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    // 12m resampling produced a mean of 11.8m; real shapes are far coarser.
    expect(mean).toBeGreaterThan(25);
  });

  it("emits vertices that exist in the source shape", () => {
    const pieces = offsetColinearRoutes(routes);
    const src = new Set(
      routes.flatMap((r) => r.shape.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`)));
    for (const p of pieces)
      for (const q of p.path)
        expect(src.has(`${q.lat.toFixed(6)},${q.lng.toFixed(6)}`)).toBe(true);
  });

  it("still leaves no gap where the lane changes", () => {
    const pieces = offsetColinearRoutes(routes);
    for (const r of routes) {
      const mine = pieces.filter((p) => p.routeId === r.id);
      for (let i = 1; i < mine.length; i++) {
        const a = mine[i - 1]!.path[mine[i - 1]!.path.length - 1]!;
        const b = mine[i]!.path[0]!;
        expect(haversineMeters(a, b)).toBeLessThan(1);
      }
    }
  });
});
