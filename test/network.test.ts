import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStaticFeed } from "../src/data/gtfs";
import type { Pt } from "../src/render/bundle";
import { buildEdges, laneOffsets, drawLanes } from "../src/render/graph";
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
/** Mirrors MIN_EDGE_VERTS in TransitMap. */
const MIN_EDGE_VERTS = 6;

// The same projection TransitMap uses: a flat plane about Brown's latitude.
const M_PER_DEG_LAT = 111_320;
const mPerDegLng = M_PER_DEG_LAT * Math.cos((41.8265 * Math.PI) / 180);
const toPlane = (p: LatLng): Pt => ({ x: p.lng * mPerDegLng, y: p.lat * M_PER_DEG_LAT });
const fromPlane = (p: Pt): LatLng => ({ lng: p.x / mPerDegLng, lat: p.y / M_PER_DEG_LAT });

/** Resample every `step` metres, keeping the original vertices -- the same
 *  step the map uses, so shared vertices stay shared. */
function densify(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.round(d / step));
    for (let k = 1; k <= n; k++)
      out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/**
 * The network as drawn at one zoom, through the SAME pipeline as the map.
 *
 * This used to run the old per-vertex bundler, which the app no longer uses --
 * so it was asserting invariants about geometry nobody sees. It now builds the
 * corridor graph exactly as TransitMap does.
 */
function drawAt(zoom: number): Map<string, LatLng[]> {
  const mpp = (156_543.03392 * Math.cos((41.8265 * Math.PI) / 180)) / 2 ** zoom;
  const active = [...feed.routes.values()]
    .filter((r) => ACTIVE.has(r.id) && r.shape.length >= 2);
  const paths = active.map((r) => densify(r.shape.map(toPlane), 10));
  const edges = buildEdges(paths, MIN_EDGE_VERTS);
  const lanes = drawLanes(paths, laneOffsets(paths, edges, MIN_EDGE_VERTS),
                          zoom < 13 ? 0 : 5 * mpp, 10 * mpp);
  const out = new Map<string, LatLng[]>();
  active.forEach((r, i) => out.set(r.id, lanes[i]!.map(fromPlane)));
  return out;
}

/** How far `p` is from the nearest vertex of `line`, metres. */
const offLine = (p: LatLng, line: LatLng[]) =>
  Math.min(...line.map((q) => haversineMeters(p, q)));

describe("every bead sits on the line it belongs to", () => {
  // A station used to be snapped onto the FIRST of its routes only, so at an
  // interchange the dot sat on one line and floated metres from the others.
  for (const zoom of [13, 15, 17]) {
    it(`at zoom ${zoom}`, () => {
      const drawn = drawAt(zoom);
      const { beads } = stationFeatures(feed, ACTIVE, drawn);
      expect(beads.length).toBeGreaterThan(20);
      let worst = 0;
      for (const b of beads) {
        const line = drawn.get(String(b.properties?.["routeId"] ?? ""));
        if (!line || b.geometry.type !== "Point") continue;
        const [lng, lat] = b.geometry.coordinates as [number, number];
        worst = Math.max(worst, offLine({ lat, lng }, line));
      }
      // Snapped onto the drawn line, so this is sampling error and nothing else.
      expect(worst).toBeLessThan(6);
    });
  }
});

describe("an interchange is one place, not several dots", () => {
  it("gives every line a bead and joins them with one tick", () => {
    const drawn = drawAt(15);
    const { beads, ticks } = stationFeatures(feed, ACTIVE, drawn);
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
    const drawn = drawAt(zoom);
    const { beads, ticks } = stationFeatures(feed, ACTIVE, drawn);
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
    const drawn = drawAt(15);
    const { beads, ticks } = stationFeatures(feed, ACTIVE, drawn);
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

describe("the bar sits under the beads it joins", () => {
  // Placed at the station's own coordinate instead of at a bead, the stub bar
  // for a coincident interchange landed several metres away -- a white blob in
  // the middle of a block, nowhere near the dot it was meant to be under.
  // Station coordinates are the average of their member stops and are NOT
  // snapped to any drawn line; beads are.
  for (const zoom of [13, 15, 17]) {
    it(`at zoom ${zoom}`, () => {
      const drawn = drawAt(zoom);
      const { beads, ticks } = stationFeatures(feed, ACTIVE, drawn);
      const beadsById = new Map<string, LatLng[]>();
      for (const b of beads) {
        if (b.geometry.type !== "Point") continue;
        const [lng, lat] = b.geometry.coordinates as [number, number];
        const id = String(b.properties?.["id"]);
        beadsById.set(id, [...(beadsById.get(id) ?? []), { lat, lng }]);
      }
      let worst = 0;
      for (const t of ticks) {
        if (t.geometry.type !== "LineString") continue;
        const mine = beadsById.get(String(t.properties?.["id"])) ?? [];
        for (const [lng, lat] of t.geometry.coordinates as [number, number][])
          worst = Math.max(worst, Math.min(...mine.map((b) => haversineMeters(b, { lat, lng }))));
      }
      // Every end of every bar is on one of that station's own beads.
      expect(worst).toBeLessThan(1);
    });
  }
});
