import type {
  StaticFeed, DepartureBoard, Itinerary, LatLng, RideLeg,
} from "../data/types";

export interface PlanOptions {
  feed: StaticFeed;
  board: DepartureBoard;
  origin: LatLng;
  destination: LatLng;
  /** stopId -> walking seconds from the origin. Already pruned to k nearest. */
  walkFromOrigin: Map<string, number>;
  /** stopId -> walking seconds to the destination. */
  walkToDestination: Map<string, number>;
  now: number;            // epoch seconds
  /** Walking seconds straight from origin to destination, if known. */
  directWalkSeconds?: number;
  maxResults?: number;
}

/** Beyond this, walking stops being a real option for a campus shuttle app
 *  and listing it is just noise. */
const MAX_REASONABLE_WALK_SECONDS = 45 * 60;

/** An itinerary with no rides: the rider just walks. */
export function isWalkOnly(it: Itinerary): boolean {
  return it.rides.length === 0;
}

/** Rank single-shuttle itineraries by arrival time at the destination.
 *
 *  Earliest ARRIVAL, not shortest ride: a slower bus leaving now routinely
 *  beats an express leaving in fifteen minutes, and the rider only cares when
 *  they actually get there.
 *
 *  Pure by construction -- no fetch, no Date.now(). Every input is an argument,
 *  which is what makes the ranking logic testable without the network.
 *
 *  ponytail: single-ride only; transfers.ts layers a second round on top. */
export function planTrips(opts: PlanOptions): Itinerary[] {
  const { feed, board, origin, destination, walkFromOrigin, walkToDestination, now } = opts;
  const maxResults = opts.maxResults ?? 5;

  const found: Itinerary[] = [];

  for (const [boardStopId, walkSecs] of walkFromOrigin) {
    const readyAt = now + walkSecs;
    const boardStop = feed.stops.get(boardStopId);
    if (!boardStop) continue;

    for (const dep of board.get(boardStopId) ?? []) {
      // Cannot board a bus that leaves before you can get there on foot.
      if (dep.time < readyAt) continue;

      const trip = feed.trips.get(dep.tripId);
      if (!trip) continue;

      // Ride durations come from the timetable's own stop-to-stop offsets,
      // applied to the actual (possibly live, possibly late) departure time.
      const boardSched = trip.stops.find((s) => s.seq === dep.seq);
      if (!boardSched) continue;

      for (const alight of trip.stops) {
        // Strictly downstream. stop_sequence is monotonic in both the static
        // feed and Passio's RT updates, so this comparison is sound.
        if (alight.seq <= dep.seq) continue;

        const finalWalk = walkToDestination.get(alight.stopId);
        if (finalWalk === undefined) continue;

        const alightStop = feed.stops.get(alight.stopId);
        if (!alightStop) continue;

        const rideSecs = alight.time - boardSched.time;
        if (rideSecs <= 0) continue;

        const arriveStop = dep.time + rideSecs;
        const ride: RideLeg = {
          routeId: dep.routeId,
          tripId: dep.tripId,
          boardStopId,
          alightStopId: alight.stopId,
          departTime: dep.time,
          arriveTime: arriveStop,
          live: dep.live,
          numStops: alight.seq - dep.seq,
        };

        found.push({
          arriveTime: arriveStop + finalWalk,
          departTime: dep.time - walkSecs,
          walkToStop: { from: origin, to: boardStop, seconds: walkSecs },
          rides: [ride],
          walkFromStop: { from: alightStop, to: destination, seconds: finalWalk },
          totalWalkSeconds: walkSecs + finalWalk,
          transfers: 0,
          allLive: dep.live,
        });
      }
    }
  }

  // Walking is a real option and sometimes the best one: waiting nine minutes
  // for a bus that loops seven stops across a few blocks is worse than simply
  // walking there. Emitted as an itinerary so it ranks by arrival like any
  // other, rather than being special-cased in the UI.
  const walk = opts.directWalkSeconds;
  if (walk !== undefined && walk <= MAX_REASONABLE_WALK_SECONDS) {
    found.push({
      arriveTime: now + walk,
      departTime: now,
      walkToStop: { from: origin, to: destination, seconds: walk },
      rides: [],
      walkFromStop: { from: destination, to: destination, seconds: 0 },
      totalWalkSeconds: walk,
      transfers: 0,
      // Your own legs are not a prediction, so this is never an unconfirmed claim.
      allLive: true,
    });
  }

  // One suggestion per route: riders choose between routes, not between the
  // 3:00 and the 3:20 bus on the same route.
  const bestByRoute = new Map<string, Itinerary>();
  for (const it of found) {
    const key = it.rides[0]?.routeId ?? "__walk__";
    const prev = bestByRoute.get(key);
    if (!prev || it.arriveTime < prev.arriveTime) bestByRoute.set(key, it);
  }

  return [...bestByRoute.values()]
    .sort((a, b) =>
      a.arriveTime - b.arriveTime ||
      a.totalWalkSeconds - b.totalWalkSeconds ||
      a.transfers - b.transfers)
    .slice(0, maxResults);
}
