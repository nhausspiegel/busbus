import { describe, it, expect } from "vitest";
import { candidateStops } from "../src/routing/trip";
import type { StaticFeed, Stop, Trip } from "../src/data/types";

/**
 * Which stops may be planned to or from.
 *
 * The rule used to be "has a GTFS trip", full stop, and the reasoning was
 * sound when it was written: a stop with no trip has no times to ride on, and
 * letting one compete for a candidate slot is how 6 of the 8 nearest to Barus
 * & Holley came back parking lots and monuments.
 *
 * What changed is that observed leg times can now time a ride to a stop the
 * GTFS export drops -- so "no trip" no longer implies "no times". Eight stops
 * sitting on real routes were unplannable, including Dyer & Pine, 306m from
 * the RISD Fleet Library and on the Express.
 */
const stop = (id: string, name: string): Stop => ({ id, name, lat: 41.82, lng: -71.40 });

const feed = (): StaticFeed => {
  const stops = new Map<string, Stop>([
    ["A", stop("A", "On a GTFS trip")],
    ["B", stop("B", "Passio only, legs observed")],
    ["C", stop("C", "Passio only, legs never observed")],
    ["D", stop("D", "On no route at all")],
  ]);
  const trips = new Map<string, Trip>([
    ["t1", { id: "t1", routeId: "R", stops: [{ stopId: "A", seq: 1, time: 0 }] } as Trip],
  ]);
  return {
    routes: new Map(), stops, trips, feedEndDate: "20271231",
    routeStops: new Map([["R", ["A", "B", "C"]]]),
  } as StaticFeed;
};

/** Only the A->B leg has ever been watched. */
const observed = (routeId: string, from: string, to: string) =>
  routeId === "R" && from === "A" && to === "B" ? 120 : null;

describe("candidateStops", () => {
  it("takes any stop a GTFS trip serves", () => {
    expect(candidateStops(feed(), observed).served.map((s) => s.id)).toEqual(["A"]);
  });

  it("adds a Passio-only stop whose leg has actually been observed", () => {
    expect(candidateStops(feed(), observed).rideable.map((s) => s.id)).toEqual(["B"]);
  });

  it("still refuses one with no observed leg -- there is nothing to time a ride with", () => {
    const ids = candidateStops(feed(), observed).rideable.map((s) => s.id);
    expect(ids).not.toContain("C");
  });

  it("never offers a stop that is on no route", () => {
    const { served, rideable } = candidateStops(feed(), observed);
    expect([...served, ...rideable].map((s) => s.id)).not.toContain("D");
  });

  it("adds nothing at all without observed legs, which is the old behaviour", () => {
    // The guarantee that this cannot reintroduce the parking-lot regression on
    // a rider whose record is empty.
    expect(candidateStops(feed(), undefined).rideable).toEqual([]);
    expect(candidateStops(feed(), () => null).rideable).toEqual([]);
  });
});
