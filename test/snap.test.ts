import { describe, it, expect } from "vitest";
import { snapToPath, metresPerPixel } from "../src/routing/snap";
import { laneProfiles, offsetPath } from "../src/routing/parallel";
import { haversineMeters } from "../src/routing/walk";
import type { LatLng } from "../src/data/types";

/** A straight run east along one latitude. */
const eastward = (lat: number, lng0: number, metres: number): LatLng[] => [
  { lat, lng: lng0 },
  { lat, lng: lng0 + metres / (111_320 * Math.cos((lat * Math.PI) / 180)) },
];

const LINE = eastward(41.826, -71.404, 500);

/** Shortest distance from a point to a polyline, by brute force. */
function distanceToPath(p: LatLng, path: LatLng[]): number {
  return haversineMeters(p, snapToPath(p, path));
}

describe("snapToPath", () => {
  it("pulls a bus that has drifted off its route back onto the line", () => {
    // GPS puts buses 5-45m off their shape; Passio's own feed carries a
    // snapDistance for the same reason. A bus floating beside its own line
    // reads as a bug to a rider.
    const off = { lat: 41.8263, lng: -71.4025 };            // ~33m north of the line
    const got = snapToPath(off, LINE);
    expect(haversineMeters(got, off)).toBeGreaterThan(20);
    expect(Math.abs(got.lat - 41.826)).toBeLessThan(1e-5);
  });

  it("lands the bus on the line that is actually drawn, not the centreline", () => {
    // The route lines carry their lane offset in their geometry. Snapping to
    // the raw shape would leave every bus beside its own line by construction.
    const shape = eastward(41.826, -71.404, 500);
    const ps = laneProfiles([{ id: "A", shape }, { id: "B", shape }]);
    const drawn = offsetPath(ps.find((p) => p.routeId === "A")!, 2, 5);
    const gpsWobble = { lat: 41.8262, lng: -71.4025 };
    const got = snapToPath(gpsWobble, drawn);
    expect(distanceToPath(got, drawn)).toBeLessThan(0.5);
    // ...and that is genuinely a different place from the unoffset shape.
    expect(distanceToPath(got, shape)).toBeGreaterThan(4.5);   // half a lane, 5px at 2m/px
  });

  it("picks the nearest pass when a route runs the same street twice", () => {
    const doubled = [...eastward(41.826, -71.404, 500), ...eastward(41.8268, -71.404, 500).reverse()];
    const near = { lat: 41.82675, lng: -71.4025 };
    expect(Math.abs(snapToPath(near, doubled).lat - 41.8268)).toBeLessThan(1e-4);
  });

  it("leaves a bus alone when the route has no drawable line", () => {
    const at = { lat: 41.826, lng: -71.4025 };
    expect(snapToPath(at, [])).toEqual(at);
    expect(snapToPath(at, [{ lat: 41.9, lng: -71.3 }])).toEqual(at);
  });
});

describe("metresPerPixel", () => {
  it("halves with each zoom level", () => {
    expect(metresPerPixel(41.826, 15)).toBeCloseTo(metresPerPixel(41.826, 14) / 2, 4);
  });

  it("matches the Web Mercator scale at Providence's latitude", () => {
    // 156543.03 * cos(41.826) / 2^16
    expect(metresPerPixel(41.826, 16)).toBeCloseTo(1.78, 3);
  });
});
