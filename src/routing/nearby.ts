import { haversineMeters } from "./walk";
import type { StaticFeed, DepartureBoard, Departure, Stop, LatLng } from "../data/types";

/** Two departures on one route closer together than this are the same bus. */
const SAME_BUS_SECONDS = 90;

export interface StopDepartures {
  stop: Stop;
  meters: number;         // straight-line, for a rough "x min walk" label
  departures: Departure[]; // upcoming only, soonest first
}

/** Stops near a point with their next departures, closest stop first.
 *
 *  Answers the single most common question a rider has -- "what leaves from
 *  near me, and when" -- without needing a destination. Pure, so the sheet can
 *  be tested without a map or a network. */
export function nearbyDepartures(
  feed: StaticFeed,
  board: DepartureBoard,
  origin: LatLng,
  now: number,
  maxStops: number,
  perStop = 3,
): StopDepartures[] {
  const out: StopDepartures[] = [];
  for (const stop of feed.stops.values()) {
    // Collapse near-simultaneous departures on the same route. GTFS carries
    // separate trip ids whose times at a given stop fall seconds apart; a
    // rider sees one bus, so listing "Evening CW, 3 min" twice reads as a bug.
    // Bucketing by clock minute is not enough -- two entries 20s apart can
    // straddle a minute boundary -- so collapse by proximity instead.
    const kept: Departure[] = [];
    for (const d of (board.get(stop.id) ?? []).filter((x) => x.time >= now).sort((a, b) => a.time - b.time)) {
      const dupIdx = kept.findIndex(
        (k) => k.routeId === d.routeId && Math.abs(k.time - d.time) < SAME_BUS_SECONDS);
      if (dupIdx === -1) { kept.push(d); continue; }
      // Prefer the live entry: a real prediction beats a timetable guess.
      if (d.live && !kept[dupIdx]!.live) kept[dupIdx] = d;
    }
    const upcoming = kept.slice(0, perStop);
    if (upcoming.length === 0) continue;   // an empty stop row is noise, not information
    out.push({ stop, meters: haversineMeters(origin, stop), departures: upcoming });
  }
  return out.sort((a, b) => a.meters - b.meters).slice(0, maxStops);
}
