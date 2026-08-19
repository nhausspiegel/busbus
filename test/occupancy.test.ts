import { describe, it, expect } from "vitest";
import { parseOccupancy, mergeOccupancy, fullness } from "../src/data/occupancy";
import type { Bus } from "../src/data/vehicles";

/** Shape captured from a live getBuses=2 response. */
const payload = {
  buses: {
    "405420": [{ busId: 7516, busName: "110", routeId: "62487", paxLoad: 1, totalCap: 11 }],
    "412375": [{ busId: "4055", busName: "124", routeId: "3302", paxLoad: 3, totalCap: 20 }],
    "999999": [{ busId: 8888, busName: "199", routeId: "3302", paxLoad: 0, totalCap: 0 }],
  },
};

const bus = (id: string): Bus => ({
  id, label: id, routeId: "62487", lat: 41.82, lng: -71.4, bearing: 0, occupancy: null,
});

describe("parseOccupancy", () => {
  it("reads exact counts out of the nested per-device arrays", () => {
    const got = parseOccupancy(payload);
    expect(got.get("7516")).toEqual({ busId: "7516", paxLoad: 1, totalCap: 11 });
  });

  it("keys numeric and string busIds the same way", () => {
    // Passio returns busId as a number for some buses and a string for others.
    const got = parseOccupancy(payload);
    expect(got.get("4055")?.paxLoad).toBe(3);
  });

  it("returns empty for a malformed response rather than throwing", () => {
    expect(parseOccupancy(null).size).toBe(0);
    expect(parseOccupancy({}).size).toBe(0);
    expect(parseOccupancy({ buses: "nope" }).size).toBe(0);
    expect(parseOccupancy({ buses: { x: [{ busId: 1, paxLoad: "abc" }] } }).size).toBe(0);
  });
});

describe("mergeOccupancy", () => {
  it("attaches counts to the matching vehicle", () => {
    const got = mergeOccupancy([bus("7516")], parseOccupancy(payload));
    expect(got[0]!.paxLoad).toBe(1);
    expect(got[0]!.totalCap).toBe(11);
  });

  it("leaves a vehicle untouched when the private feed does not know it", () => {
    const got = mergeOccupancy([bus("nomatch")], parseOccupancy(payload));
    expect(got[0]!.paxLoad).toBeUndefined();
    expect(got).toHaveLength(1);
  });

  it("does not invent a bus that only the private feed reports", () => {
    // The private feed lists three buses; GTFS-RT knows one. Only that one
    // should reach the map, or the app would draw a vehicle with no position.
    const got = mergeOccupancy([bus("7516")], parseOccupancy(payload));
    expect(got).toHaveLength(1);
  });

  it("returns the input unchanged when there are no counts at all", () => {
    const input = [bus("7516")];
    expect(mergeOccupancy(input, new Map())).toBe(input);
  });
});

describe("fullness", () => {
  it("reports a percentage and a phrase", () => {
    expect(fullness(1, 11)).toEqual({ pct: 9, label: "Seats free" });
    expect(fullness(10, 20)!.label).toBe("Filling up");
    expect(fullness(16, 20)!.label).toBe("Standing room");
    expect(fullness(20, 20)!.label).toBe("Full");
  });

  it("never divides by zero when capacity is missing", () => {
    // Passio reports totalCap 0 for some vehicles; a NaN% or Infinity% on
    // screen is worse than admitting the proportion is unknown.
    const got = fullness(4, 0);
    expect(got!.pct).toBeNull();
    expect(got!.label).toBe("4 aboard");
    expect(fullness(4, undefined)!.pct).toBeNull();
  });

  it("returns null when there is no count at all", () => {
    expect(fullness(undefined, 20)).toBeNull();
  });

  it("treats an over-capacity bus as full rather than reporting over 100", () => {
    expect(fullness(25, 20)!.label).toBe("Full");
  });
});
