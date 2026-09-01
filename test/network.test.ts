import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStaticFeed } from "../src/data/gtfs";
import { laneApprox, laneIndex, laneSnap } from "../src/render/lanes";
import { parseSnapped } from "../src/data/snappedShapes";
import { stationFeatures, rideFeatures } from "../src/render/network";
import { haversineMeters } from "../src/routing/walk";
import type { LatLng } from "../src/data/types";

/**
 * The invariants four separate defects broke, checked against the real feed.
 *
 * Every one of them was "two geometries for one thing": vehicles beside their
 * own line, stops drifting off it, the itinerary's ride sliced from the raw
 * Passio shape while the route under it came from the bundler, and the ends of
 * a ride drawn as their own symbol beside the stops already there. Each was
 * found by eye, in production, one at a time. They are arithmetic, so they
 * belong here rather than in a screenshot.
 */
const feed = parseStaticFeed(new Uint8Array(readFileSync("public/gtfs/google_transit.zip")));
const ACTIVE = new Set(["3302", "3469", "3470", "22427", "62487"]);

/** The snapped road centrelines the app actually draws. */
const snapped = parseSnapped(
  JSON.parse(readFileSync("public/gtfs/shapes-snapped.json", "utf8")));

/** Where the lines land at one zoom, as the map places stops against them.
 *
 *  MapLibre applies the lane offset itself, so this is the same displacement
 *  the GPU will use -- see laneApprox. The bundler this used to call is gone. */
function drawAt(zoom: number): Map<string, LatLng[]> {
  const mpp = (78_271.51696 * Math.cos((41.8265 * Math.PI) / 180)) / 2 ** zoom;
  return laneApprox(new Map([...snapped].filter(([id]) => ACTIVE.has(id))), 5, mpp);
}

/** How far `p` is from `line`, metres -- point to SEGMENT, not to the nearest
 *  vertex. The snapped centrelines have vertices up to 168m apart on a straight
 *  block, so a point sitting exactly ON the line can be 84m from any vertex.
 *  The nearest-vertex version this replaces reported 51.3m for a bead that is
 *  1.0m off its line; it went unnoticed because the loop using it never ran. */
const offLine = (p: LatLng, line: LatLng[]) => {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!, b = line[i]!;
    const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
    const dx = (b.lng - a.lng) * kx, dy = (b.lat - a.lat) * 111_320;
    const l2 = dx * dx + dy * dy;
    const t = l2 < 1e-12 ? 0
      : Math.max(0, Math.min(1, (((p.lng - a.lng) * kx) * dx + ((p.lat - a.lat) * 111_320) * dy) / l2));
    best = Math.min(best,
      Math.hypot((p.lng - a.lng) * kx - t * dx, (p.lat - a.lat) * 111_320 - t * dy));
  }
  return best;
};

const mppAt = (zoom: number) =>
  (78_271.51696 * Math.cos((41.8265 * Math.PI) / 180)) / 2 ** zoom;

/** The placement the map uses: project onto the shared centreline once, then
 *  apply the lane offset. Deliberately a DIFFERENT code path from `drawAt`,
 *  which displaces every vertex -- so checking one against the other is a real
 *  cross-check rather than a function compared with itself. */
function placeAt(zoom: number) {
  const shapes = new Map([...snapped].filter(([id]) => ACTIVE.has(id)));
  const lanes = laneIndex(shapes);
  const mpp = mppAt(zoom);
  return (routeId: string, at: LatLng) =>
    laneSnap(shapes, lanes, routeId, at, 5, mpp);
}

describe("every bead sits on the line it belongs to", () => {
  // A station used to be snapped onto the FIRST of its routes only, so at an
  // interchange the dot sat on one line and floated metres from the others.
  for (const zoom of [13, 15, 17]) {
    it(`at zoom ${zoom}`, () => {
      const drawn = drawAt(zoom);
      const { beads } = stationFeatures(feed, ACTIVE, placeAt(zoom));
      expect(beads.length).toBeGreaterThan(20);
      let worst = 0, checked = 0;
      for (const b of beads) {
        const line = drawn.get(String(b.properties?.["routeId"] ?? ""));
        if (!line || b.geometry.type !== "Point") continue;
        const [lng, lat] = b.geometry.coordinates as [number, number];
        worst = Math.max(worst, offLine({ lat, lng }, line));
        checked++;
      }
      // This loop skipped EVERY iteration for the whole life of the stop defect,
      // because beads carried no `routeId` and the lookup missed. A loop that
      // can `continue` on a miss has to say how many times it did not.
      expect(checked).toBe(beads.length);
      // Compared against a different displacement (`laneApprox` moves every
      // vertex by its own segment's normal, with no miter), so the residue is
      // that shear at corners, not placement error. Measured worst: 1.0m.
      expect(worst).toBeLessThan(3);
    });
  }
});

