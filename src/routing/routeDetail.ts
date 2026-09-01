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
/**
 * A stop's name with the direction furniture removed.
 *
 * Passio splits one physical stop into a pair per direction and marks which is
 * which in the NAME: "Athletic Center" / "Athletic Center (SB)", "Machado
 * /Rochambeau CW" / "... CCW", "Medical School (to RI Hospital)". The suffix
 * says nothing once both halves are drawn as one marker.
 */
function plainName(n: string): string {
  return n
    .replace(/\s*\((?:to|from)\b[^)]*\)\s*$/i, "")
    .replace(/\s*\((?:NB|SB|EB|WB|CW|CCW)\)\s*$/i, "")
    .replace(/\s+CC?W\s*$/i, "")
    .trim();
}

export function stations(
  feed: StaticFeed, active: Set<string>, radiusM = STATION_M,
): Station[] {
  const serving = stopRoutes(feed);
  // Plus the stops the GTFS export drops. The Daytime Express ships one trip
  // covering two of its nine stops and the Stadium Loop ships none of its
  // four, so drawing from trips alone left dots off routes that plainly call
  // there. This widens the MAP only -- stopRoutes() itself is untouched,
  // because that is what gates the planner's candidate stops and these have no
  // times behind them.
  const extra = new Map<string, string[]>();
  for (const [routeId, stopIds] of feed.routeStops ?? [])
    for (const id of stopIds)
      if (!(serving.get(id) ?? []).includes(routeId))
        extra.set(id, [...(extra.get(id) ?? []), routeId]);

  const live = [...feed.stops.values()]
    .map((s) => ({ s, routes: [...new Set([...(serving.get(s.id) ?? []), ...(extra.get(s.id) ?? [])])]
                     .sort().filter((r) => active.has(r)) }))
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
      // EVERY distinct name in the group, joined -- never just one of them.
      //
      // This used to keep the SHORTEST name, on the reasoning that a direction
      // suffix makes a name longer so the short one is the plain one. That is
      // string length standing in for meaning, and it is only right when the
      // names denote the same place. Where they do not it silently deletes a
      // stop's identity: "Pembroke Campus" (15 chars) and "Cushing & Thayer"
      // (16) are two stops 11m apart, and the junction was labelled "Pembroke
      // Campus" with Cushing & Thayer gone from the app entirely.
      //
      // Two names that survive a merge are both true, so both are shown.
      name: [...new Set(group.map((g) => plainName(g.s.name)))].sort().join(" / "),
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

  // Where the export kept fewer stops than the route has, take the fuller
  // list. The Stadium Loop ships no trips at all, and the Daytime Express
  // ships one trip covering two of its nine calls -- so this page came up
  // blank for one route and two-thirds short for the other, next to a map
  // already drawing every stop. Whichever list is longer is the one that
  // describes the line.
  //
  // Only the ORDER comes from here. There are no times behind it, so each
  // row's next departure still comes from the live board, and a route with
  // nothing reporting honestly shows nothing.
  const served = feed.routeStops?.get(routeId) ?? [];
  if (served.length > longest.length)
    longest = served.map((stopId, i) => ({ stopId, seq: i + 1 }));

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

  // The vehicle that covers the most of this list, not the one that happens to
  // reach the first stop soonest. A bus just entering service may report at a
  // single stop; anchoring on the first stop would follow it and blank every
  // other row.
  const coverage = new Map<string, { count: number; first: number }>();
  for (const { stopId } of ordered)
    for (const d of upcoming(stopId)) {
      const c = coverage.get(d.tripId) ?? { count: 0, first: Infinity };
      c.count++;
      c.first = Math.min(c.first, d.time);
      coverage.set(d.tripId, c);
    }
  let chosen: string | undefined;
  let best = { count: -1, first: Infinity };
  for (const [tripId, c] of coverage)
    if (c.count > best.count || (c.count === best.count && c.first < best.first)) {
      chosen = tripId;
      best = c;
    }

  // No falling back to another vehicle for a stop this one does not report.
  // That fallback was the sawtooth coming back in through the side door: it is
  // right for the row and sends the column backwards, which is exactly what a
  // rider reads as broken. A gap is honest and stays a gap.
  const rows = ordered.map(({ stop, seq, stopId }) => ({
    stop, seq,
    next: (chosen ? upcoming(stopId).find((d) => d.tripId === chosen) : undefined) ?? null,
  }));

  // Every Brown route is a loop, so the chosen run starts wherever the bus
  // currently is and wraps round to the stops behind it -- which belong to the
  // next lap and are therefore LATER, not earlier. Listed in raw route order
  // that reads 3:38, 3:54, 4:18, 3:42. Rotating the list to begin at the
  // vehicle's next stop is what makes the column climb.
  let start = -1;
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i]!.next?.time;
    if (t === undefined) continue;
    if (start < 0 || t < rows[start]!.next!.time) start = i;
  }
  return start > 0 ? [...rows.slice(start), ...rows.slice(0, start)] : rows;
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
