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
  const out: RouteStop[] = [];
  for (const ts of longest) {
    // A loop revisits its first stop at the end; list each stop once.
    if (seen.has(ts.stopId)) continue;
    seen.add(ts.stopId);
    const stop = feed.stops.get(ts.stopId);
    if (!stop) continue;
    const next = (board.get(ts.stopId) ?? [])
      .filter((d) => d.routeId === routeId && d.time >= now)
      .sort((a, b) => a.time - b.time)[0] ?? null;
    out.push({ stop, seq: ts.seq, next });
  }
  return out;
}
