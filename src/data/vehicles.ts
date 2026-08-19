import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { GTFS_VEHICLES_URL, httpGetBytes } from "./passio";

export interface Bus {
  id: string; label: string; routeId: string;
  lat: number; lng: number; bearing: number;
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
    }];
  });
}
