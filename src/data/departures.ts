import type { StaticFeed, Departure, DepartureBoard } from "./types";

/** Epoch seconds at local midnight of `now`'s day. GTFS times are offsets
 *  from this, which is what lets 25:11:00 stay after 23:00:00. */
export function serviceDayStart(now: Date): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

const DAY_SECONDS = 86_400;

/** Absolute departures from the timetable.
 *
 *  Emits BOTH the current service day and the previous one. GTFS encodes
 *  post-midnight service as 24:xx/25:xx belonging to the previous day, so at
 *  00:15 the 00:45 Evening bus lives at yesterday's dayStart + 24:45. Using
 *  only today's dayStart placed it 24 hours out and showed an empty board
 *  during exactly the hours the shuttle is the only way home. Callers already
 *  filter to `time >= now`, which discards the stale half. */
export function scheduledDepartures(feed: StaticFeed, dayStart: number): Departure[] {
  const out: Departure[] = [];
  for (const base of [dayStart - DAY_SECONDS, dayStart]) {
    for (const trip of feed.trips.values()) {
      for (const s of trip.stops) {
        out.push({
          stopId: s.stopId,
          tripId: trip.id,
          routeId: trip.routeId,
          seq: s.seq,
          time: base + s.time,
          live: false,
        });
      }
    }
  }
  return out;
}

/** A live trip's own stop sequence, in time order.
 *
 *  Passio's realtime and static feeds disagree about which stops a trip
 *  serves: RT trip 899435 reports 10 stops (seq 6-15) while the static trip of
 *  the same id has 4 (seq 1-4), overlapping in exactly one. So a live ride
 *  cannot borrow durations from the static trip -- but it does not need to,
 *  because the RT feed publishes absolute arrival times for every downstream
 *  stop itself. That is the better source anyway: it already accounts for how
 *  late the bus actually is. */
export function groupLiveTrips(live: Departure[]): Map<string, Departure[]> {
  const byTrip = new Map<string, Departure[]>();
  for (const d of live) byTrip.set(d.tripId, [...(byTrip.get(d.tripId) ?? []), d]);
  for (const list of byTrip.values()) list.sort((a, b) => a.time - b.time);
  return byTrip;
}

/** Merge live predictions over the timetable, grouped by stop.
 *  A live entry supersedes the scheduled entry for the same (tripId, stopId). */
export function buildBoard(live: Departure[], scheduled: Departure[]): DepartureBoard {
  // Include seq: shuttle routes are loops, so one trip visits a stop twice
  // (trip 899418 serves stop 8380 at seq 1 and again at seq 15). Keying on
  // trip+stop alone meant one live prediction for the first visit silently
  // deleted the second one too, and a rider waiting for it was told nothing
  // was coming.
  const key = (d: Departure) => `${d.tripId}|${d.stopId}|${d.seq}`;
  const superseded = new Set(live.map(key));
  // Passio publishes some trips twice under different trip_ids: 218795 and
  // 218820 are byte-identical, same route and service_id and shape and all 12
  // stop times. That is one bus, so the rider must be shown one departure --
  // otherwise the same route and minute filled the card twice and crowded out
  // the other routes serving the stop. Keyed on what a rider can actually tell
  // apart: which route, from which stop, at which second. A loop's second
  // visit has a different time and survives; two routes at one second are two
  // real choices and both survive. Live is pushed first, so when a duplicate
  // is half live and half timetable the reporting bus is the one kept.
  const shown = new Set<string>();
  const board: DepartureBoard = new Map();
  for (const d of [...live, ...scheduled]) {
    if (!d.live && superseded.has(key(d))) continue;
    const same = `${d.stopId}|${d.routeId}|${d.time}`;
    if (shown.has(same)) continue;
    shown.add(same);
    if (!board.has(d.stopId)) board.set(d.stopId, []);
    board.get(d.stopId)!.push(d);
  }
  for (const list of board.values()) list.sort((a, b) => a.time - b.time);
  return board;
}
