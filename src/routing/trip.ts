import { fetchStaticFeed } from "../data/gtfs";
import { fetchLiveDepartures } from "../data/realtime";
import { serviceDayStart, scheduledDepartures, buildBoard, groupLiveTrips } from "../data/departures";
import { nearestStops, walkMatrixMulti } from "./walk";
import { stopRoutes } from "./routeDetail";
import { planWithTransfers } from "./transfers";
import type { LatLng, Itinerary, StaticFeed, DepartureBoard, Departure } from "../data/types";

const CANDIDATE_STOPS = 8;

/** Rank itineraries between two points, walking included as an option.
 *
 *  Takes an already-loaded feed and departure board so the app can reuse what
 *  it is already polling. One Valhalla request covers the whole search:
 *  origin and destination as sources, every candidate stop plus the
 *  destination itself as targets. Three parallel requests got FOSSGIS's
 *  community instance to throttle us, and a throttled response has no CORS
 *  headers, so the browser reports it as a CORS error rather than a rate limit. */
export async function planBetween(
  feed: StaticFeed,
  board: DepartureBoard,
  origin: LatLng,
  destination: LatLng,
  now: Date = new Date(),
  liveTrips?: Map<string, Departure[]>,
  /** Arrive-by deadline. `now` stays the earliest-departure floor, so in this
   *  mode it should be the actual current time, not the chosen time. */
  arriveBy?: Date,
): Promise<Itinerary[]> {
  // Only stops a route actually serves may take a candidate slot.
  //
  // Brown's feed ships 70 stops and just 33 sit on any route -- the rest are
  // On Call pickup points, parking lots and monuments that no shuttle calls
  // at. Ranking all 70 by distance let those crowd the list out: measured
  // beside Barus & Holley, 6 of the 8 nearest stops were unservable
  // ("Soldiers Arch", "Lot 44/ Engineering", "On Call Stop 1", both Manning
  // Walk stops), leaving 2 slots to find a shuttle with. That is why rides
  // went missing from places that plainly have one.
  const serving = stopRoutes(feed);
  const all = [...feed.stops.values()].filter((s) => (serving.get(s.id) ?? []).length > 0);
  const fromStops = nearestStops(origin, all, CANDIDATE_STOPS);
  const toStops = nearestStops(destination, all, CANDIDATE_STOPS);
  const targets = [...fromStops, ...toStops, destination];

  const rows = await walkMatrixMulti([origin, destination], targets);

  const walkFromOrigin = new Map<string, number>();
  fromStops.forEach((s, i) => {
    const t = rows[0]?.[i];
    if (typeof t === "number") walkFromOrigin.set(s.id, t);
  });

  const walkToDestination = new Map<string, number>();
  toStops.forEach((s, i) => {
    // Row 1 is measured FROM the destination; its targets start after fromStops.
    const t = rows[1]?.[fromStops.length + i];
    if (typeof t === "number") walkToDestination.set(s.id, t);
  });

  // Last target is the destination itself, measured from the origin.
  const direct = rows[0]?.[targets.length - 1];

  return planWithTransfers({
    feed, board, origin, destination,
    walkFromOrigin, walkToDestination,
    ...(liveTrips ? { liveTrips } : {}),
    ...(typeof direct === "number" ? { directWalkSeconds: direct } : {}),
    ...(arriveBy ? { arriveBy: Math.floor(arriveBy.getTime() / 1000) } : {}),
    now: Math.floor(now.getTime() / 1000),
  });
}

/** Standalone entry point: loads the feeds itself. Used by scripts.
 *
 *  This one DOES fold in the timetable, unlike the app, so the planner can
 *  still be exercised from the command line when nothing is running -- which
 *  is most of the time. Anything it returns is a shape to develop against, not
 *  a claim about a bus. The app builds its board from live departures only. */
export async function findItineraries(
  origin: LatLng,
  destination: LatLng,
  now: Date = new Date(),
): Promise<Itinerary[]> {
  const feed = await fetchStaticFeed();
  const live = await fetchLiveDepartures().catch(() => []);
  const board = buildBoard(live, scheduledDepartures(feed, serviceDayStart(now)));
  return planBetween(feed, board, origin, destination, now, groupLiveTrips(live));
}
