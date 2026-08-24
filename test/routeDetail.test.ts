import { describe, it, expect } from "vitest";
import { routeStops, stopRoutes, stations, nextStopIndex, headwayMinutes } from "../src/routing/routeDetail";
import type { StaticFeed, DepartureBoard, Stop } from "../src/data/types";

const NOW = 1_700_000_000;
const mk = (id: string): Stop => ({ id, name: `Stop ${id}`, lat: 41.82, lng: -71.40 });

function fixture(): { feed: StaticFeed; board: DepartureBoard } {
  const feed: StaticFeed = {
    routes: new Map([["R1", { id: "R1", name: "R1", shortName: "1", color: "#111", shape: [] }]]),
    stops: new Map([["A", mk("A")], ["B", mk("B")], ["C", mk("C")]]),
    trips: new Map([
      // A short trip that skips C, and the full loop that returns to A.
      ["short", { id: "short", routeId: "R1", stops: [
        { stopId: "A", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 120 }] }],
      ["full", { id: "full", routeId: "R1", stops: [
        { stopId: "A", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 120 },
        { stopId: "C", seq: 3, time: 240 }, { stopId: "A", seq: 4, time: 360 }] }],
      ["other", { id: "other", routeId: "R2", stops: [{ stopId: "C", seq: 1, time: 0 }] }],
    ]),
    feedEndDate: "20991231",
  };
  const board: DepartureBoard = new Map([
    ["A", [
      { stopId: "A", tripId: "x", routeId: "R1", seq: 1, time: NOW - 60, live: false },
      { stopId: "A", tripId: "y", routeId: "R1", seq: 1, time: NOW + 300, live: true },
      { stopId: "A", tripId: "z", routeId: "R2", seq: 1, time: NOW + 60, live: false },
    ]],
    ["B", []],
  ]);
  return { feed, board };
}

describe("stations", () => {
  // Passio models one physical stop as several stop_ids, one per direction:
  // measured on the real feed, 20 pairs sit within 25m of each other, such as
  // 8399 "Barbour Hall/Public Safety CCW" and 8386 "...CW" 11m apart, each
  // served by one route. Joining on stop_id makes those read as two separate
  // single-route stops, which is why interchanges never showed on the map.
  const at = (id: string, name: string, lat: number, lng: number): Stop =>
    ({ id, name, lat, lng });

  const feed = {
    routes: new Map([
      ["R1", { id: "R1", name: "R1", color: "#111", shape: [] }],
      ["R2", { id: "R2", name: "R2", color: "#222", shape: [] }],
      ["OLD", { id: "OLD", name: "OLD", color: "#333", shape: [] }],
    ]),
    stops: new Map([
      // One place, split in two by direction, one route each.
      ["cw", at("cw", "Barbour Hall (CW)", 41.8260, -71.4000)],
      ["ccw", at("ccw", "Barbour Hall", 41.82609, -71.40004)],
      // A different place entirely.
      ["far", at("far", "Sciences Library", 41.8280, -71.4000)],
      // Served only by a route that is not running.
      ["dead", at("dead", "Stadium", 41.8300, -71.4000)],
    ]),
    trips: new Map([
      ["t1", { id: "t1", routeId: "R1", stops: [{ stopId: "cw", seq: 1, time: 0 }] }],
      ["t2", { id: "t2", routeId: "R2", stops: [{ stopId: "ccw", seq: 1, time: 0 }] }],
      ["t3", { id: "t3", routeId: "R1", stops: [{ stopId: "far", seq: 1, time: 0 }] }],
      ["t4", { id: "t4", routeId: "OLD", stops: [{ stopId: "dead", seq: 1, time: 0 }] }],
    ]),
    feedEndDate: "20991231",
  } as unknown as StaticFeed;

  const active = new Set(["R1", "R2"]);

  it("merges stop ids that share a location into one station", () => {
    const got = stations(feed, active);
    const barbour = got.find((s) => s.stopIds.includes("cw"))!;
    expect(barbour.stopIds.sort()).toEqual(["ccw", "cw"]);
    expect(barbour.routeIds).toEqual(["R1", "R2"]);   // the interchange appears
  });

  it("keeps genuinely different places apart", () => {
    const got = stations(feed, active);
    expect(got.find((s) => s.stopIds.includes("far"))!.stopIds).toEqual(["far"]);
  });

  it("drops stops no running route serves", () => {
    // Brown's GTFS ships 70 stops but only 33 sit on a route that runs. The
    // rest are dots no bus will ever call at.
    expect(stations(feed, active).some((s) => s.stopIds.includes("dead"))).toBe(false);
  });

  it("takes the plainest name of the group", () => {
    // "Barbour Hall" reads better on a map than "Barbour Hall (CW)", and the
    // direction is meaningless once the two halves are one marker.
    const got = stations(feed, active);
    expect(got.find((s) => s.stopIds.includes("cw"))!.name).toBe("Barbour Hall");
  });
});

describe("stopRoutes", () => {
  it("lists every route calling at a stop, de-duplicated and sorted", () => {
    // Subway maps colour a stop by its line and draw interchanges neutrally,
    // so the map has to know which stops serve more than one route. GTFS has
    // no stop-to-route table, so it comes from the trips.
    const feed = {
      routes: new Map(), stops: new Map(),
      trips: new Map([
        ["t1", { id: "t1", routeId: "R2", stops: [
          { stopId: "A", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 60 }] }],
        ["t2", { id: "t2", routeId: "R1", stops: [
          { stopId: "B", seq: 1, time: 0 }, { stopId: "C", seq: 2, time: 60 }] }],
        // A second trip on a route already seen must not duplicate it, and a
        // loop calling twice at one stop must not either.
        ["t3", { id: "t3", routeId: "R1", stops: [
          { stopId: "B", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 60 }] }],
      ]),
      feedEndDate: "20991231",
    } as unknown as StaticFeed;

    const got = stopRoutes(feed);
    expect(got.get("A")).toEqual(["R2"]);
    expect(got.get("B")).toEqual(["R1", "R2"]);   // the interchange
    expect(got.get("C")).toEqual(["R1"]);
    expect(got.get("nope")).toBeUndefined();
  });
});

