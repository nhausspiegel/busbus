import { describe, it, expect } from "vitest";
import { planTrips, sameItinerary } from "../src/routing/plan";
import type { StaticFeed, DepartureBoard, Departure, Trip, Stop, Itinerary, RideLeg } from "../src/data/types";

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

describe("planTrips with an arrive-by deadline", () => {
  it("excludes an itinerary that arrives after the deadline", () => {
    const f = fixture(NOW + 300);            // reaches the destination at NOW+1080
    expect(planTrips({ feed: f.feed, board: f.board, ...base(), arriveBy: NOW + 1080 })).toHaveLength(1);
    expect(planTrips({ feed: f.feed, board: f.board, ...base(), arriveBy: NOW + 1079 })).toEqual([]);
  });

  it("ranks the latest departure first under a deadline, the earliest arrival without one", () => {
    // Same board, same everything: only the presence of arriveBy flips the order.
    const f = fixture(NOW + 300);            // R1: leave +180, ride 600, arrive +1080
    f.feed.routes.set("RX", { id: "RX", name: "Express", shortName: "X", color: "#111111", shape: [] });
    f.feed.trips.set("TX", {
      id: "TX", routeId: "RX",
      stops: [{ stopId: "A", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 120 }],
    });
    f.board.get("A")!.push({ stopId: "A", tripId: "TX", routeId: "RX", seq: 1, time: NOW + 900, live: false });
    f.board.get("B")!.push({ stopId: "B", tripId: "TX", routeId: "RX", seq: 2, time: NOW + 1020, live: false });
    // RX: leave +780, ride 120, arrive +1200 -- later arrival, much later departure.

    expect(planTrips({ feed: f.feed, board: f.board, ...base() })[0]!.rides[0]!.routeId).toBe("R1");

    const byDeadline = planTrips({ feed: f.feed, board: f.board, ...base(), arriveBy: NOW + 1200 });
    expect(byDeadline.map((i) => i.rides[0]!.routeId)).toEqual(["RX", "R1"]);
    expect(byDeadline[0]!.departTime).toBe(NOW + 780);
  });

  it("keeps the latest bus on a route that still makes the deadline", () => {
    const f = fixture(NOW + 300);
    f.feed.trips.set("T2", {
      id: "T2", routeId: "R1",
      stops: [{ stopId: "A", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 600 }],
    });
    f.board.get("A")!.push({ stopId: "A", tripId: "T2", routeId: "R1", seq: 1, time: NOW + 900, live: false });
    f.board.get("B")!.push({ stopId: "B", tripId: "T2", routeId: "R1", seq: 2, time: NOW + 1500, live: false });
    // T1 arrives NOW+1080, T2 arrives NOW+1680.
    const got = planTrips({ feed: f.feed, board: f.board, ...base(), arriveBy: NOW + 1680 });
    expect(got).toHaveLength(1);
    expect(got[0]!.rides[0]!.tripId).toBe("T2");

    // Tightening the deadline must fall back to the earlier bus on that route,
    // not drop the route because its latest bus no longer fits.
    const tight = planTrips({ feed: f.feed, board: f.board, ...base(), arriveBy: NOW + 1200 });
    expect(tight[0]!.rides[0]!.tripId).toBe("T1");
  });

  it("offers the walk under a deadline, timed to start as late as it can", () => {
    const f = fixture(NOW + 300);            // bus: leave +180
    const got = planTrips({
      feed: f.feed, board: f.board, ...base({ directWalkSeconds: 480 }), arriveBy: NOW + 3600,
    });
    expect(got[0]!.rides).toHaveLength(0);
    expect(got[0]!.departTime).toBe(NOW + 3120);
    expect(got[0]!.arriveTime).toBe(NOW + 3600);
    expect(got.some((i) => i.rides.length > 0)).toBe(true);   // the bus is still offered
  });

  it("ranks a bus above the walk when the bus lets the rider leave later", () => {
    const f = fixture(NOW + 2400);           // leave +2280, arrive +3180
    const got = planTrips({
      feed: f.feed, board: f.board, ...base({ directWalkSeconds: 1800 }), arriveBy: NOW + 3600,
    });
    expect(got[0]!.rides.length).toBeGreaterThan(0);          // walking would mean leaving at +1800
    expect(got[0]!.departTime).toBe(NOW + 2280);
    expect(got.some((i) => i.rides.length === 0)).toBe(true);
  });

  it("never proposes a walk that would have had to start in the past", () => {
    // Ten-minute walk, five minutes left. Anchoring the walk on the deadline
    // without clamping to `now` invents a departure before the search began.
    const f = fixture(NOW + 300);
    const got = planTrips({
      feed: f.feed, board: new Map(), ...base({ directWalkSeconds: 600 }), arriveBy: NOW + 300,
    });
    expect(got).toEqual([]);
  });

  it("returns empty for a deadline nothing can meet, rather than throwing", () => {
    const f = fixture(NOW + 300);
    expect(planTrips({
      feed: f.feed, board: f.board, ...base({ directWalkSeconds: 480 }), arriveBy: NOW + 60,
    })).toEqual([]);
  });
});

