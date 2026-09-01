/**
 * Everything drawn along a route, derived in one place from ONE geometry.
 *
 * These used to live inside TransitMap and read the drawn geometry out of a
 * ref, so each consumer re-derived positions on its own -- and four separate
 * defects had the same shape: vehicles beside their own line, stops drifting
 * off it, the itinerary's ride sliced from the raw Passio shape while the
 * route under it was drawn from the bundler's output, and the ends of a ride
 * drawn as their own symbol next to the stops already there.
 *
 * Passing `drawn` in makes that impossible to get wrong quietly, and makes the
 * whole derivation testable without a browser -- which is what actually let
 * those defects ship, since a check that runs in the page can only ask what
 * was drawn, never whether it was right.
 */
import type { StaticFeed, LatLng } from "../data/types";
import { sliceShape } from "../routing/shape";
import { haversineMeters } from "../routing/walk";
import { stations } from "../routing/routeDetail";

/** Where a route's line is actually drawn at a given point -- supplied by the
 *  caller, because only the map knows the current scale. See `laneSnap`. */
export type Place = (routeId: string, at: LatLng) => LatLng;

/** The subset of the map overlay this module needs. */
export interface RideOverlay {
  rides: {
    path: LatLng[]; color: string; routeId: string;
    boardStopId?: string; alightStopId?: string;
  }[];
}

/** A LineString feature from lat/lng points. GeoJSON is [lng, lat]. */
export const lineFeature = (
c: LatLng[], properties: GeoJSON.GeoJsonProperties = {},
): GeoJSON.Feature => ({
type: "Feature", properties,
geometry: { type: "LineString", coordinates: c.map((p) => [p.lng, p.lat]) },
});

export function stationFeatures(
f: StaticFeed, activeRouteIds: Set<string>, place: Place,
): {
  beads: GeoJSON.Feature[]; ticks: GeoJSON.Feature[];
} {
  const beads: GeoJSON.Feature[] = [];
  const ticks: GeoJSON.Feature[] = [];
  for (const st of stations(f, activeRouteIds)) {
    const centre = { lat: st.lat, lng: st.lng };
    // ONE bead per line the station serves, each on THAT line's own lane.
    // Snapping the whole station onto the first route's geometry put the dot
    // on one line and left it floating beside every other line it serves --
    // the bundler fans them into separate lanes, so "the stop" was several
    // metres from most of its own routes.
    // Placed, not searched for. Every route on one street shares the centreline
    // byte for byte, so ONE projection gives one along-track position for the
    // whole station and each bead is that point plus its own lane offset --
    // perpendicular to the road, spaced exactly one gap, at every zoom, by
    // construction.
    //
    // It used to project the station centre onto each route's DRAWN line
    // separately. Those lines are sheared along-track at every corner (each
    // vertex is displaced by one segment's normal, with no miter), by an amount
    // proportional to the lane offset -- which is a pixel quantity, so the
    // shear grew with zoom and the bar rotated as the rider zoomed. Measured:
    // nine of twelve shared stations were off-perpendicular at some zoom, and
    // the bar ran from 4% to 281% of the length it should be.
    const on = st.routeIds.map((routeId) => ({ routeId, at: place(routeId, centre) }));
    for (const b of on) beads.push({
      type: "Feature" as const,
      properties: {
        name: st.name,
        // The route this bead belongs to. Without it nothing can check that a
        // bead sits on its own line -- and the test that was meant to do
        // exactly that read this property, found undefined, and skipped every
        // iteration for the whole life of the defect above.
        routeId: b.routeId,
        // The tap target still needs a real stop, so every bead of a station
        // carries the same first member id -- the halves are genuinely
        // different boarding points, but they are one place to tap.
        id: st.stopIds[0]!,
        // Pipe-delimited so a MapLibre expression can test membership:
        // ["in", "|3302|", ["get", "routes"]]. Passing the ids in as a prop
        // instead meant the map could not emphasise anything the parent had
        // not thought to precompute.
        routes: `|${st.routeIds.join("|")}|`,
        interchange: st.routeIds.length > 1,
        // Always the colour of the line this bead sits on. A neutral dot for
        // an interchange is the Underground's convention, but Brown has 12
        // interchanges out of 23 stations, so it greyed out the majority of
        // the map and told the rider nothing about which lines call there.
        color: f.routes.get(b.routeId)?.color ?? "#6F625A",
      },
      geometry: { type: "Point" as const, coordinates: [b.at.lng, b.at.lat] },
    });

    if (on.length < 2) continue;
    // The Underground's interchange tick: one bar through every bead, so the
    // station visibly touches every line it serves instead of being a dot
    // near some of them. Ordered along the axis between the two furthest
    // beads, otherwise a three-line station zigzags.
    const pts = on.map((b) => b.at);
    let a = pts[0]!, z = pts[1]!, far = -1;
    for (const u of pts) for (const v of pts) {
      const d = haversineMeters(u, v);
      if (d > far) { far = d; a = u; z = v; }
    }
    // When the beads coincide there is no gap to span, but the bar is still
    // what gives an interchange its white background -- skipping it left the
    // stop as a bare dot at exactly those zooms. Emit a stub instead: with a
    // round cap it draws as the circle the bar degenerates into.
    if (far < 0.5) {
      const eps = 0.3 / 111_320;
      ticks.push({
        type: "Feature" as const,
        properties: { id: st.stopIds[0]!, routes: `|${st.routeIds.join("|")}|` },
        geometry: { type: "LineString" as const,
                    coordinates: [[centre.lng, centre.lat - eps],
                                  [centre.lng, centre.lat + eps]] },
      });
      continue;
    }
    // A straight bar between the outermost beads. The beads are collinear now
    // -- one point on the road, displaced by evenly spaced lane offsets along
    // one normal -- so there is nothing to sort. The sort this replaces existed
    // only to stop a three-line station zigzagging when the beads were NOT
    // collinear, and it compared a dot product of raw degrees, mixing latitude
    // and longitude units that differ by a factor of 0.745 at this latitude.
    ticks.push({
      type: "Feature" as const,
      properties: { id: st.stopIds[0]!, routes: `|${st.routeIds.join("|")}|` },
      geometry: { type: "LineString" as const,
                  coordinates: [[a.lng, a.lat], [z.lng, z.lat]] },
    });
  }
  return { beads, ticks };
}

/**
 * The ridden portion of each route, taken from the line as DRAWN.
 *
 * It used to be sliced from `feed.routes.get(id).shape` -- the raw Passio
 * geometry -- while the route underneath was drawn from the bundler's
 * output, which deliberately moves a route wherever it shares a street. So
 * the itinerary's line and the route's own line were two different
 * geometries for the same road, stacked a few metres apart. Everything
 * positioned along a route reads the geometry that was drawn; this was the
 * last thing still reading the raw shape.
 */
export function rideFeatures(
f: StaticFeed | null, o: RideOverlay | null, drawn: Map<string, LatLng[]>,
): GeoJSON.Feature[] {
  if (!o) return [];
  return o.rides.flatMap((r) => {
    const line = drawn.get(r.routeId);
    const from = r.boardStopId ? f?.stops.get(r.boardStopId) : undefined;
    const to = r.alightStopId ? f?.stops.get(r.alightStopId) : undefined;
    const path = line && line.length > 1 && from && to
      ? sliceShape(line, from, to)
      : r.path;
    if (path.length < 2) return [];
    return [lineFeature(path, { color: r.color, routeId: r.routeId })];
  });
}
