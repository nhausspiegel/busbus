import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStaticFeed } from "../src/data/gtfs";
import { laneProfiles, applyLanes, DEFAULT_OPTIONS, type Line, type Pt } from "../src/render/bundle";
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

// The same projection TransitMap uses: a flat plane about Brown's latitude.
const M_PER_DEG_LAT = 111_320;
const mPerDegLng = M_PER_DEG_LAT * Math.cos((41.8265 * Math.PI) / 180);
const toPlane = (p: LatLng): Pt => ({ x: p.lng * mPerDegLng, y: p.lat * M_PER_DEG_LAT });
const fromPlane = (p: Pt): LatLng => ({ lng: p.x / mPerDegLng, lat: p.y / M_PER_DEG_LAT });

/** The network as drawn at one zoom, exactly as the map builds it. */
function drawAt(zoom: number): Map<string, LatLng[]> {
  const mpp = (156_543.03392 * Math.cos((41.8265 * Math.PI) / 180)) / 2 ** zoom;
  const lines: Line[] = [...feed.routes.values()]
    .filter((r) => ACTIVE.has(r.id) && r.shape.length >= 2)
    .map((r) => ({ id: r.id, points: r.shape.map(toPlane) }));
  const out = new Map<string, LatLng[]>();
  for (const p of laneProfiles(lines, DEFAULT_OPTIONS))
    out.set(p.id, applyLanes(p, zoom < 13 ? 0 : 5 * mpp, 10 * mpp).map(fromPlane));
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

describe("an interchange with no bar to sit on", () => {
  // A bar is only emitted when a station's beads are far enough apart to span.
  // Where a station's routes pass through the same point they are not, so no
  // bar is drawn -- and how often that happens changes with zoom, because the
  // lane gap does. The white background used to come only from that bar, so
  // those stations rendered as bare dots at some zooms and correctly at
  // others. Reported exactly that way.
  const barless = (zoom: number) => {
    const drawn = drawAt(zoom);
    const { beads, ticks } = stationFeatures(feed, ACTIVE, drawn);
    const withBar = new Set(ticks.map((t) => String(t.properties?.["id"])));
    const stations = new Set<string>();
    const multi = new Map<string, number>();
    for (const b of beads) {
      const id = String(b.properties?.["id"]);
      stations.add(id);
      multi.set(id, (multi.get(id) ?? 0) + 1);
    }
    const interchanges = [...multi].filter(([, n]) => n > 1).map(([id]) => id);
    return {
      interchanges: interchanges.length,
      withoutBar: interchanges.filter((id) => !withBar.has(id)).length,
    };
  };

  it("leaves some interchanges without one, and not the same ones at each zoom", () => {
    const counts = [11, 13, 15, 17].map(barless);
    expect(counts.every((c) => c.interchanges > 5)).toBe(true);
    // At least one zoom leaves an interchange with no bar under it.
    expect(counts.some((c) => c.withoutBar > 0)).toBe(true);
    // And the count is not constant, which is the "at some zoom levels" part.
    expect(new Set(counts.map((c) => c.withoutBar)).size).toBeGreaterThan(1);
  });

  it("is why the lozenge is per bead rather than per bar", () => {
    // stops-base carries no interchange filter: every bead gets its own white
    // circle, so a stop's background cannot depend on whether a bar happened
    // to be drawn beneath it at this particular scale.
    const { beads } = stationFeatures(feed, ACTIVE, drawAt(15));
    expect(beads.every((b) => b.geometry.type === "Point")).toBe(true);
    expect(beads.filter((b) => b.properties?.["interchange"]).length).toBeGreaterThan(5);
  });
});