describe("a live departure whose realtime trip stops short", () => {
  /**
   * Measured against the live feed on 2026-08-28, going 129 Angell St to River
   * House: route 3302's trip 218773 had ONE realtime prediction, at Hillel
   * House, while the static trip of the same id carried both its stops --
   * Hillel House at +67800s and South Street Landing at +68400s. The bus was
   * live, three minutes out, 172m from the origin, and dropping 109m from the
   * destination, and the planner offered walking only.
   *
   * Passio predicts the stops a vehicle has left to serve, so the LAST stop of
   * a trip routinely has no downstream prediction at all. Treating "realtime
   * knows this trip" as "realtime knows every leg of this trip" throws the
   * whole ride away.
   */
  const liveTrip = (times: [string, number, number][]): Map<string, Departure[]> =>
    new Map([["T1", times.map(([stopId, seq, time]) => (
      { stopId, tripId: "T1", routeId: "R1", seq, time, live: true }))]]);

  it("still offers the ride, using the static trip's own leg duration", () => {
    const f = fixture(NOW + 300, true);
    const got = planTrips({
      feed: f.feed, board: f.board, ...base(),
      // Realtime knows the bus is at A. It says nothing about B.
      liveTrips: liveTrip([["A", 1, NOW + 300]]),
    });
    expect(got.map((i) => i.rides.length)).toContain(1);
    const ride = got.find((i) => i.rides.length === 1)!;
    // Departure is the live one; the 600s leg comes from the static trip.
    expect(ride.rides[0]!.departTime).toBe(NOW + 300);
    expect(ride.rides[0]!.arriveTime).toBe(NOW + 900);
    expect(ride.arriveTime).toBe(NOW + 900 + 180);
  });

  it("prefers realtime's own arrival when realtime actually has one", () => {
    // Same trip, but realtime predicts B too -- and disagrees with the
    // timetable. The reporting bus wins; the static 600s is not consulted.
    const f = fixture(NOW + 300, true);
    const got = planTrips({
      feed: f.feed, board: f.board, ...base(),
      liveTrips: liveTrip([["A", 1, NOW + 300], ["B", 2, NOW + 800]]),
    });
    const ride = got.find((i) => i.rides.length === 1)!;
    expect(ride.rides[0]!.arriveTime).toBe(NOW + 800);
    // and only one ride, not one from each source
    expect(got.filter((i) => i.rides.length === 1)).toHaveLength(1);
  });
});

describe("sameItinerary", () => {
  /** Live data refreshes every few seconds and every itinerary is rebuilt from
   *  scratch, so object identity cannot survive a poll. A journey is the trips
   *  and the stops it uses; the times are what the refresh is FOR. */
  const it0 = (over: Partial<RideLeg> = {}) => ({
    rides: [{
      routeId: "R1", tripId: "T1", boardStopId: "A", alightStopId: "B",
      departTime: 100, arriveTime: 700, live: true, numStops: 1, boardSeq: 1, ...over,
    }],
  } as Itinerary);

  it("keeps the rider's choice when only the times moved", () => {
    expect(sameItinerary(it0(), it0({ departTime: 160, arriveTime: 780 }))).toBe(true);
  });

  it("is a different journey when the rider gets off somewhere else", () => {
    expect(sameItinerary(it0(), it0({ alightStopId: "C" }))).toBe(false);
  });

  it("is a different journey on a later bus", () => {
    expect(sameItinerary(it0(), it0({ tripId: "T2" }))).toBe(false);
  });

  it("matches walking to walking", () => {
    const walk = { rides: [] } as unknown as Itinerary;
    expect(sameItinerary(walk, { rides: [] } as unknown as Itinerary)).toBe(true);
    expect(sameItinerary(walk, it0())).toBe(false);
  });
});
