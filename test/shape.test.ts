import { describe, it, expect } from "vitest";
import { pointAlongShape, sliceShape, snapToShape, distanceAlongShape, shapeLength } from "../src/routing/shape";
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

/** A corner of two 200m streets, at Providence's latitude. */
const corner: LatLng[] = [
  { lat: 41.8240, lng: -71.4002 },
  { lat: 41.8258, lng: -71.4002 },   // 200m north
  { lat: 41.8258, lng: -71.3978 },   // then 200m east
];
const midFirst: LatLng = { lat: 41.8249, lng: -71.4002 };   // 100m along the first
const midSecond: LatLng = { lat: 41.8258, lng: -71.3990 };  // 100m along the second

describe("pointAlongShape", () => {
  it("hands back the two fixes themselves at 0 and 1", () => {
    expect(pointAlongShape(corner, midFirst, midSecond, 0)).toEqual(midFirst);
    expect(pointAlongShape(corner, midFirst, midSecond, 1)).toEqual(midSecond);
  });

  it("follows the street round the corner instead of cutting across it", () => {
    // 100m to the corner then 100m east is a 200m path, so halfway is the
    // corner itself. A straight line between the same two fixes would be
    // through the block, ~70m from it.
    const got = pointAlongShape(corner, midFirst, midSecond, 0.5);
    expect(haversineMeters(got, corner[1]!)).toBeLessThan(2);
    const chordMid = { lat: (midFirst.lat + midSecond.lat) / 2, lng: (midFirst.lng + midSecond.lng) / 2 };
    expect(haversineMeters(got, chordMid)).toBeGreaterThan(50);
  });

  it("covers the path at a steady pace", () => {
    expect(haversineMeters(pointAlongShape(corner, midFirst, midSecond, 0.25),
      { lat: 41.82535, lng: -71.4002 })).toBeLessThan(2);
    expect(haversineMeters(pointAlongShape(corner, midFirst, midSecond, 0.75),
      { lat: 41.8258, lng: -71.39960 })).toBeLessThan(2);
  });

  it("goes straight when the new fix is behind the old one on the shape", () => {
    // A parked bus's fix jitters back and forth by a couple of metres. Read as
    // "forwards", that is a whole lap of the loop at speed.
    const back: LatLng = { lat: 41.8258, lng: -71.3995 };
    const got = pointAlongShape(corner, midSecond, back, 0.5);
    expect(haversineMeters(got, { lat: 41.8258, lng: -71.39925 })).toBeLessThan(2);
  });

  it("goes straight when the path between the fixes is too long to be one bus's motion", () => {
    // Out and back down two streets 91m apart. A fix that jitters onto the
    // other pass is 91m away, but 1300m along the shape.
    const outAndBack: LatLng[] = [
      { lat: 41.8240, lng: -71.4002 }, { lat: 41.8350, lng: -71.4002 },
      { lat: 41.8350, lng: -71.4013 }, { lat: 41.8240, lng: -71.4013 },
    ];
    const got = pointAlongShape(outAndBack,
      { lat: 41.8295, lng: -71.4002 }, { lat: 41.8295, lng: -71.4013 }, 0.5);
    expect(haversineMeters(got, { lat: 41.8295, lng: -71.40075 })).toBeLessThan(2);
  });

  it("goes straight when there is no shape to follow", () => {
    const a = { lat: 41.8240, lng: -71.4002 }, b = { lat: 41.8258, lng: -71.4002 };
    expect(haversineMeters(pointAlongShape([], a, b, 0.5), { lat: 41.8249, lng: -71.4002 }))
      .toBeLessThan(2);
  });
});

describe("distanceAlongShape", () => {
  // A 3-segment line heading east, each leg about 100m at this latitude.
  const east = (n: number) => ({ lat: 41.826, lng: -71.400 + n * 0.0012 });
  const line = [east(0), east(1), east(2), east(3)];

  it("measures from the start of the shape, not to the nearest vertex", () => {
    const oneAndAHalf = distanceAlongShape(line, { lat: 41.826, lng: -71.400 + 1.5 * 0.0012 });
    const one = distanceAlongShape(line, east(1));
    const two = distanceAlongShape(line, east(2));
    expect(oneAndAHalf).toBeGreaterThan(one);
    expect(oneAndAHalf).toBeLessThan(two);
    expect(oneAndAHalf).toBeCloseTo((one + two) / 2, 0);
  });

  it("is zero at the start and the full length at the end", () => {
    expect(distanceAlongShape(line, east(0))).toBeCloseTo(0, 1);
    expect(distanceAlongShape(line, east(3))).toBeCloseTo(shapeLength(line), 1);
  });

  it("projects a point beside the line onto it", () => {
    // A bus sits a few metres off its own shape; its progress along the route
    // is unaffected by that sideways error.
    const beside = { lat: 41.8261, lng: -71.400 + 1.5 * 0.0012 };
    expect(distanceAlongShape(line, beside))
      .toBeCloseTo(distanceAlongShape(line, { lat: 41.826, lng: -71.400 + 1.5 * 0.0012 }), 0);
  });
});
