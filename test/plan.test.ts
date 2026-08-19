import { describe, it, expect } from "vitest";
import { planTrips } from "../src/routing/plan";
import type { StaticFeed, DepartureBoard, Departure, Trip, Stop } from "../src/data/types";

const NOW = 1_700_000_000;
const ORIGIN = { lat: 41.8262, lng: -71.4047 };
const DEST = { lat: 41.8179, lng: -71.4069 };

/** Stop A (seq 1) then stop B (seq 2) on one trip, ten minutes apart. */
function fixture(departAt: number, live = false) {
  const stops = new Map<string, Stop>([
    ["A", { id: "A", name: "A", lat: 41.8262, lng: -71.4047 }],
    ["B", { id: "B", name: "B", lat: 41.8179, lng: -71.4069 }],
  ]);
  const trip: Trip = {
    id: "T1", routeId: "R1",
    stops: [{ stopId: "A", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 600 }],
  };
  const feed: StaticFeed = {
    routes: new Map([["R1", { id: "R1", name: "Route 1", shortName: "1", color: "#347f3d", shape: [] }]]),
    stops, trips: new Map([["T1", trip]]), feedEndDate: "20991231",
  };
  const d = (stopId: string, seq: number, time: number): Departure =>
    ({ stopId, tripId: "T1", routeId: "R1", seq, time, live });
  const board: DepartureBoard = new Map([
    ["A", [d("A", 1, departAt)]],
    ["B", [d("B", 2, departAt + 600)]],
  ]);
  return { feed, board };
}

const base = (extra: object = {}) => ({
  origin: ORIGIN, destination: DEST, now: NOW,
  walkFromOrigin: new Map([["A", 120]]),
  walkToDestination: new Map([["B", 180]]),
  ...extra,
});

