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
import { stations } from "../routing/routeDetail";

/** Where a whole station's beads are drawn -- supplied by the caller, because
 *  only the map knows the current scale. A station at a time, not a route at a
 *  time: placing each bead against its own route independently is what let the
 *  beads of one station land on two different streets. Returned in lane order,
 *  so the first and last are the outermost. See `stationLanes`. */
export type Place = (routeIds: string[], at: LatLng) => Map<string, LatLng>;

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
    // ONE bead per line the station serves, the whole station placed at once.
    // Asking for each bead separately projected the centre onto each route's
    // own line, and where a station's routes meet at a corner those are
    // different streets: the beads landed on both and the bar ran diagonally
    // across the junction. Measured: nine of twelve shared stations were
    // off-perpendicular at some zoom and the bar ran 4% to 281% of its length.
    const on = [...place(st.routeIds, centre)].map(([routeId, at]) => ({ routeId, at }));
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
    // station visibly touches every line it serves instead of being a dot near
    // some of them. Its ends are the outermost beads, which are the first and
    // last of `on` BY CONSTRUCTION -- one point on the road displaced by evenly
    // spaced lane offsets along one normal, in lane order. Nothing is searched
    // for or sorted: the two-furthest-beads scan this replaces, and the stub
    // for when it found no gap to span, both existed only because the beads
    // used to be placed independently and so could land anywhere.
    const a = on[0]!.at, z = on[on.length - 1]!.at;
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
