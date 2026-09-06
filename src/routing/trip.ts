import { fetchStaticFeed } from "../data/gtfs";
import { fetchLiveDepartures } from "../data/realtime";
import { serviceDayStart, scheduledDepartures, buildBoard, groupLiveTrips } from "../data/departures";
import { nearestStops, walkMatrixMulti } from "./walk";
import { stopRoutes } from "./routeDetail";
import { planWithTransfers } from "./transfers";
import type { LatLng, Itinerary, StaticFeed, DepartureBoard, Departure, Stop } from "../data/types";

const CANDIDATE_STOPS = 8;
/** Extra slots for stops only Passio knows about, ADDED to the eight rather
 *  than competing for them. Competing is what let parking lots and monuments
 *  take a real stop's place; adding cannot. */
const RIDEABLE_STOPS = 3;

/**
 * The stops a ride can actually be planned to or from, in two groups.
 *
 * `served` is any stop a GTFS trip calls at. `rideable` is a stop only Passio's
 * list knows about, admitted ONLY when an adjacent leg has been observed --
 * because an observed leg is the one thing that can time a ride to it.
 *
 * The old rule was "has a GTFS trip", and its reasoning still holds: a stop
 * with no times behind it must not take a candidate slot, which is how 6 of the
 * 8 nearest to Barus & Holley came back parking lots, monuments and On Call
 * points. What changed is that "no trip" stopped implying "no times" once
 * legTimes existed. Eight stops on real routes were unplannable, among them
 * Dyer & Pine, 306m from the RISD Fleet Library and on the Daytime Express.
 *
 * With no observed legs this returns an empty `rideable`, which is exactly the
 * behaviour it replaces -- so a rider whose record is empty cannot be handed
 * the old regression.
 */
export function candidateStops(
  feed: StaticFeed,
  legSecondsFor?: (routeId: string, from: string, to: string) => number | null,
): { served: Stop[]; rideable: Stop[] } {
  const serving = stopRoutes(feed);
  const timed = new Set<string>();
  if (legSecondsFor) {
    for (const [routeId, order] of feed.routeStops ?? []) {
      for (let i = 1; i < order.length; i++) {
        const a = order[i - 1]!, b = order[i]!;
        if (a === b) continue;
        if (legSecondsFor(routeId, a, b) !== null) { timed.add(a); timed.add(b); }
      }
    }
  }
  const served: Stop[] = [], rideable: Stop[] = [];
  for (const s of feed.stops.values()) {
    if ((serving.get(s.id) ?? []).length > 0) served.push(s);
    else if (timed.has(s.id)) rideable.push(s);
  }
  return { served, rideable };
}

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
  /** Legs that have actually been observed, for routes whose GTFS trip does
   *  not carry their stops. */
  legSecondsFor?: (routeId: string, from: string, to: string) => number | null,
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
  const { served, rideable } = candidateStops(feed, legSecondsFor);
  // The eight nearest servable stops, PLUS up to three nearby stops that only
  // Passio lists and that observed legs can time. Added, never substituted, so
  // a real stop can never lose its slot to one of these.
  const near = (p: LatLng) => {
    const first = nearestStops(p, served, CANDIDATE_STOPS);
    const seen = new Set(first.map((s) => s.id));
    return [...first, ...nearestStops(p, rideable, RIDEABLE_STOPS)
      .filter((s) => !seen.has(s.id))];
  };
  const fromStops = near(origin);
  const toStops = near(destination);
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
    ...(legSecondsFor ? { legSecondsFor } : {}),
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
