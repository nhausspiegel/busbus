import { describe, it, expect } from "vitest";
import { sliceShape } from "../src/routing/shape";
import type { LatLng } from "../src/data/types";

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
