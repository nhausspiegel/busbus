import { fetchStaticFeed } from "../data/gtfs";
import { fetchLiveDepartures } from "../data/realtime";
import { serviceDayStart, scheduledDepartures, buildBoard } from "../data/departures";
import { nearestStops, walkMatrixMulti } from "./walk";
import { planWithTransfers } from "./transfers";
import type { LatLng, Itinerary, StaticFeed, DepartureBoard } from "../data/types";

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
): Promise<Itinerary[]> {
  const all = [...feed.stops.values()];
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
    ...(typeof direct === "number" ? { directWalkSeconds: direct } : {}),
    now: Math.floor(now.getTime() / 1000),
  });
}

/** Standalone entry point: loads the feeds itself. Used by scripts. */
export async function findItineraries(
  origin: LatLng,
  destination: LatLng,
  now: Date = new Date(),
): Promise<Itinerary[]> {
  const feed = await fetchStaticFeed();
  const live = await fetchLiveDepartures().catch(() => []);
  const board = buildBoard(live, scheduledDepartures(feed, serviceDayStart(now)));
  return planBetween(feed, board, origin, destination, now);
}
