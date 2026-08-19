import type { StaticFeed, RideLeg, Stop } from "../data/types";

export interface RideStop { stop: Stop; time: number; boarding: boolean; alighting: boolean }

/** The stops a ride passes through, boarding and alighting included.
 *
 *  Riders need this to know when to get off -- a shuttle announces nothing,
 *  and "7 stops" alone does not tell you which one is yours.
 *
 *  Times are derived from the timetable's stop-to-stop offsets applied to the
 *  ride's actual departure time, so a bus running late shifts the whole leg
 *  rather than showing intermediate stops at their original scheduled times. */
export function rideStops(feed: StaticFeed, ride: RideLeg): RideStop[] {
  const trip = feed.trips.get(ride.tripId);
  if (!trip) return [];

  const board = trip.stops.find((s) => s.stopId === ride.boardStopId);
  const alight = trip.stops.find((s) => s.stopId === ride.alightStopId && s.seq > (board?.seq ?? -1));
  if (!board || !alight) return [];

  const out: RideStop[] = [];
  for (const ts of trip.stops) {
    if (ts.seq < board.seq || ts.seq > alight.seq) continue;
    const stop = feed.stops.get(ts.stopId);
    if (!stop) continue;
    out.push({
      stop,
      time: ride.departTime + (ts.time - board.time),
      boarding: ts.seq === board.seq,
      alighting: ts.seq === alight.seq,
    });
  }
  return out;
}
