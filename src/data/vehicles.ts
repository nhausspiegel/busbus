import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { GTFS_VEHICLES_URL, httpGetBytes } from "./passio";

export interface Bus {
  id: string; label: string; routeId: string;
  lat: number; lng: number; bearing: number;
  /** GTFS-RT occupancy enum name, or null when the bus does not report it.
   *  Kept as the fallback when Passio's exact counts are unreachable. */
  occupancy: string | null;
  /** Exact counts from Passio's private feed, when available. */
  paxLoad?: number;
  totalCap?: number;
}

/** Plain-English occupancy. GTFS-RT's enum names are not rider-facing text. */
export function occupancyLabel(o: string | null): string | null {
  switch (o) {
    case "EMPTY":
    case "MANY_SEATS_AVAILABLE": return "Seats available";
    case "FEW_SEATS_AVAILABLE": return "Filling up";
    case "STANDING_ROOM_ONLY": return "Standing room";
    case "CRUSHED_STANDING_ROOM_ONLY":
    case "FULL": return "Very full";
    case "NOT_ACCEPTING_PASSENGERS": return "Not boarding";
    default: return null;
  }
}

/** Live vehicle positions. Returns [] when nothing is running, which is a
 *  normal state overnight and between seasons -- not an error. */
export async function fetchVehicles(): Promise<Bus[]> {
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
    await httpGetBytes(GTFS_VEHICLES_URL));
  return feed.entity.flatMap((e) => {
    const v = e.vehicle;
    if (!v?.position) return [];
    return [{
      id: v.vehicle?.id ?? "",
      label: v.vehicle?.label ?? "?",
      routeId: v.trip?.routeId ?? "",
      lat: v.position.latitude, lng: v.position.longitude,
      bearing: v.position.bearing ?? 0,
      occupancy: v.occupancyStatus != null
        ? (GtfsRealtimeBindings.transit_realtime.VehiclePosition.OccupancyStatus[v.occupancyStatus] ?? null)
        : null,
    }];
  });
}
