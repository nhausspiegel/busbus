import { fetchStaticFeed } from "../data/gtfs";
import { fetchLiveDepartures } from "../data/realtime";
import { serviceDayStart, scheduledDepartures, buildBoard } from "../data/departures";
import { nearestStops, walkMatrix } from "./walk";
import { planWithTransfers } from "./transfers";
import type { LatLng, Itinerary, StaticFeed } from "../data/types";

const CANDIDATE_STOPS = 8;
let cachedFeed: StaticFeed | null = null;

/** Fetch everything needed and rank itineraries by earliest arrival.
 *  One Valhalla call per end, one RT fetch, and the GTFS zip only once. */
export async function findItineraries(
  origin: LatLng,
  destination: LatLng,
  now: Date = new Date(),
): Promise<Itinerary[]> {
  cachedFeed ??= await fetchStaticFeed();
  const feed = cachedFeed;
  const allStops = [...feed.stops.values()];

  const originStops = nearestStops(origin, allStops, CANDIDATE_STOPS);
  const destStops = nearestStops(destination, allStops, CANDIDATE_STOPS);

  const [live, walkFromOrigin, walkToDestination] = await Promise.all([
    fetchLiveDepartures().catch(() => []),   // RT is optional; timetable still works
    walkMatrix(origin, originStops),
    walkMatrix(destination, destStops),      // pedestrian costing is ~symmetric
  ]);

  const board = buildBoard(live, scheduledDepartures(feed, serviceDayStart(now)));
  return planWithTransfers({
    feed, board, origin, destination,
    walkFromOrigin, walkToDestination,
    now: Math.floor(now.getTime() / 1000),
  });
}
