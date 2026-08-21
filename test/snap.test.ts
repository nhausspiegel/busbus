import { describe, it, expect } from "vitest";
import { snapToLane } from "../src/routing/snap";
import { haversineMeters } from "../src/routing/walk";
import type { OffsetPiece } from "../src/routing/parallel";
import type { LatLng } from "../src/data/types";

/** A straight run east along one latitude. */
const eastward = (lat: number, lng0: number, metres: number): LatLng[] => [
  { lat, lng: lng0 },
  { lat, lng: lng0 + metres / (111_320 * Math.cos((lat * Math.PI) / 180)) },
];

const piece = (routeId: string, lane: number, path: LatLng[]): OffsetPiece =>
  ({ routeId, lane, path });

const LINE = eastward(41.826, -71.404, 500);
const M_PER_PX = 2;      // roughly street zoom
const LANE_PX = 5;

describe("snapToLane", () => {
  it("pulls a bus that has drifted off its route back onto the line", () => {
    // GPS puts buses 5-45m off their shape; Passio snaps them too. A bus
    // floating beside its own line reads as a bug to a rider.
    const off = { lat: 41.8263, lng: -71.4025 };            // ~33m north of the line
    const got = snapToLane(off, "R", [piece("R", 0, LINE)], M_PER_PX, LANE_PX);
    expect(haversineMeters(got, off)).toBeGreaterThan(20);
    expect(Math.abs(got.lat - 41.826)).toBeLessThan(1e-5);   // on the line
  });

  it("displaces the bus into its route's lane so it rides the drawn line", () => {
    // The lines are drawn offset by lane x pixels. Leaving buses on the
    // unoffset centreline puts every bus beside its own route by construction.
    const on = { lat: 41.826, lng: -71.4025 };
    const centred = snapToLane(on, "R", [piece("R", 0, LINE)], M_PER_PX, LANE_PX);
    const laned = snapToLane(on, "R", [piece("R", 1, LINE)], M_PER_PX, LANE_PX);
    expect(haversineMeters(centred, laned)).toBeCloseTo(LANE_PX * M_PER_PX, 0);
  });

  it("puts opposite lanes on opposite sides of the line", () => {
    const on = { lat: 41.826, lng: -71.4025 };
    const plus = snapToLane(on, "R", [piece("R", 1, LINE)], M_PER_PX, LANE_PX);
    const minus = snapToLane(on, "R", [piece("R", -1, LINE)], M_PER_PX, LANE_PX);
    expect(Math.sign(plus.lat - 41.826)).toBe(-Math.sign(minus.lat - 41.826));
  });

  it("scales the displacement with the map, so it tracks the drawn line at any zoom", () => {
    const on = { lat: 41.826, lng: -71.4025 };
    const near = snapToLane(on, "R", [piece("R", 1, LINE)], 1, LANE_PX);
    const far = snapToLane(on, "R", [piece("R", 1, LINE)], 8, LANE_PX);
    expect(haversineMeters(far, on)).toBeGreaterThan(haversineMeters(near, on) * 5);
  });

  it("ignores pieces belonging to other routes", () => {
    const on = { lat: 41.826, lng: -71.4025 };
    const decoy = piece("OTHER", 3, eastward(41.83, -71.404, 500));
    const got = snapToLane(on, "R", [decoy, piece("R", 0, LINE)], M_PER_PX, LANE_PX);
    expect(Math.abs(got.lat - 41.826)).toBeLessThan(1e-5);
  });

  it("picks the nearest piece when a route passes itself", () => {
    // Loop routes double back; snapping to the far pass would teleport a bus
    // across campus.
    const near = piece("R", 0, LINE);
    const farPass = piece("R", 0, eastward(41.84, -71.404, 500));
    const on = { lat: 41.8261, lng: -71.4025 };
    const got = snapToLane(on, "R", [farPass, near], M_PER_PX, LANE_PX);
    expect(Math.abs(got.lat - 41.826)).toBeLessThan(1e-4);
  });

  it("returns the original position when the route has no geometry", () => {
    const on = { lat: 41.826, lng: -71.4025 };
    expect(snapToLane(on, "R", [], M_PER_PX, LANE_PX)).toEqual(on);
    expect(snapToLane(on, "MISSING", [piece("R", 0, LINE)], M_PER_PX, LANE_PX)).toEqual(on);
  });

  it("does not move a bus that is already where it should be", () => {
    const on = { lat: 41.826, lng: -71.4025 };
    const got = snapToLane(on, "R", [piece("R", 0, LINE)], M_PER_PX, LANE_PX);
    expect(haversineMeters(got, on)).toBeLessThan(1);
  });
});