describe("routeStops with more than one bus running", () => {
  it("reads as one bus going round, not the soonest at each stop", () => {
    // Two buses on the same loop. Taking the soonest departure at each stop
    // independently is correct per row and nonsense as a column: measured on
    // the live Connector view it ran 4, 7, 10, 13, 14, 18, now, 5, 10, 12, 14,
    // 18, now, 2 -- the count restarting each time the list passed a bus.
    const feed: StaticFeed = {
      routes: new Map([["R1", { id: "R1", name: "R1", shortName: "1", color: "#111", shape: [] }]]),
      stops: new Map([["A", mk("A")], ["B", mk("B")], ["C", mk("C")], ["D", mk("D")]]),
      trips: new Map([["full", { id: "full", routeId: "R1", stops: [
        { stopId: "A", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 60 },
        { stopId: "C", seq: 3, time: 120 }, { stopId: "D", seq: 4, time: 180 }] }]]),
      feedEndDate: "20991231",
    };
    const dep = (stopId: string, tripId: string, mins: number) => ({
      stopId, tripId, routeId: "R1", seq: 1, time: NOW + mins * 60, live: true,
    });
    // Bus "near" is just behind A; bus "far" is already round at C.
    const board: DepartureBoard = new Map([
      ["A", [dep("A", "near", 2), dep("A", "far", 14)]],
      ["B", [dep("B", "near", 4), dep("B", "far", 16)]],
      ["C", [dep("C", "far", 1), dep("C", "near", 6)]],
      ["D", [dep("D", "far", 3), dep("D", "near", 8)]],
    ]);

    const got = routeStops(feed, board, "R1", NOW);
    const times = got.map((s) => s.next?.time ?? null);
    expect(times.every((t) => t !== null)).toBe(true);
    for (let i = 1; i < times.length; i++)
      expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    expect(new Set(got.map((s) => s.next!.tripId)).size).toBe(1);
  });
});

describe("routeStops", () => {
  it("uses the longest trip so skipped stops still appear", () => {
    const { feed, board } = fixture();
    expect(routeStops(feed, board, "R1", NOW).map((s) => s.stop.id)).toEqual(["A", "B", "C"]);
  });

  it("lists a looping stop once, not twice", () => {
    const { feed, board } = fixture();
    const ids = routeStops(feed, board, "R1", NOW).map((s) => s.stop.id);
    expect(ids.filter((i) => i === "A")).toHaveLength(1);
  });

  it("shows the next departure on this route only", () => {
    // Stop A also serves R2 sooner; showing that on R1's page would be wrong.
    const { feed, board } = fixture();
    const a = routeStops(feed, board, "R1", NOW)[0]!;
    expect(a.next?.routeId).toBe("R1");
    expect(a.next?.time).toBe(NOW + 300);
  });

  it("reports null rather than a stale time for a stop with nothing upcoming", () => {
    const { feed, board } = fixture();
    expect(routeStops(feed, board, "R1", NOW)[1]!.next).toBeNull();
  });

  it("returns empty for a route with no trips", () => {
    const { feed, board } = fixture();
    expect(routeStops(feed, board, "22427", NOW)).toEqual([]);
  });
});

describe("nextStopIndex", () => {
  // A square loop, one stop at each corner, so the wrap from the last stop
  // back to the first is exercised -- Brown's routes are all loops.
  const c = [
    { lat: 41.820, lng: -71.400 }, { lat: 41.820, lng: -71.395 },
    { lat: 41.825, lng: -71.395 }, { lat: 41.825, lng: -71.400 },
  ];
  const shape = [...c, c[0]!];
  const stops = c;

  it("names the stop the bus is heading for, not the one it just left", () => {
    // Just past the first corner, on the leg towards the second.
    const at = { lat: 41.820, lng: -71.3985 };
    expect(nextStopIndex(shape, stops, at)).toBe(1);
  });

  it("wraps at the end of a loop", () => {
    // On the final leg, heading back to where the list starts.
    const at = { lat: 41.8225, lng: -71.400 };
    expect(nextStopIndex(shape, stops, at)).toBe(0);
  });

  it("is unmoved by a bus sitting a few metres off its own line", () => {
    const on = { lat: 41.820, lng: -71.3985 };
    const off = { lat: 41.82005, lng: -71.3985 };
    expect(nextStopIndex(shape, stops, off)).toBe(nextStopIndex(shape, stops, on));
  });

  it("reports null when there is no shape to measure against", () => {
    // 22427 Brown Stadium Loop is active with no shape at all.
    expect(nextStopIndex([], stops, c[0]!)).toBeNull();
  });
});

describe("headwayMinutes", () => {
  it("is the typical gap between departures, not a bunched one", () => {
    // Gaps of 20, 2 and 20 minutes: two buses arriving together in the middle
    // of an otherwise even service. Taking the middle gap as it falls would
    // advertise "every 2 min" to a rider who will wait twenty, so the gaps
    // have to be sorted before the median is read off them.
    const t = (m: number) => NOW + m * 60;
    expect(headwayMinutes([t(0), t(20), t(22), t(42)])).toBe(20);
  });

  it("is null when there are not two departures to compare", () => {
    expect(headwayMinutes([NOW])).toBeNull();
    expect(headwayMinutes([])).toBeNull();
  });
});
