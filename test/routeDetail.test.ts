import { describe, it, expect } from "vitest";
import { routeStops, stopRoutes } from "../src/routing/routeDetail";
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
