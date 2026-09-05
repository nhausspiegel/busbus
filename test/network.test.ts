import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStaticFeed } from "../src/data/gtfs";
import { laneApprox, laneIndex, stationLanes } from "../src/render/lanes";
import { parseSnapped } from "../src/data/snappedShapes";
import { stationFeatures, rideFeatures } from "../src/render/network";
import { haversineMeters } from "../src/routing/walk";
import { stations } from "../src/routing/routeDetail";
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

/** The placement the map uses: project the whole station onto ONE segment and
 *  lay its routes along that segment's normal. Deliberately a DIFFERENT code
 *  path from `drawAt`, which displaces every vertex -- so checking one against
 *  the other is a real cross-check rather than a function compared with
 *  itself. */
function placeAt(zoom: number) {
  const shapes = new Map([...snapped].filter(([id]) => ACTIVE.has(id)));
  const lanes = laneIndex(shapes);
  const mpp = mppAt(zoom);
  return (routeIds: string[], at: LatLng) =>
    stationLanes(shapes, lanes, routeIds, at, 5, mpp);
}

/**
 * The street a station stands on, and the routes running along it.
 *
 * Derived here from the snapped centrelines rather than imported, because an
 * expectation computed with a helper from the module under test agrees with
 * that module however wrong both are -- a previous test did exactly that and
 * passed with the offset's sign flipped.
 */
function street(routeIds: string[], at: LatLng) {
  const KX = 111_320 * Math.cos((at.lat * Math.PI) / 180), K = 111_320;
  const px = at.lng * KX, py = at.lat * K;
  let best = Infinity, a = { lat: 0, lng: 0 }, b = { lat: 0, lng: 0 };
  for (const id of routeIds) {
    const pts = snapped.get(id) ?? [];
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1]!.lng * KX, ay = pts[i - 1]!.lat * K;
      const vx = pts[i]!.lng * KX - ax, vy = pts[i]!.lat * K - ay;
      const l2 = vx * vx + vy * vy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2));
      const d = Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
      if (d < best) { best = d; a = pts[i - 1]!; b = pts[i]!; }
    }
  }
  // Shared nodes are byte-identical floats, so a route runs along this stretch
  // exactly when those two points are adjacent in its own shape.
  const same = (p: LatLng, q: LatLng) => p.lat === q.lat && p.lng === q.lng;
  const users = [...ACTIVE].filter((id) => (snapped.get(id) ?? []).some((p, i) =>
    i > 0 && ((same(p, a) && same(snapped.get(id)![i - 1]!, b))
           || (same(p, b) && same(snapped.get(id)![i - 1]!, a)))));
  return { a, b, users };
}

/**
 * An interchange is an oblong ACROSS the street, at every zoom.
 *
 * Perpendicular to the road, exactly one lane gap per line long, with its
 * beads on it and on their own lines. All four used to be false at some zoom
 * and true at others -- the beads were placed against each route separately,
 * so at a corner they landed on two different streets and the bar ran
 * diagonally across the junction; measured 17.9 degrees off and from 4% to
 * 281% of the length it should be. Every expectation below is derived from the
 * lane gap and the metres-per-pixel formula, not from the renderer.
 */
