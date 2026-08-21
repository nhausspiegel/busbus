import { planTrips, rankAndTrim, type PlanOptions } from "./plan";
import type { Itinerary, RideLeg } from "../data/types";

/** Slack for stepping off one bus and boarding another at the same stop.
 *  ponytail: flat constant; make it per-stop if a stop turns out to need it. */
const MIN_TRANSFER_SECONDS = 60;

/** Two-round earliest-arrival search.
 *
 *  Round 1 is planTrips unchanged. Round 2 treats every stop the first bus
 *  reaches as a fresh origin, with zero walking and an earliest-departure
 *  floor of (arrival + transfer slack).
 *
 *  A transfer is only surfaced when it arrives strictly earlier than the best
 *  direct ride -- riders dislike transfers, so an equal-arrival transfer is
 *  strictly worse. Under `arriveBy` that test inverts with the ranking: the
 *  transfer has to let the rider LEAVE later, since arriving sooner than
 *  necessary buys nothing once the deadline is met. */
export function planWithTransfers(
  opts: PlanOptions & { maxTransfers?: number },
): Itinerary[] {
  const direct = planTrips(opts);
  const maxTransfers = opts.maxTransfers ?? 1;
  if (maxTransfers < 1) return direct;

  const { feed, board, now } = opts;
  // The second leg is planned WITHOUT the deadline. Once the first bus is
  // fixed, the connection cannot change when the rider leaves home, so latest
  // departure is the wrong question for it -- earliest arrival is both the
  // least standing around at the transfer stop and the option most likely to
  // beat the deadline. The whole itinerary is checked against it below.
  const { arriveBy, ...noDeadline } = opts;
  const twoLeg: Itinerary[] = [];

  for (const [firstStopId, walkSecs] of opts.walkFromOrigin) {
    const readyAt = now + walkSecs;
    const boardStop = feed.stops.get(firstStopId);
    if (!boardStop) continue;

    for (const dep of board.get(firstStopId) ?? []) {
      if (dep.time < readyAt) continue;
      const trip1 = feed.trips.get(dep.tripId);
      if (!trip1) continue;
      // Same reasoning as plan.ts: join on stop id, since Passio's realtime
      // sequence numbers do not match its own static feed.
      const visits = trip1.stops.filter((s) => s.stopId === dep.stopId);
      const boardSched = visits.find((s) => s.seq === dep.seq) ?? visits[0];
      if (!boardSched) continue;

      for (const mid of trip1.stops) {
        if (mid.seq <= boardSched.seq) continue;
        // No membership test here. Skipping stops that happen to be walkable
        // from the destination suppressed genuinely faster connections: those
        // stops are merely the k NEAREST to the destination, and "nearest"
        // can still be a twenty-minute walk. Whether a transfer is worth
        // offering is decided by arrival time at the bottom of this function.

        const rideSecs = mid.time - boardSched.time;
        // Guard parity with plan.ts: without this a malformed feed row
        // produces a transfer that arrives before it departs.
        if (rideSecs <= 0) continue;
        const arriveMid = dep.time + rideSecs;
        const midStop = feed.stops.get(mid.stopId);
        if (!midStop) continue;

        const second = planTrips({
          ...noDeadline,
          origin: midStop,
          walkFromOrigin: new Map([[mid.stopId, 0]]),
          now: arriveMid + MIN_TRANSFER_SECONDS,
          maxResults: 1,
          // The second leg must be an actual ride. Inheriting the direct-walk
          // option here would let planTrips answer with a walk-only itinerary,
          // whose rides[] is empty -- which is not a transfer, and reading
          // rides[0] off it throws.
          directWalkSeconds: undefined,
        });
        const best = second[0];
        if (!best || best.rides.length === 0) continue;
        if (best.rides[0]!.routeId === dep.routeId) continue;  // same route isn't a transfer

        const leg1: RideLeg = {
          routeId: dep.routeId, tripId: dep.tripId,
          boardStopId: firstStopId, alightStopId: mid.stopId,
          departTime: dep.time, arriveTime: arriveMid,
          // Both ends of this subtraction must come from the STATIC trip.
          // dep.seq is Passio's realtime sequence, which numbers the same trip
          // differently -- mixing the two produced stop counts that were
          // simply wrong, and negative ones where the RT seq ran higher.
          live: dep.live, numStops: mid.seq - boardSched.seq,
          boardSeq: boardSched.seq,
        };

        twoLeg.push({
          arriveTime: best.arriveTime,
          departTime: dep.time - walkSecs,
          walkToStop: { from: opts.origin, to: boardStop, seconds: walkSecs },
          rides: [leg1, ...best.rides],
          walkFromStop: best.walkFromStop,
          totalWalkSeconds: walkSecs + best.walkFromStop.seconds,
          transfers: 1,
          allLive: dep.live && best.allLive,
        });
      }
    }
  }

  // Compare transfers against the best option that actually rides a bus; the
  // walk-only entry is not something a transfer can improve on.
  const bestDirect = direct.find((d) => d.rides.length > 0);
  const worthwhile = twoLeg.filter((t) =>
    (arriveBy === undefined || t.arriveTime <= arriveBy) &&
    (!bestDirect || (arriveBy === undefined
      ? t.arriveTime < bestDirect.arriveTime
      : t.departTime > bestDirect.departTime)));

  // One itinerary per route pair. Every intermediate stop on the first bus
  // produced its own near-identical two-leg trip, and since transfers sort
  // ahead of the direct ride they filled maxResults with five renderings of
  // the same journey -- pushing out both the direct option and the walk.
  const bestByPair = new Map<string, Itinerary>();
  for (const t of worthwhile) {
    const key = t.rides.map((r) => r.routeId).join(">");
    const prev = bestByPair.get(key);
    if (!prev) { bestByPair.set(key, t); continue; }
    const gain = arriveBy === undefined
      ? prev.arriveTime - t.arriveTime      // positive when t arrives earlier
      : t.departTime - prev.departTime;     // positive when t leaves later
    if (gain > 0 || (gain === 0 && t.totalWalkSeconds < prev.totalWalkSeconds)) {
      bestByPair.set(key, t);
    }
  }

  // Same horizon as planTrips: a transfer arriving tonight is not an
  // alternative to walking there this morning, even though it beats every
  // other RIDE.
  return rankAndTrim([...direct, ...bestByPair.values()], opts.maxResults ?? 5, arriveBy);
}
