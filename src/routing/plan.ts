import type {
  StaticFeed, DepartureBoard, Departure, Itinerary, LatLng, RideLeg, Trip, TripStop,
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
  /** Each live trip's own stop sequence, from groupLiveTrips(). A live ride is
   *  planned entirely from these, never from the static trip. */
  liveTrips?: Map<string, Departure[]>;
  /** Walking seconds straight from origin to destination, if known. */
  directWalkSeconds?: number;
  maxResults?: number;
}

/** Beyond this, walking stops being a real option for a campus shuttle app
 *  and listing it is just noise. */
const MAX_REASONABLE_WALK_SECONDS = 45 * 60;

/** How much later than the best option an itinerary may arrive and still be
 *  worth offering. Brown's routes run in shifts, so a search at 10am finds
 *  Daytime buses now and an Evening bus tonight -- and listing "arrive 7:08pm"
 *  beside "arrive 10:16am" is not a choice anyone is making. */
export const MAX_LATER_THAN_BEST_SECONDS = 90 * 60;

/** Drop options arriving far later than the best one, and cap the list. */
export function rankAndTrim(all: Itinerary[], maxResults: number): Itinerary[] {
  const ranked = [...all].sort((a, b) =>
    a.arriveTime - b.arriveTime ||
    a.transfers - b.transfers ||
    a.totalWalkSeconds - b.totalWalkSeconds);
  const best = ranked[0];
  return ranked
    .filter((i) => !best || i.arriveTime - best.arriveTime <= MAX_LATER_THAN_BEST_SECONDS)
    .slice(0, maxResults);
}

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
/** The static stop a live departure refers to.
 *
 *  Matches on stop id. A loop visits the same stop twice, so when there is a
 *  choice the realtime sequence breaks the tie if it happens to line up;
 *  otherwise the earliest visit is assumed, which is the one a rider standing
 *  there is waiting for. */
function boardingStop(trip: Trip, stopId: string, rtSeq: number): TripStop | undefined {
  const visits = trip.stops.filter((s) => s.stopId === stopId);
  if (visits.length <= 1) return visits[0];
  return visits.find((s) => s.seq === rtSeq) ?? visits[0];
}

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

      // A live departure rides its own realtime trip: Passio's RT and static
      // feeds list different stops for the same trip id, so the static trip
      // cannot supply this ride's durations. RT already gives absolute times.
      const rtTrip = dep.live ? opts.liveTrips?.get(dep.tripId) : undefined;
      if (rtTrip) {
        const boardIdx = rtTrip.findIndex((r) => r.stopId === dep.stopId && r.time === dep.time);
        if (boardIdx === -1) continue;
        for (let i = boardIdx + 1; i < rtTrip.length; i++) {
          const alightRt = rtTrip[i]!;
          const finalWalk = walkToDestination.get(alightRt.stopId);
          if (finalWalk === undefined) continue;
          const alightStop = feed.stops.get(alightRt.stopId);
          if (!alightStop || alightRt.time <= dep.time) continue;
          found.push({
            arriveTime: alightRt.time + finalWalk,
            departTime: dep.time - walkSecs,
            walkToStop: { from: origin, to: boardStop, seconds: walkSecs },
            rides: [{
              routeId: dep.routeId, tripId: dep.tripId,
              boardStopId: dep.stopId, alightStopId: alightRt.stopId,
              departTime: dep.time, arriveTime: alightRt.time,
              live: true, numStops: i - boardIdx,
            }],
            walkFromStop: { from: alightStop, to: destination, seconds: finalWalk },
            totalWalkSeconds: walkSecs + finalWalk,
            transfers: 0,
            allLive: true,
          });
        }
        continue;
      }

      const trip = feed.trips.get(dep.tripId);
      if (!trip) continue;

      // Locate the boarding stop by STOP, not by sequence number. Passio's
      // realtime feed numbers a trip's stops differently from its own static
      // feed -- every live departure in the repo's fixtures has a seq that
      // does not exist on the matching static trip -- so joining on seq threw
      // away all live data, and a colliding seq would have silently measured
      // the ride from a different stop than the rider is standing at.
      const boardSched = boardingStop(trip, dep.stopId, dep.seq);
      if (!boardSched) continue;

      for (const alight of trip.stops) {
        // Strictly downstream, in the STATIC sequence -- the only one both
        // ends of this comparison share.
        if (alight.seq <= boardSched.seq) continue;

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
          numStops: alight.seq - boardSched.seq,
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

  return rankAndTrim([...bestByRoute.values()], maxResults);
}
