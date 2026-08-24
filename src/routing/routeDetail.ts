import type { StaticFeed, DepartureBoard, Departure, Stop, LatLng } from "../data/types";
import { distanceAlongShape, shapeLength } from "./shape";

export interface RouteStop {
  stop: Stop;
  seq: number;
  next: Departure | null;   // next departure from this stop on this route
}

/** One physical place a rider waits, which may be several GTFS stops. */
export interface Station {
  /** The member stop ids, sorted. Departures still key on these. */
  stopIds: string[];
  name: string;
  lat: number;
  lng: number;
  /** Every running route calling at any member, sorted. */
  routeIds: string[];
}

/** Stop ids this close are the same place. Passio's per-direction pairs sit
 *  11-17m apart; the nearest genuinely distinct stops are far further. */
const STATION_M = 25;

/**
 * Group the stops into the places a rider would actually name.
 *
 * Passio models one physical stop as several stop_ids -- one per direction, or
 * per route. Measured on Brown's feed, 20 pairs sit within 25m of each other:
 * "Barbour Hall/Public Safety CW" and "...CCW" are 11m apart and carry one
 * route each. Joined on stop_id those read as two separate single-route stops,
 * which is why a map coloured by stop_id shows two small dots of different
 * colours where there is really one interchange.
 *
 * Grouping is for DISPLAY only. The member ids are kept, because the two halves
 * are genuinely different boarding points and departures must still key on the
 * one the rider is standing at.
 *
 * Stops served by no running route are dropped: Brown's GTFS ships 70 stops and
 * only 33 sit on a route that has trips, so the rest are dots no bus will ever
 * call at.
 */
export function stations(
  feed: StaticFeed, active: Set<string>, radiusM = STATION_M,
): Station[] {
  const serving = stopRoutes(feed);
  const live = [...feed.stops.values()]
    .map((s) => ({ s, routes: (serving.get(s.id) ?? []).filter((r) => active.has(r)) }))
    .filter((x) => x.routes.length > 0)
    // Sorted so grouping is deterministic whatever order the feed lists them.
    .sort((a, b) => a.s.id.localeCompare(b.s.id));

  const M_PER_DEG_LAT = 111_320;
  const metres = (a: typeof live[number], b: typeof live[number]) =>
    Math.hypot(
      (b.s.lng - a.s.lng) * M_PER_DEG_LAT * Math.cos((a.s.lat * Math.PI) / 180),
      (b.s.lat - a.s.lat) * M_PER_DEG_LAT);

  const taken = new Set<string>();
  const out: Station[] = [];
  for (const seed of live) {
    if (taken.has(seed.s.id)) continue;
    const group = live.filter((x) => !taken.has(x.s.id) && metres(seed, x) <= radiusM);
    for (const g of group) taken.add(g.s.id);
    const routes = new Set<string>();
    for (const g of group) for (const r of g.routes) routes.add(r);
    out.push({
      stopIds: group.map((g) => g.s.id).sort(),
      // The plainest name in the group. A direction suffix is meaningless once
      // the halves are drawn as one marker, and the shortest name is reliably
      // the one without it.
      name: group.map((g) => g.s.name).sort((a, b) => a.length - b.length)[0]!,
      lat: group.reduce((t, g) => t + g.s.lat, 0) / group.length,
      lng: group.reduce((t, g) => t + g.s.lng, 0) / group.length,
      routeIds: [...routes].sort(),
    });
  }
  return out;
}

/** Which routes call at each stop.
 *
 *  Subway maps colour a stop by its line and draw interchanges neutrally, so
 *  the map needs to know which stops serve more than one route. Built from the
 *  trips because GTFS has no stop-to-route table. */
export function stopRoutes(feed: StaticFeed): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  for (const trip of feed.trips.values())
    for (const ts of trip.stops) {
      const set = sets.get(ts.stopId) ?? new Set<string>();
      set.add(trip.routeId);
      sets.set(ts.stopId, set);
    }
  return new Map([...sets].map(([id, set]) => [id, [...set].sort()]));
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

/**
 * Which stop in the list a vehicle is heading for.
 *
 * Apple Maps draws the bus itself into the stop list, between the stop it has
 * left and the one it is approaching, and dims the stops behind it. That needs
 * the vehicle placed in the SAME order the list is in, which a straight-line
 * distance to each stop cannot do -- on a loop, the nearest stop to a bus is
 * often the one it passed a minute ago.
 *
 * Measured along the shape instead, so it is the route's own order that
 * decides, and a bus a few metres to one side of its line is unaffected.
 * Compared modulo the shape's length, because every Brown route is a loop and
 * the last stop's successor is the first one.
 */
export function nextStopIndex(
  shape: LatLng[], stops: { lat: number; lng: number }[], at: { lat: number; lng: number },
): number | null {
  if (shape.length < 2 || stops.length === 0) return null;
  const total = shapeLength(shape);
  if (total === 0) return null;
  const here = distanceAlongShape(shape, at);
  let best = 0, bestAhead = Infinity;
  for (let i = 0; i < stops.length; i++) {
    // How far the bus still has to travel to reach this stop, going forwards.
    const ahead = ((distanceAlongShape(shape, stops[i]!) - here) % total + total) % total;
    if (ahead < bestAhead) { bestAhead = ahead; best = i; }
  }
  return best;
}

/** The typical gap between departures, whole minutes.
 *
 *  The median, not the mean and not the first gap: buses bunch, and one pair
 *  two minutes apart would otherwise advertise a route as "every 2 min" when
 *  the rider who misses them waits twenty. */
export function headwayMinutes(times: number[]): number | null {
  if (times.length < 2) return null;
  const t = [...times].sort((a, b) => a - b);
  const gaps = t.slice(1).map((v, i) => v - t[i]!).sort((a, b) => a - b);
  return Math.round(gaps[Math.floor((gaps.length - 1) / 2)]! / 60);
}