describe("an interchange is one place, not several dots", () => {
  it("gives every line a bead and joins them with one tick", () => {
    const { beads, ticks } = stationFeatures(feed, ACTIVE, placeAt(15));
    const byStation = new Map<string, number>();
    for (const b of beads) {
      const id = String(b.properties?.["id"]);
      byStation.set(id, (byStation.get(id) ?? 0) + 1);
    }
    const interchanges = [...byStation.values()].filter((n) => n > 1).length;
    expect(interchanges).toBeGreaterThan(5);
    // One tick per interchange whose beads are far enough apart to span.
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThanOrEqual(interchanges);
  });
});

describe("a ride is the part of the route the rider is on", () => {
  const drawn = drawAt(15);
  const ride = (routeId: string, boardStopId: string, alightStopId: string) =>
    rideFeatures(feed, {
      rides: [{ routeId, boardStopId, alightStopId, color: "#111", path: [] }],
    }, drawn)[0];

  it("stops where the rider gets off", () => {
    // Sciences Library -> Brook St/Fox Point came out as 5,916m of a 7,917m
    // route, because the nearest vertex to the alight stop was on the RETURN
    // pass. The highlight ran most of the way round the loop.
    const f = ride("62487", "7851", "7853")!;
    expect(f).toBeTruthy();
    const co = (f.geometry as GeoJSON.LineString).coordinates as [number, number][];
    const path = co.map(([lng, lat]) => ({ lat, lng }));
    let len = 0;
    for (let i = 1; i < path.length; i++) len += haversineMeters(path[i - 1]!, path[i]!);
    const alight = feed.stops.get("7853")!;
    expect(len).toBeLessThan(1500);
    expect(haversineMeters(path[path.length - 1]!, alight)).toBeLessThan(30);
  });

  it("is drawn on the same geometry as the route under it", () => {
    // It used to be sliced from the raw Passio shape while the route beneath
    // came from the bundler, which moves a route wherever it shares a street:
    // two lines for one road, a few metres apart, stacked.
    const f = ride("62487", "7851", "7853")!;
    const co = (f.geometry as GeoJSON.LineString).coordinates as [number, number][];
    const line = drawn.get("62487")!;
    let worst = 0;
    for (const [lng, lat] of co) worst = Math.max(worst, offLine({ lat, lng }, line));
    expect(worst).toBeLessThan(0.5);
  });

  it("draws nothing rather than guessing when the stops are unknown", () => {
    expect(rideFeatures(feed, { rides: [{
      routeId: "62487", color: "#111", path: [],
    }] }, drawn)).toEqual([]);
  });
});

describe("an interchange always has a bar to sit on", () => {
  // The bar is what gives an interchange its white background -- a lone stop
  // has its own circle, an interchange does not, because one circle per bead
  // turns the station into a cluster of overlapping circles. So when a
  // station's beads coincided and no bar was emitted, the stop rendered as a
  // bare dot. Reported as "isn't rendering correctly at some zoom levels",
  // which is exactly right: whether the beads coincide depends on the lane
  // gap, which depends on zoom.
  const audit = (zoom: number) => {
    const { beads, ticks } = stationFeatures(feed, ACTIVE, placeAt(zoom));
    const withBar = new Set(ticks.map((t) => String(t.properties?.["id"])));
    const count = new Map<string, number>();
    for (const b of beads) {
      const id = String(b.properties?.["id"]);
      count.set(id, (count.get(id) ?? 0) + 1);
    }
    const interchanges = [...count].filter(([, n]) => n > 1).map(([id]) => id);
    return {
      interchanges: interchanges.length,
      withoutBar: interchanges.filter((id) => !withBar.has(id)).length,
    };
  };

  for (const zoom of [11, 13, 15, 17]) {
    it(`at zoom ${zoom}`, () => {
      const { interchanges, withoutBar } = audit(zoom);
      expect(interchanges).toBeGreaterThan(5);
      expect(withoutBar).toBe(0);
    });
  }

  it("gives a lone stop no bar at all", () => {
    // It has its own circle; a bar as well would be a second symbol.
    const { beads, ticks } = stationFeatures(feed, ACTIVE, placeAt(15));
    const count = new Map<string, number>();
    for (const b of beads) {
      const id = String(b.properties?.["id"]);
      count.set(id, (count.get(id) ?? 0) + 1);
    }
    const lone = new Set([...count].filter(([, n]) => n === 1).map(([id]) => id));
    expect(lone.size).toBeGreaterThan(5);
    expect(ticks.filter((t) => lone.has(String(t.properties?.["id"])))).toEqual([]);
  });
});