describe("an interchange is one oblong across the street", () => {
  const GAP = 5;
  const M = (p: LatLng, kx: number) => ({ x: p.lng * kx, y: p.lat * 111_320 });

  for (const zoom of [13, 14.2, 15, 16, 17, 18]) {
    it(`at zoom ${zoom}`, () => {
      const mpp = mppAt(zoom);
      const drawn = drawAt(zoom);
      const { beads, ticks } = stationFeatures(feed, ACTIVE, placeAt(zoom));
      const tick = new Map(ticks.map((t) => [String(t.properties?.["id"]), t]));
      const group = new Map<string, { routeId: string; p: LatLng }[]>();
      for (const b of beads) {
        const [lng, lat] = (b.geometry as GeoJSON.Point).coordinates as [number, number];
        const id = String(b.properties?.["id"]);
        group.set(id, [...(group.get(id) ?? []),
                       { routeId: String(b.properties?.["routeId"]), p: { lat, lng } }]);
      }

      let checked = 0, crossStreet = 0, onOwnLine = 0;
      let worstAngle = 0, worstLen = 0, worstSpacing = 0, worstBend = 0, worstOff = 0;
      for (const st of stations(feed, ACTIVE)) {
        const id = st.stopIds[0]!;
        const on = group.get(id);
        expect(on, `beads for ${st.name}`).toBeTruthy();
        expect(on!.length).toBe(st.routeIds.length);
        const kx = 111_320 * Math.cos((st.lat * Math.PI) / 180);
        const s = street(st.routeIds, { lat: st.lat, lng: st.lng });

        // Each bead on the line the rider sees under it -- a lone stop too,
        // which is where centring the beads on the ROAD rather than on the
        // lanes their routes hold used to put the dot half a gap off its own
        // line. A route that reaches the station from the CROSSING street
        // holds no lane on the reference segment, so it takes a slot past the
        // end of the block and is off its own line by design: that cost is
        // counted, not waived.
        for (const b of on!) {
          if (!s.users.includes(b.routeId)) { crossStreet++; continue; }
          worstOff = Math.max(worstOff, offLine(b.p, drawn.get(b.routeId)!) / mpp);
          onOwnLine++;
        }
        if (st.routeIds.length < 2) continue;

        const bar = tick.get(id);
        expect(bar, `bar for ${st.name}`).toBeTruthy();
        const co = (bar!.geometry as GeoJSON.LineString).coordinates as [number, number][];
        const ends = co.map(([lng, lat]) => ({ lat, lng }));
        const A = M(ends[0]!, kx), B = M(ends[1]!, kx);
        const U = M(s.a, kx), V = M(s.b, kx);
        const bx = B.x - A.x, by = B.y - A.y, len = Math.hypot(bx, by);
        const ux = V.x - U.x, uy = V.y - U.y;
        // Perpendicular to the street. |cos| so an antiparallel bar is the same
        // bar; acos of it lands in [0, 90] and 90 is square to the road.
        const deg = (Math.acos(Math.min(1, Math.abs(bx * ux + by * uy)
          / (len * Math.hypot(ux, uy)))) * 180) / Math.PI;
        worstAngle = Math.max(worstAngle, Math.abs(90 - deg));

        // (n-1) gaps long, in metres, from the pixel size at this zoom alone.
        const want = (st.routeIds.length - 1) * GAP * mpp;
        worstLen = Math.max(worstLen, Math.abs(len - want) / want);

        // The beads lie ON the bar, one gap apart along it.
        const along = on!.map((b) => {
          const P = M(b.p, kx);
          return ((P.x - A.x) * bx + (P.y - A.y) * by) / len;
        }).sort((x, y) => x - y);
        for (const b of on!) worstBend = Math.max(worstBend, offLine(b.p, ends) / mpp);
        for (let i = 1; i < along.length; i++)
          worstSpacing = Math.max(worstSpacing,
            Math.abs((along[i]! - along[i - 1]!) - GAP * mpp) / (GAP * mpp));

        checked++;
      }
      // Every bead accounted for, so no `continue` above can quietly empty the
      // loop -- which is exactly how the previous version of this check passed
      // for the whole life of the defect it was written for.
      expect(onOwnLine + crossStreet).toBe(beads.length);
      expect(checked).toBe(12);
      expect(worstAngle).toBeLessThanOrEqual(0.5);
      expect(worstLen).toBeLessThan(0.01);
      expect(worstSpacing).toBeLessThan(0.01);
      expect(worstBend).toBeLessThan(0.01);
      expect(worstOff).toBeLessThan(1);
      // Exactly one route in the whole network meets its station from the
      // crossing street (3469 at Cushing & Thayer). Pinned so the cost cannot
      // grow unnoticed.
      expect(crossStreet).toBe(1);
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
