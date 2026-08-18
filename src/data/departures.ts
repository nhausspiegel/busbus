import type { StaticFeed, Departure, DepartureBoard } from "./types";

/** Epoch seconds at local midnight of `now`'s day. GTFS times are offsets
 *  from this, which is what lets 25:11:00 stay after 23:00:00. */
export function serviceDayStart(now: Date): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export function scheduledDepartures(feed: StaticFeed, dayStart: number): Departure[] {
  const out: Departure[] = [];
  for (const trip of feed.trips.values()) {
    for (const s of trip.stops) {
      out.push({
        stopId: s.stopId,
        tripId: trip.id,
        routeId: trip.routeId,
        seq: s.seq,
        time: dayStart + s.time,
        live: false,
      });
    }
  }
  return out;
}

/** Merge live predictions over the timetable, grouped by stop.
 *  A live entry supersedes the scheduled entry for the same (tripId, stopId). */
export function buildBoard(live: Departure[], scheduled: Departure[]): DepartureBoard {
  const key = (d: Departure) => `${d.tripId}|${d.stopId}`;
  const superseded = new Set(live.map(key));
  const board: DepartureBoard = new Map();
  for (const d of [...live, ...scheduled]) {
    if (!d.live && superseded.has(key(d))) continue;
    if (!board.has(d.stopId)) board.set(d.stopId, []);
    board.get(d.stopId)!.push(d);
  }
  for (const list of board.values()) list.sort((a, b) => a.time - b.time);
  return board;
}
