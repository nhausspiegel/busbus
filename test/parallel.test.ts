import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { laneProfiles, offsetPath } from "../src/routing/parallel";
import { parseStaticFeed } from "../src/data/gtfs";
import { haversineMeters } from "../src/routing/walk";
import type { LatLng } from "../src/data/types";

const LANE_PX = 5;

/** A straight run north along one longitude, from lat0 for `metres`. */
function northLine(lat0: number, lng: number, metres: number, points = 3): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i < points; i++)
    out.push({ lat: lat0 + (metres / 111_320) * (i / (points - 1)), lng });
  return out;
}

const length = (path: LatLng[]) => {
  let m = 0;
  for (let i = 1; i < path.length; i++) m += haversineMeters(path[i - 1]!, path[i]!);
  return m;
};

const profileFor = (ps: ReturnType<typeof laneProfiles>, id: string) => {
  const p = ps.find((q) => q.routeId === id);
  if (!p) throw new Error(`no profile for ${id}`);
  return p;
};

describe("laneProfiles", () => {
  it("leaves a route that runs alone exactly on its own shape", () => {
    // The previous design gave every route a lane for its whole length, so all
    // four floated beside the streets they follow even where nothing else ran
    // there. A route with no company belongs on the centreline, at every zoom.
    const shape = northLine(41.826, -71.4, 400);
    const [p] = laneProfiles([{ id: "A", shape }]);
    expect(p!.lanes.every((l) => l === 0)).toBe(true);
    expect(offsetPath(p!, 8, LANE_PX)).toEqual(p!.path);
  });

  it("separates two routes sharing a corridor by a constant pixel gap", () => {
    const shape = northLine(41.826, -71.4, 400);
    const ps = laneProfiles([{ id: "A", shape }, { id: "B", shape }]);
    const a = offsetPath(profileFor(ps, "A"), 2, LANE_PX);
    const b = offsetPath(profileFor(ps, "B"), 2, LANE_PX);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++)
      expect(haversineMeters(a[i]!, b[i]!)).toBeCloseTo(LANE_PX * 2, 0);
  });

  it("holds that gap in pixels as the rider zooms", () => {
    // Baking the offset into the geometry means it has to be rebuilt per zoom.
    // If it did not scale, one zoom level would overlap and another would fling
    // the lines a block apart.
    const shape = northLine(41.826, -71.4, 400);
    const ps = laneProfiles([{ id: "A", shape }, { id: "B", shape }]);
    const gap = (mpp: number) =>
      haversineMeters(offsetPath(profileFor(ps, "A"), mpp, LANE_PX)[5]!,
                      offsetPath(profileFor(ps, "B"), mpp, LANE_PX)[5]!);
    expect(gap(1)).toBeCloseTo(LANE_PX, 0);
    expect(gap(4)).toBeCloseTo(LANE_PX * 4, 0);
  });

  it("draws a corridor run in opposite directions on opposite sides", () => {
    // The Evening CW and CCW loops run the same streets in reverse, and a lane
    // number means "this far to the right of MY direction of travel". Give one
    // -0.5 and the other +0.5 and both land on the SAME side of the street:
    // measured on the real feed, offsetting moved the two loops from 1.27px
    // apart to 1.55px. The lane has to be resolved against a shared reference
    // direction, not each route's own.
    const shape = northLine(41.826, -71.4, 400);
    const ps = laneProfiles([{ id: "A", shape }, { id: "B", shape: [...shape].reverse() }]);
    const a = offsetPath(profileFor(ps, "A"), 2, LANE_PX);
    const b = offsetPath(profileFor(ps, "B"), 2, LANE_PX);
    for (const q of a) {
      let nearest = Infinity;
      for (const r of b) nearest = Math.min(nearest, haversineMeters(q, r));
      expect(nearest).toBeGreaterThan(LANE_PX * 2 * 0.8);
    }
  });

  it("does not push apart two routes that merely cross", () => {
    // A crossing shares one intersection, not a corridor. Offsetting there
    // bends both lines off the streets they actually follow.
    const northSouth = northLine(41.824, -71.4, 600);
    const eastWest: LatLng[] = [
      { lat: 41.8267, lng: -71.4035 }, { lat: 41.8267, lng: -71.3965 },
    ];
    const ps = laneProfiles([{ id: "A", shape: northSouth }, { id: "B", shape: eastWest }]);
    for (const p of ps) expect(p.lanes.every((l) => l === 0)).toBe(true);
  });

  it("returns a route to the centreline once its corridor-mate leaves", () => {
    const long = northLine(41.820, -71.4, 800, 40);
    const short = northLine(41.820, -71.4, 300, 20);
    const ps = laneProfiles([{ id: "A", shape: long }, { id: "B", shape: short }]);
    const a = profileFor(ps, "A");
    expect(Math.abs(a.lanes[0]!)).toBeGreaterThan(0.4);          // shared at the south end
    expect(a.lanes[a.lanes.length - 1]).toBe(0);                 // alone at the north end
  });

  it("tapers a lane change instead of stepping sideways", () => {
    // A step is what drew the Connector as two parallel orange lines meeting
    // in an X. The lane has to ramp over tens of metres, not jump.
    const long = northLine(41.820, -71.4, 800, 40);
    const short = northLine(41.820, -71.4, 300, 20);
    const a = profileFor(laneProfiles([{ id: "A", shape: long }, { id: "B", shape: short }]), "A");
    for (let i = 1; i < a.lanes.length; i++)
      expect(Math.abs(a.lanes[i]! - a.lanes[i - 1]!)).toBeLessThan(0.15);
  });

  it("adds points along the shape without moving it", () => {
    // Densifying is what makes a taper expressible: route 3469 has vertices
    // ~500m apart. The added points must lie ON the source polyline, so the
    // drawn centreline is the shape, not a smoothed approximation of it.
    const shape = northLine(41.820, -71.4, 800, 5);
    const [p] = laneProfiles([{ id: "A", shape }]);
    expect(p!.path.length).toBeGreaterThan(shape.length);
    expect(length(p!.path)).toBeCloseTo(length(shape), 1);
  });

  it("keeps lanes, normals and points in step", () => {
    const shape = northLine(41.826, -71.4, 400);
    const [p] = laneProfiles([{ id: "A", shape }]);
    expect(p!.lanes.length).toBe(p!.path.length);
    expect(p!.normals.length).toBe(p!.path.length);
  });

  it("is deterministic across calls", () => {
    const shape = northLine(41.826, -71.4, 400);
    const input = [{ id: "B", shape }, { id: "A", shape }];
    expect(JSON.stringify(laneProfiles(input))).toBe(JSON.stringify(laneProfiles(input)));
  });

  it("handles empty and degenerate shapes without throwing", () => {
    expect(laneProfiles([])).toEqual([]);
    expect(laneProfiles([{ id: "A", shape: [] }])).toEqual([]);
    expect(laneProfiles([{ id: "A", shape: [{ lat: 41.8, lng: -71.4 }] }])).toEqual([]);
  });
});

