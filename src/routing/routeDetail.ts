import type { StaticFeed, DepartureBoard, Departure, Stop } from "../data/types";

export interface RouteStop {
  stop: Stop;
  seq: number;
  next: Departure | null;   // next departure from this stop on this route
}

/** The stops a route serves, in riding order, each with its next departure.
 *
 *  Order comes from the longest trip on the route: short trips skip stops, so
 *  taking any one trip would hide part of the line. */
export function routeStops(
  feed: StaticFeed, board: DepartureBoard, routeId: string, now: number,
): RouteStop[] {
  let longest: { stopId: string; seq: number }[] = [];
  for (const trip of feed.trips.values()) {
    if (trip.routeId !== routeId) continue;
    if (trip.stops.length > longest.length) longest = trip.stops;
  }

  const seen = new Set<string>();
  const ordered: { stop: Stop; seq: number; stopId: string }[] = [];
  for (const ts of longest) {
    // A loop revisits its first stop at the end; list each stop once.
    if (seen.has(ts.stopId)) continue;
    seen.add(ts.stopId);
    const stop = feed.stops.get(ts.stopId);
    if (stop) ordered.push({ stop, seq: ts.seq, stopId: ts.stopId });
  }

  // ONE vehicle's run down the line, not the soonest arrival at each stop from
  // whichever bus happens to be nearest it. With two buses on a loop the
  // per-stop minimum sawtooths -- the times restart every time the list passes
  // the other bus. Every row was individually right and the column was
  // nonsense. Apple Maps does the same thing: the stop list follows one
  // vehicle, and the others appear as separate upcoming departures.
  const upcoming = (stopId: string) =>
    (board.get(stopId) ?? [])
      .filter((d) => d.routeId === routeId && d.time >= now)
      .sort((a, b) => a.time - b.time);

  const chosen = ordered[0] ? upcoming(ordered[0].stopId)[0]?.tripId : undefined;

  return ordered.map(({ stop, seq, stopId }) => {
    const here = upcoming(stopId);
    // A short trip may skip a stop the longest trip serves, so fall back to
    // the soonest rather than leaving a hole in the middle of the line.
    const next = (chosen ? here.find((d) => d.tripId === chosen) : undefined)
      ?? here[0] ?? null;
    return { stop, seq, next };
  });
}
