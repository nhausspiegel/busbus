import { planTrips, type PlanOptions } from "./plan";
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
 *  strictly worse. */
export function planWithTransfers(
  opts: PlanOptions & { maxTransfers?: number },
): Itinerary[] {
  const direct = planTrips(opts);
  const maxTransfers = opts.maxTransfers ?? 1;
  if (maxTransfers < 1) return direct;

  const { feed, board, now } = opts;
  const twoLeg: Itinerary[] = [];

  for (const [firstStopId, walkSecs] of opts.walkFromOrigin) {
    const readyAt = now + walkSecs;
    const boardStop = feed.stops.get(firstStopId);
    if (!boardStop) continue;

    for (const dep of board.get(firstStopId) ?? []) {
      if (dep.time < readyAt) continue;
      const trip1 = feed.trips.get(dep.tripId);
      if (!trip1) continue;
      const boardSched = trip1.stops.find((s) => s.seq === dep.seq);
      if (!boardSched) continue;

      for (const mid of trip1.stops) {
        if (mid.seq <= dep.seq) continue;
        // Already covered by a direct ride; transferring here is pointless.
        if (opts.walkToDestination.has(mid.stopId)) continue;

        const arriveMid = dep.time + (mid.time - boardSched.time);
        const midStop = feed.stops.get(mid.stopId);
        if (!midStop) continue;

        const second = planTrips({
          ...opts,
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
          live: dep.live, numStops: mid.seq - dep.seq,
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
  const worthwhile = twoLeg.filter((t) => !bestDirect || t.arriveTime < bestDirect.arriveTime);

  return [...direct, ...worthwhile]
    .sort((a, b) =>
      a.arriveTime - b.arriveTime ||
      a.transfers - b.transfers ||
      a.totalWalkSeconds - b.totalWalkSeconds)
    .slice(0, opts.maxResults ?? 5);
}