describe("against the real Brown route shapes", () => {
  const feed = parseStaticFeed(new Uint8Array(readFileSync("test/fixtures/gtfs.zip")));
  const routes = ["3302", "3469", "3470", "22427", "62487"]
    .map((id) => feed.routes.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r && r.shape.length >= 2)
    .map((r) => ({ id: r.id, shape: r.shape }));
  const profiles = laneProfiles(routes);

  it("finds real shared corridors between Brown's routes", () => {
    // The Evening loops and the Daytime Express all run Thayer/Angell.
    expect(profiles.some((p) => p.lanes.some((l) => l !== 0))).toBe(true);
  });

  const offsetFraction = (id: string) => {
    const lanes = profileFor(profiles, id).lanes;
    return lanes.filter((l) => Math.abs(l) > 0.05).length / lanes.length;
  };

  it("leaves the mostly-unshared routes on their own streets", () => {
    // The Daytime Express and the Connector meet the rest of the network for
    // only part of their length. Measured: 31% of each. If this climbs, the
    // corridor test is matching streets that are not shared and the whole
    // network floats off its roads -- which is what the old whole-route lane
    // did and what the user called worse.
    expect(offsetFraction("3302")).toBeLessThan(0.5);
    expect(offsetFraction("62487")).toBeLessThan(0.5);
  });

  it("offsets the Evening loops, which run the same streets both ways", () => {
    // 3469 and 3470 are the same loop clockwise and anticlockwise. Nearly
    // every point genuinely shares a street with the other, so a low number
    // here means the direction-agnostic heading test has broken.
    expect(offsetFraction("3469")).toBeGreaterThan(0.8);
    expect(offsetFraction("3470")).toBeGreaterThan(0.8);
  });

  it("hands the renderer one polyline per route", () => {
    expect(profiles.length).toBe(routes.length);
    for (const r of routes) expect(profileFor(profiles, r.id).path.length).toBeGreaterThan(1);
  });

  it("never draws two routes closer together than their shapes already are", () => {
    // Passio already separates the Evening CW and CCW shapes by about 7m --
    // each direction on its own side of the street, the way traffic runs. Give
    // them lanes in the wrong order and the offset pulls them TOWARDS each
    // other: measured, they crossed over and sat 0.8px apart at z17 while
    // being 8px apart at z18. An offset may only ever add separation.
    const a = profileFor(profiles, "3469"), b = profileFor(profiles, "3470");
    const nearest = (q: LatLng, poly: LatLng[]) =>
      Math.min(...poly.map((r) => haversineMeters(q, r)));
    const shared = a.path
      .map((q, i) => ({ i, raw: nearest(q, b.path) }))
      .filter((x) => x.raw < 25);
    expect(shared.length).toBeGreaterThan(100);          // fixture exercises this

    for (const mpp of [0.44, 2.5, 6.2]) {
      const A = offsetPath(a, mpp, LANE_PX), B = offsetPath(b, mpp, LANE_PX);
      const closer = shared.filter((s) => nearest(A[s.i]!, B) < s.raw - 0.5).length;
      expect(closer / shared.length).toBeLessThan(0.05);
    }
  });

  it("draws a line no longer than the street it follows", () => {
    // The anti-scallop check. An offset that wobbles point to point inflates
    // the drawn length; a clean parallel line barely changes it.
    for (const p of profiles) {
      const drawn = length(offsetPath(p, 2, LANE_PX));
      expect(drawn).toBeLessThan(length(p.path) * 1.02);
    }
  });

  it("never doubles back on itself at street zoom", () => {
    // A kink -- a segment pointing backwards relative to the centreline -- is
    // exactly what "jagged" looks like on screen.
    for (const p of profiles) {
      const drawn = offsetPath(p, 2, LANE_PX);
      let kinks = 0;
      for (let i = 1; i < drawn.length; i++) {
        const centre = haversineMeters(p.path[i - 1]!, p.path[i]!);
        if (centre < 1) continue;
        if (haversineMeters(drawn[i - 1]!, drawn[i]!) > centre * 2 + 2) kinks++;
      }
      expect(kinks).toBe(0);
    }
  });
});
