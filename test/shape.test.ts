import { describe, it, expect } from "vitest";
import { sliceShape, snapToShape } from "../src/routing/shape";
import { haversineMeters } from "../src/routing/walk";
import type { LatLng } from "../src/data/types";

describe("snapToShape", () => {
  /** 500m of Thayer Street, as two vertices -- the density route 3469 has. */
  const street: LatLng[] = [
    { lat: 41.8240, lng: -71.4002 },
    { lat: 41.8285, lng: -71.4002 },
  ];

  it("puts a drifted bus on the line, between the vertices", () => {
    // The whole point: nearestIndex would return one of the two ENDS, leaving
    // the bus up to 250m from where it actually is. It has to project onto the
    // segment.
    const bus = { lat: 41.8262, lng: -71.4009 };          // ~58m west of the line
    const got = snapToShape(bus, street);
    expect(got.lng).toBeCloseTo(-71.4002, 5);             // on the line
    expect(got.lat).toBeCloseTo(41.8262, 5);              // beside where it was
    expect(haversineMeters(got, street[0]!)).toBeGreaterThan(100);
    expect(haversineMeters(got, street[1]!)).toBeGreaterThan(100);
  });

  it("leaves a bus already on the line where it is", () => {
    const on = { lat: 41.8262, lng: -71.4002 };
    expect(haversineMeters(snapToShape(on, street), on)).toBeLessThan(0.5);
  });

  it("picks the nearer pass where a route doubles back on itself", () => {
    const there: LatLng[] = [{ lat: 41.8240, lng: -71.4002 }, { lat: 41.8285, lng: -71.4002 }];
    const back: LatLng[] = [{ lat: 41.8285, lng: -71.4010 }, { lat: 41.8240, lng: -71.4010 }];
    const got = snapToShape({ lat: 41.8262, lng: -71.4009 }, [...there, ...back]);
    expect(got.lng).toBeCloseTo(-71.4010, 5);
  });

  it("returns the position untouched when there is no line to snap to", () => {
    const at = { lat: 41.826, lng: -71.4002 };
    expect(snapToShape(at, [])).toEqual(at);
    expect(snapToShape(at, [{ lat: 41.9, lng: -71.3 }])).toEqual(at);
  });
});

// A simple square loop, one point per corner plus a midpoint per side.
const loop: LatLng[] = [
  { lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 0, lng: 2 },
  { lat: 1, lng: 2 }, { lat: 2, lng: 2 },
  { lat: 2, lng: 1 }, { lat: 2, lng: 0 },
  { lat: 1, lng: 0 },
];

describe("sliceShape", () => {
  it("returns only the ridden portion, not the whole route", () => {
    const got = sliceShape(loop, { lat: 0, lng: 0 }, { lat: 0, lng: 2 });
    expect(got).toEqual([{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 0, lng: 2 }]);
  });

  it("wraps around the end of a loop instead of running backwards", () => {
    // Board near the end of the shape, alight near the start. Slicing naively
    // would produce an empty or reversed line drawn the wrong way round.
    const got = sliceShape(loop, { lat: 2, lng: 0 }, { lat: 0, lng: 1 });
    expect(got[0]).toEqual({ lat: 2, lng: 0 });
    expect(got[got.length - 1]).toEqual({ lat: 0, lng: 1 });
    expect(got.length).toBe(4);
  });

  it("snaps to the nearest shape point when a stop is slightly off the line", () => {
    const got = sliceShape(loop, { lat: 0.02, lng: -0.01 }, { lat: 0.01, lng: 2.02 });
    expect(got[0]).toEqual({ lat: 0, lng: 0 });
    expect(got[got.length - 1]).toEqual({ lat: 0, lng: 2 });
  });

  it("returns empty when boarding and alighting snap to the same point", () => {
    expect(sliceShape(loop, { lat: 0, lng: 0 }, { lat: 0.001, lng: 0.001 })).toEqual([]);
  });

  it("returns empty for a degenerate shape rather than throwing", () => {
    expect(sliceShape([], { lat: 0, lng: 0 }, { lat: 1, lng: 1 })).toEqual([]);
  });
});
