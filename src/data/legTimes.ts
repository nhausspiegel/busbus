import type { Departure } from "./types";
import type { ServiceHistory } from "./serviceHistory";

/**
 * How long a ride between two stops actually takes, learned by watching.
 *
 * The Daytime Express is the case this exists for. Measured 2026-08-29: its
 * GTFS trip carries TWO of the nine stops it calls at, so the planner can only
 * build a ride between those two, and a rider at John Hay Library is offered a
 * walk while a shuttle they could board goes past. Passio publishes the stop
 * ORDER, which fixed the map and the route page, but nothing anywhere gives
 * the durations -- and deriving one from distance and an assumed speed would
 * be exactly the unfounded claim this project refuses to print.
 *
 * Watching is the honest way to get them. Realtime publishes an absolute time
 * per stop, so the gap between two of them on one trip is a MEASURED leg. Ride
 * times built this way are anchored to a live departure and a duration that
 * really happened, which is the same standard the rest of the app holds.
 */

/** Samples kept per leg. Enough for a stable median, few enough that the
 *  record follows a rerouting rather than averaging over it forever. */
export const LEG_SAMPLES = 20;
/** Below this, one slow afternoon would be the whole answer. */
export const MIN_LEG_SAMPLES = 5;

const key = (routeId: string, from: string, to: string) => `${routeId}|${from}|${to}`;

/**
 * Fold one realtime trip's stop times into the record.
 *
 * `stops` is one trip's predictions in the order realtime gave them, as
 * groupLiveTrips() returns them. Only ADJACENT pairs are recorded: A to C is
 * two legs, and storing it as its own would double count and would be wrong
 * the moment a trip skips a stop.
 */
export function recordLegs(history: ServiceHistory, stops: Departure[]): ServiceHistory {
  const legs = { ...(history.legs ?? {}) };
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!, b = stops[i]!;
    const seconds = b.time - a.time;
    // Passio's realtime is not always ordered or sane. A zero or negative leg
    // is not a fast bus, it is a bad reading, and averaging it in would drag
    // every ride built on this leg short.
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    if (a.stopId === b.stopId) continue;
    const k = key(a.routeId, a.stopId, b.stopId);
    legs[k] = [...(legs[k] ?? []), seconds].slice(-LEG_SAMPLES);
  }
  return { ...history, legs };
}

/**
 * The observed time for one leg, or null when too little has been seen.
 *
 * Median rather than mean: a bus held at a light, or one whose prediction
 * jumped, would otherwise set the time for everybody.
 */
export function legSeconds(
  history: ServiceHistory, routeId: string, from: string, to: string,
): number | null {
  const samples = history.legs?.[key(routeId, from, to)];
  if (!samples || samples.length < MIN_LEG_SAMPLES) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
