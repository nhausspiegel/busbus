import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStaticFeed } from "../src/data/gtfs";
import { parseRoutePaths, fillMissingShapes, parseRouteStops, withRouteStops } from "../src/data/routePaths";
import { stations, stopRoutes, routeStops } from "../src/routing/routeDetail";
import { haversineMeters } from "../src/routing/walk";

/**
 * Brown Stadium Loop is in the GTFS and cannot be drawn from it.
 *
 * Measured against the live feed on 2026-08-29: routes.txt carries 22427
 * "Brown Stadium Loop" with its colour, trips.txt has ZERO trips for it, and
 * shapes.txt holds only four shape_ids -- 62487, 3302, 3470, 3469. So the
 * export ships the route's name and nothing to put on a map, which is why it
 * was missing from a map that Passio's own app draws it on.
 *
 * The private endpoint has it: routePoints["22427"] is 170 points, and its
 * three stops (Faunce Arch, 277 Lloyd Ave, Brown Stadium) are all already in
 * stops.txt. The same payload's point counts match shapes.txt exactly for the
 * routes that have both -- 3302:177, 3469:24, 3470:31 -- so this is the same
 * geometry, not a second opinion about it.
 */
const payload = JSON.parse(readFileSync("test/fixtures/route-paths.json", "utf8"));
const feed = parseStaticFeed(new Uint8Array(readFileSync("public/gtfs/google_transit.zip")));

describe("parseRoutePaths", () => {
  it("reads the polyline the GTFS leaves out", () => {
    const paths = parseRoutePaths(payload);
    expect(paths.get("22427")).toHaveLength(170);
    const first = paths.get("22427")![0]!;
    expect(first.lat).toBeCloseTo(41.827061, 5);
    expect(first.lng).toBeCloseTo(-71.402947, 5);
  });

  it("keeps the points in order, as a path rather than a cloud", () => {
    const pts = parseRoutePaths(payload).get("22427")!;
    // 5.2km of trace that returns to within 5.9m of where it started: it is a
    // loop, and it is in driving order. (Passio's own `distance` field reads
    // 903, which is not metres -- Brown Stadium alone is about 2km from
    // Faunce Arch.) Both numbers below are what ordering buys: shuffle the
    // points and consecutive hops jump to the diameter of the loop while the
    // ends stop meeting.
    const hops = pts.slice(1).map((p, i) => haversineMeters(pts[i]!, p));
    expect(Math.max(...hops)).toBeLessThan(250);
    expect(haversineMeters(pts[pts.length - 1]!, pts[0]!)).toBeLessThan(20);
  });

  it("drops a route whose points are unusable rather than guessing", () => {
    expect(parseRoutePaths({ routePoints: { "9": [[{ lat: "x", lng: "y" }]] } }).get("9")).toBeUndefined();
    expect(parseRoutePaths({}).size).toBe(0);
    expect(parseRoutePaths(null).size).toBe(0);
  });
});

describe("fillMissingShapes", () => {
  it("gives the Stadium Loop something to draw", () => {
    expect(feed.routes.get("22427")!.shape).toHaveLength(0);
    const filled = fillMissingShapes(feed, parseRoutePaths(payload));
    expect(filled.routes.get("22427")!.shape.length).toBe(170);
  });

  it("never overwrites a shape the GTFS already has", () => {
    // GTFS is the source of record. This only speaks where it is silent, or
    // the private feed's own drift would start moving lines the tests pin.
    const before = feed.routes.get("3469")!.shape;
    fillMissingShapes(feed, parseRoutePaths(payload));
    expect(feed.routes.get("3469")!.shape).toBe(before);
  });
});

describe("the stops a route serves, where the GTFS lost them", () => {
  /**
   * Same export defect as the missing shape, one field over. Measured
   * 2026-08-29 against trips.txt: the Connector has 38 trips covering 14
   * stops and the Evening routes 62 and 86 trips covering 11 and 12 -- all
   * matching what Passio publishes. The Daytime Express has ONE trip covering
   * TWO stops where Passio lists NINE, and the Stadium Loop has no trips at
   * all against Passio's four.
   *
   * So the map drew two dots on a route that calls at nine, and none on the
   * Stadium Loop. Which stops a route serves, in what order, is the one thing
   * this project already trusts the schedule data for; taking the fuller list
   * is not a claim about when anything runs.
   */
  it("reads the stop list Passio publishes", () => {
    const stops = parseRouteStops(payload);
    expect(stops.get("22427")).toEqual(["40950", "68995", "68996", "68995"]);
  });

  it("puts the Stadium Loop's stops on the map", () => {
    const f = parseStaticFeed(new Uint8Array(readFileSync("public/gtfs/google_transit.zip")));
    const active = new Set(["22427"]);
    expect(stations(f, active)).toEqual([]);          // nothing to draw today

    withRouteStops(f, parseRouteStops(payload));
    const drawn = stations(f, active);
    const names = drawn.map((s) => s.name).sort();
    expect(names).toContain("Brown Stadium");
    expect(drawn.every((s) => s.routeIds.includes("22427"))).toBe(true);
  });

  it("leaves the routing candidate filter alone", () => {
    // stopRoutes() decides which stops may take one of the eight candidate
    // slots when planning. A stop known only from this list has no trip and
    // so no times to ride on; letting it compete for a slot is exactly how
    // unservable stops crowded real ones out before.
    const f = parseStaticFeed(new Uint8Array(readFileSync("public/gtfs/google_transit.zip")));
    withRouteStops(f, parseRouteStops(payload));
    expect(stopRoutes(f).get("68996")).toBeUndefined();
  });
});

describe("the Stadium Loop's route page", () => {
  it("lists its stops like any other line", () => {
    // Tapping a route opens its stop list. Every other line fills that from
    // its trips; 22427 has none, so the page came up empty while the line was
    // drawn on the map beside it. Same list the map uses, in riding order.
    const f = parseStaticFeed(new Uint8Array(readFileSync("public/gtfs/google_transit.zip")));
    withRouteStops(f, parseRouteStops(payload));
    const rows = routeStops(f, new Map(), "22427", 0);
    expect(rows.map((r) => r.stop.name)).toEqual(["Faunce Arch", "277 Lloyd Ave", "Brown Stadium"]);
    // No live departures in this board, and none invented for it.
    expect(rows.every((r) => r.next === null)).toBe(true);
  });
});
