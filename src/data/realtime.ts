import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { GTFS_TRIP_UPDATES_URL, httpGetBytes } from "./passio";
import type { Departure } from "./types";

/** Decode GTFS-RT TripUpdates into flat Departures.
 *
 *  Passio's predictions reach only ~18 minutes ahead and cover only trips
 *  currently running, so this is never the complete picture on its own --
 *  departures.ts merges it with the timetable. */
export function parseTripUpdates(bytes: Uint8Array): Departure[] {
  if (bytes.length === 0) return [];
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
  const out: Departure[] = [];
  for (const entity of feed.entity) {
    const tu = entity.tripUpdate;
    if (!tu?.trip) continue;
    const tripId = tu.trip.tripId ?? "";
    const routeId = tu.trip.routeId ?? "";
    for (const stu of tu.stopTimeUpdate ?? []) {
      // Prefer departure; fall back to arrival (Passio often sets only one).
      const t = stu.departure?.time ?? stu.arrival?.time;
      if (t === null || t === undefined) continue;
      out.push({
        stopId: stu.stopId ?? "",
        tripId,
        routeId,
        seq: stu.stopSequence ?? 0,
        time: Number(t),        // protobuf int64 arrives as Long|number
        live: true,
      });
    }
  }
  return out;
}

export async function fetchLiveDepartures(): Promise<Departure[]> {
  return parseTripUpdates(await httpGetBytes(GTFS_TRIP_UPDATES_URL));
}
