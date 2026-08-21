import { describe, it, expect } from "vitest";
import { rideStops } from "../src/routing/rideStops";
import type { StaticFeed, RideLeg, Stop } from "../src/data/types";

const NOW = 1_700_000_000;
const mk = (id: string): Stop => ({ id, name: `Stop ${id}`, lat: 41.82, lng: -71.40 });

const feed: StaticFeed = {
  routes: new Map([["R1", { id: "R1", name: "R1", shortName: "1", color: "#111", shape: [] }]]),
  stops: new Map([["A", mk("A")], ["B", mk("B")], ["C", mk("C")], ["D", mk("D")]]),
  trips: new Map([["T1", { id: "T1", routeId: "R1", stops: [
    { stopId: "A", seq: 1, time: 0 },
    { stopId: "B", seq: 2, time: 120 },
    { stopId: "C", seq: 3, time: 300 },
    { stopId: "D", seq: 4, time: 480 },
    { stopId: "A", seq: 5, time: 600 },   // loop returns to A and goes round again
    { stopId: "B", seq: 6, time: 800 },   // second lap runs slower
    { stopId: "C", seq: 7, time: 900 },
  ] }]]),
  feedEndDate: "20991231",
};

const ride = (o: Partial<RideLeg> = {}): RideLeg => ({
  routeId: "R1", tripId: "T1", boardStopId: "A", alightStopId: "C",
  departTime: NOW, arriveTime: NOW + 300, live: false, numStops: 2, boardSeq: 1, ...o,
});

describe("rideStops", () => {
  it("lists boarding, intermediate and alighting stops in order", () => {
    expect(rideStops(feed, ride()).map((r) => r.stop.id)).toEqual(["A", "B", "C"]);
  });

  it("flags which stop to board and which to get off at", () => {
    const got = rideStops(feed, ride());
    expect(got[0]!.boarding).toBe(true);
    expect(got[got.length - 1]!.alighting).toBe(true);
    expect(got[1]!.boarding).toBe(false);
    expect(got[1]!.alighting).toBe(false);
  });

  it("shifts intermediate times when the bus departs late", () => {
    // A bus running 5 minutes behind passes every intermediate stop 5 minutes
    // late too. Showing the original scheduled times would have riders looking
    // out of the window at the wrong moment.
    const late = rideStops(feed, ride({ departTime: NOW + 300 }));
    expect(late[1]!.time).toBe(NOW + 300 + 120);
  });

  it("does not run past the alighting stop", () => {
    expect(rideStops(feed, ride()).some((r) => r.stop.id === "D")).toBe(false);
  });

  it("picks the alighting stop after boarding on a loop that revisits it", () => {
    // Riding A -> A round the loop must return the whole loop, not an empty
    // slice from matching the boarding stop as the destination.
    const got = rideStops(feed, ride({ alightStopId: "A", numStops: 4 }));
    expect(got.map((r) => r.stop.id)).toEqual(["A", "B", "C", "D", "A"]);
    expect(got[got.length - 1]!.alighting).toBe(true);
  });

  it("starts from the lap the rider actually boards on", () => {
    // T1 calls at A twice, seq 1 and seq 5. A rider joining on the second lap
    // was resolved to the first visit, so the list opened with a whole
    // spurious lap of stops they have already ridden past.
    const second = rideStops(feed, ride({ boardSeq: 5, alightStopId: "C", numStops: 2 }));
    expect(second.map((r) => r.stop.id)).toEqual(["A", "B", "C"]);
    // The second lap is slower: B is 200s after A, not 120s. Resolving to the
    // first visit produces the same stop NAMES, so only the timings catch it.
    expect(second[1]!.time).toBe(NOW + 200);
  });

  it("falls back to the first visit when the sequence does not match the trip", () => {
    // A live ride carries Passio's REALTIME sequence, which does not match the
    // static trip. Better the first visit than nothing at all.
    const got = rideStops(feed, ride({ boardSeq: 99 }));
    expect(got.map((r) => r.stop.id)).toEqual(["A", "B", "C"]);
  });

  it("returns empty for an unknown trip rather than throwing", () => {
    expect(rideStops(feed, ride({ tripId: "nope" }))).toEqual([]);
  });
});
