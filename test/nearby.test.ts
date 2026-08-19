import { describe, it, expect } from "vitest";
import { nearbyDepartures } from "../src/routing/nearby";
import type { StaticFeed, DepartureBoard, Stop } from "../src/data/types";

const NOW = 1_700_000_000;
const stop = (id: string, lat: number, lng: number): Stop => ({ id, name: `Stop ${id}`, lat, lng });

function fixture(): { feed: StaticFeed; board: DepartureBoard } {
  const stops = new Map<string, Stop>([
    ["near", stop("near", 41.8262, -71.4047)],
    ["far", stop("far", 41.8600, -71.4047)],
  ]);
  const feed: StaticFeed = {
    routes: new Map([["R1", { id: "R1", name: "Route One", shortName: "1", color: "#347f3d", shape: [] }]]),
    stops, trips: new Map(), feedEndDate: "20991231",
  };
  const d = (stopId: string, time: number, live: boolean) =>
    ({ stopId, tripId: `T${time}`, routeId: "R1", seq: 1, time, live });
  const board: DepartureBoard = new Map([
    ["near", [d("near", NOW - 60, false), d("near", NOW + 120, true), d("near", NOW + 600, false)]],
    ["far", [d("far", NOW + 300, false)]],
  ]);
  return { feed, board };
}

describe("nearbyDepartures", () => {
  const origin = { lat: 41.8262, lng: -71.4047 };

  it("orders stops by distance from the user", () => {
    const { feed, board } = fixture();
    const got = nearbyDepartures(feed, board, origin, NOW, 5);
    expect(got.map((s) => s.stop.id)).toEqual(["near", "far"]);
  });

  it("drops departures that already left", () => {
    // A bus that left a minute ago is not an option, and showing it as
    // "-1 min" is the fastest way to lose a rider's trust.
    const { feed, board } = fixture();
    const got = nearbyDepartures(feed, board, origin, NOW, 5);
    expect(got[0]!.departures.every((d) => d.time >= NOW)).toBe(true);
  });

  it("keeps live and scheduled departures distinguishable", () => {
    const { feed, board } = fixture();
    const got = nearbyDepartures(feed, board, origin, NOW, 5);
    expect(got[0]!.departures[0]!.live).toBe(true);
  });

  it("reports walking distance so the UI can say how far the stop is", () => {
    const { feed, board } = fixture();
    const got = nearbyDepartures(feed, board, origin, NOW, 5);
    expect(got[0]!.meters).toBeLessThan(50);
    expect(got[1]!.meters).toBeGreaterThan(1000);
  });

  it("omits stops with nothing upcoming rather than listing them empty", () => {
    const { feed, board } = fixture();
    board.set("far", []);
    const got = nearbyDepartures(feed, board, origin, NOW, 5);
    expect(got.map((s) => s.stop.id)).toEqual(["near"]);
  });

  it("collapses two trips on the same route arriving the same minute", () => {
    // GTFS routinely has separate trip ids whose times round to the same
    // minute at a given stop. A rider sees one bus, so listing "Evening CW,
    // 3 min" twice is noise that makes the whole board look wrong.
    const { feed, board } = fixture();
    board.set("near", [
      { stopId: "near", tripId: "A", routeId: "R1", seq: 1, time: NOW + 180, live: false },
      { stopId: "near", tripId: "B", routeId: "R1", seq: 1, time: NOW + 200, live: false },
      { stopId: "near", tripId: "C", routeId: "R1", seq: 1, time: NOW + 900, live: false },
    ]);
    const got = nearbyDepartures(feed, board, origin, NOW, 5);
    expect(got[0]!.departures).toHaveLength(2);
  });

  it("prefers the live entry when collapsing a duplicate minute", () => {
    const { feed, board } = fixture();
    board.set("near", [
      { stopId: "near", tripId: "A", routeId: "R1", seq: 1, time: NOW + 180, live: false },
      { stopId: "near", tripId: "B", routeId: "R1", seq: 1, time: NOW + 190, live: true },
    ]);
    const got = nearbyDepartures(feed, board, origin, NOW, 5);
    expect(got[0]!.departures).toHaveLength(1);
    expect(got[0]!.departures[0]!.live).toBe(true);
  });

  it("does not list a departure hours away", () => {
    // Brown's routes run in shifts: at 9am the Evening routes' next departure
    // is tonight. "Evening CW - 440 min" is correct but useless, and it pushed
    // the daytime service a rider can actually catch off the board.
    const { feed, board } = fixture();
    board.set("near", [
      { stopId: "near", tripId: "tonight", routeId: "R1", seq: 1, time: NOW + 440 * 60, live: false },
    ]);
    board.set("far", []);
    expect(nearbyDepartures(feed, board, origin, NOW, 5)).toEqual([]);
  });

  it("keeps a departure inside the horizon", () => {
    const { feed, board } = fixture();
    board.set("near", [
      { stopId: "near", tripId: "soon", routeId: "R1", seq: 1, time: NOW + 80 * 60, live: false },
    ]);
    board.set("far", []);
    const got = nearbyDepartures(feed, board, origin, NOW, 5);
    expect(got).toHaveLength(1);
    expect(got[0]!.departures[0]!.tripId).toBe("soon");
  });

  it("returns empty when nothing runs at all", () => {
    const { feed } = fixture();
    expect(nearbyDepartures(feed, new Map(), origin, NOW, 5)).toEqual([]);
  });
});
