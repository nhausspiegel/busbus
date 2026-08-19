import { haversineMeters } from "./walk";
import type { LatLng } from "../data/types";

/** Index of the shape point closest to `p`. */
function nearestIndex(shape: LatLng[], p: LatLng): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < shape.length; i++) {
    const d = haversineMeters(shape[i]!, p);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** The portion of a route's polyline actually ridden, from one stop to another.
 *
 *  Drawing the whole route shape for a two-stop hop is misleading -- the rider
 *  is not going round the loop. Shuttle routes are loops, so when the alight
 *  point comes before the boarding point in the shape the correct segment wraps
 *  around the end rather than running backwards. */
export function sliceShape(shape: LatLng[], from: LatLng, to: LatLng): LatLng[] {
  if (shape.length < 2) return [];
  const a = nearestIndex(shape, from);
  const b = nearestIndex(shape, to);
  if (a === b) return [];
  if (a < b) return shape.slice(a, b + 1);
  // Loop wrap: ride to the end of the shape, then on from the start.
  return [...shape.slice(a), ...shape.slice(0, b + 1)];
}