describe("planTrips", () => {
  it("ranks by arrival at the destination, including both walking legs", () => {
    const f = fixture(NOW + 300);
    const got = planTrips({ feed: f.feed, board: f.board, ...base() });
    expect(got).toHaveLength(1);
    // depart+300 -> ride 600 -> walk 180
    expect(got[0]!.arriveTime).toBe(NOW + 300 + 600 + 180);
  });

  it("excludes a bus that leaves before the user can physically walk there", () => {
    // 120s walk, bus leaves in 60s. Offering it would send the user running
    // for a bus that is already gone -- the worst failure this can have.
    const f = fixture(NOW + 60);
    expect(planTrips({ feed: f.feed, board: f.board, ...base() })).toHaveLength(0);
  });

  it("includes a bus that leaves exactly when the user arrives", () => {
    const f = fixture(NOW + 120);
    expect(planTrips({ feed: f.feed, board: f.board, ...base() })).toHaveLength(1);
  });

  it("never rides backwards along a trip", () => {
    // Boarding at B (seq 2) cannot reach A (seq 1) on the same trip.
    const f = fixture(NOW + 300);
    const got = planTrips({
      feed: f.feed, board: f.board, ...base({
        walkFromOrigin: new Map([["B", 60]]),
        walkToDestination: new Map([["A", 60]]),
      }),
    });
    expect(got).toHaveLength(0);
  });

  it("returns empty when nothing is running instead of throwing", () => {
    // Overnight, and any time the RT feed is empty. Must degrade quietly.
    const f = fixture(NOW + 300);
    expect(planTrips({ feed: f.feed, board: new Map(), ...base() })).toEqual([]);
  });

  it("returns empty when no stop is reachable on foot", () => {
    const f = fixture(NOW + 300);
    expect(planTrips({ feed: f.feed, board: f.board, ...base({ walkFromOrigin: new Map() }) })).toEqual([]);
  });

  it("reports total walking time across both legs", () => {
    const f = fixture(NOW + 300);
    expect(planTrips({ feed: f.feed, board: f.board, ...base() })[0]!.totalWalkSeconds).toBe(300);
  });

  it("reports when the user must leave, accounting for the walk", () => {
    const f = fixture(NOW + 300);
    expect(planTrips({ feed: f.feed, board: f.board, ...base() })[0]!.departTime).toBe(NOW + 300 - 120);
  });

  it("flags an itinerary as not fully live when it rests on the timetable", () => {
    // The UI must not present a scheduled guess as confidently as a prediction.
    const f = fixture(NOW + 300, false);
    expect(planTrips({ feed: f.feed, board: f.board, ...base() })[0]!.allLive).toBe(false);
  });

  it("keeps only the earliest departure per route, not every later bus", () => {
    const f = fixture(NOW + 300);
    f.feed.trips.set("T2", {
      id: "T2", routeId: "R1",
      stops: [{ stopId: "A", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 600 }],
    });
    f.board.get("A")!.push({ stopId: "A", tripId: "T2", routeId: "R1", seq: 1, time: NOW + 900, live: false });
    f.board.get("B")!.push({ stopId: "B", tripId: "T2", routeId: "R1", seq: 2, time: NOW + 1500, live: false });
    const got = planTrips({ feed: f.feed, board: f.board, ...base() });
    expect(got).toHaveLength(1);
    expect(got[0]!.arriveTime).toBe(NOW + 300 + 600 + 180);
  });

  it("sorts multiple routes by arrival time ascending", () => {
    const f = fixture(NOW + 300);
    f.feed.routes.set("R2", { id: "R2", name: "Route 2", shortName: "2", color: "#000000", shape: [] });
    f.feed.trips.set("T9", {
      id: "T9", routeId: "R2",
      stops: [{ stopId: "A", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 60 }],
    });
    f.board.get("A")!.push({ stopId: "A", tripId: "T9", routeId: "R2", seq: 1, time: NOW + 240, live: true });
    f.board.get("B")!.push({ stopId: "B", tripId: "T9", routeId: "R2", seq: 2, time: NOW + 300, live: true });
    const got = planTrips({ feed: f.feed, board: f.board, ...base() });
    const times = got.map((i) => i.arriveTime);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(got[0]!.rides[0]!.routeId).toBe("R2");
  });

  it("offers walking, and ranks it first when it beats the bus", () => {
    // The case that exposed this: a 9-minute wait for a 7-stop loop across a
    // few blocks, when the rider could simply walk there sooner.
    const f = fixture(NOW + 540);            // bus leaves in 9 min, rides 600s
    const got = planTrips({ feed: f.feed, board: f.board, ...base({ directWalkSeconds: 480 }) });
    expect(got[0]!.rides).toHaveLength(0);   // walking
    expect(got[0]!.arriveTime).toBe(NOW + 480);
    expect(got.length).toBeGreaterThan(1);   // the bus is still offered
  });

  it("ranks the bus first when the walk is long", () => {
    const f = fixture(NOW + 300);            // arrives NOW+1080 including final walk
    const got = planTrips({ feed: f.feed, board: f.board, ...base({ directWalkSeconds: 1800 }) });
    expect(got[0]!.rides.length).toBeGreaterThan(0);
  });

  it("does not suggest walking an unreasonable distance", () => {
    // A two-hour walk is not an option a campus shuttle app should offer.
    const f = fixture(NOW + 300);
    const got = planTrips({ feed: f.feed, board: f.board, ...base({ directWalkSeconds: 7200 }) });
    expect(got.every((i) => i.rides.length > 0)).toBe(true);
  });

  it("offers walking even when no bus runs at all", () => {
    // Overnight and between seasons this is the only true answer.
    const f = fixture(NOW + 300);
    const got = planTrips({ feed: f.feed, board: new Map(), ...base({ directWalkSeconds: 600 }) });
    expect(got).toHaveLength(1);
    expect(got[0]!.rides).toHaveLength(0);
    expect(got[0]!.allLive).toBe(true);      // your own legs are not a prediction
  });

  it("drops an option arriving hours after the best one", () => {
    // Brown's routes run in shifts: a 10am search finds Daytime buses now and
    // an Evening bus tonight. "Arrive 7:08 PM" listed beside "arrive 10:16 AM"
    // is not a choice anyone makes.
    const f = fixture(NOW + 300);
    f.feed.routes.set("RL", { id: "RL", name: "Tonight", shortName: "L", color: "#444", shape: [] });
    f.feed.trips.set("TL", { id: "TL", routeId: "RL", stops: [
      { stopId: "A", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 600 }] });
    f.board.get("A")!.push({ stopId: "A", tripId: "TL", routeId: "RL", seq: 1, time: NOW + 8 * 3600, live: false });
    f.board.get("B")!.push({ stopId: "B", tripId: "TL", routeId: "RL", seq: 2, time: NOW + 8 * 3600 + 600, live: false });
    const got = planTrips({ feed: f.feed, board: f.board, ...base() });
    expect(got.some((i) => i.rides[0]?.routeId === "RL")).toBe(false);
    expect(got.length).toBeGreaterThan(0);
  });

  it("prefers a slower bus leaving now over a faster bus leaving much later", () => {
    // THE requirement: earliest ARRIVAL, not shortest ride.
    const f = fixture(NOW + 300);                       // R1: leaves +300, rides 600 -> arrives +900
    f.feed.routes.set("RX", { id: "RX", name: "Express", shortName: "X", color: "#111111", shape: [] });
    f.feed.trips.set("TX", {
      id: "TX", routeId: "RX",
      stops: [{ stopId: "A", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 120 }],
    });
    // Express is 5x faster but leaves 15 min later -> arrives +1020, worse.
    f.board.get("A")!.push({ stopId: "A", tripId: "TX", routeId: "RX", seq: 1, time: NOW + 900, live: false });
    f.board.get("B")!.push({ stopId: "B", tripId: "TX", routeId: "RX", seq: 2, time: NOW + 1020, live: false });
    const got = planTrips({ feed: f.feed, board: f.board, ...base() });
    expect(got[0]!.rides[0]!.routeId).toBe("R1");
    expect(got[0]!.rides[0]!.arriveTime).toBeLessThan(got[1]!.rides[0]!.arriveTime);
  });
});
