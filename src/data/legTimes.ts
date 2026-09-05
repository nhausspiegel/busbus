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

/**
 * Longest a stop-to-stop leg may be and still be a bus.
 *
 * Measured on the shipped feed: of the 2039 adjacent legs the timetable
 * schedules, 2037 are 300s or less; the two exceptions are a 600s leg on 3302
 * and a 2580s terminal layover on 3469. Fifteen minutes is triple that 99.9th
 * percentile, so no ride between adjacent stops is thrown away, while a
 * reading like the 1375 recorded between 7860 and 8381 -- thirteen times its
 * own neighbours of 103, 107 and 120 -- is. Those come from realtime pairing a
 * stale prediction with a fresh one, and no number of them is a bus.
 *
 * The 3469 layover is the one real thing this refuses. That costs a planner
 * that says nothing about crossing it, which is the answer this project
 * prefers to a made-up one.
 */
export const MAX_LEG_SECONDS = 900;

const key = (routeId: string, from: string, to: string) => `${routeId}|${from}|${to}`;

/** Which trip instance a prediction belongs to. The trip id alone repeats
 *  daily, so it is stamped with the day the prediction falls on -- the same
 *  bus tomorrow is a new observation, the same bus fifteen minutes later is
 *  not. */
const tripStamp = (d: Departure) => `${d.tripId}@${Math.floor(d.time / 86_400)}`;

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
  const legTrips = { ...(history.legTrips ?? {}) };
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!, b = stops[i]!;
    const seconds = b.time - a.time;
    // Passio's realtime is not always ordered or sane. A zero or negative leg
    // is not a fast bus, it is a bad reading, and averaging it in would drag
    // every ride built on this leg short. Nor is a 23-minute one a slow bus.
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_LEG_SECONDS) continue;
    if (a.stopId === b.stopId) continue;
    const k = key(a.routeId, a.stopId, b.stopId);
    // One trip contributes at most one sample per leg. The recorder polls
    // every fifteen minutes and a trip is out for the best part of an hour, so
    // without this the five samples MIN_LEG_SAMPLES demands can be five polls
    // of ONE bus -- which is the "one slow afternoon is the whole answer" it
    // was written to prevent, in a costume.
    const stamp = tripStamp(a);
    if ((legTrips[k] ?? []).includes(stamp)) continue;
    legs[k] = [...(legs[k] ?? []), seconds].slice(-LEG_SAMPLES);
    legTrips[k] = [...(legTrips[k] ?? []), stamp].slice(-LEG_SAMPLES);
  }
  return { ...history, legs, legTrips };
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
