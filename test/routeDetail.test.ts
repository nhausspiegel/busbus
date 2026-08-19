import { describe, it, expect } from "vitest";
import { routeStops } from "../src/routing/routeDetail";
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
