import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { GTFS_ALERTS_URL, httpGetBytes } from "./passio";

export interface Alert {
  routeIds: string[];
  header: string;
  description: string;
  start: number | null;
  end: number | null;
}

/** Decode GTFS-RT ServiceAlerts: detours, stop closures, suspended service. */
export function parseAlerts(bytes: Uint8Array, now: number): Alert[] {
  if (bytes.length === 0) return [];
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
  const out: Alert[] = [];
  for (const e of feed.entity) {
    const a = e.alert;
    if (!a) continue;
    const period = a.activePeriod?.[0];
    const start = period?.start != null ? Number(period.start) : null;
    const end = period?.end != null ? Number(period.end) : null;
    // Skip alerts that have expired or have not begun; showing a closure that
    // ended last week trains riders to ignore the banner.
    if (start !== null && start > now) continue;
    if (end !== null && end < now) continue;
    out.push({
      routeIds: (a.informedEntity ?? []).map((i) => i.routeId ?? "").filter(Boolean),
      header: a.headerText?.translation?.[0]?.text ?? "",
      description: a.descriptionText?.translation?.[0]?.text ?? "",
      start, end,
    });
  }
  return out;
}

export async function fetchAlerts(now: number): Promise<Alert[]> {
  return parseAlerts(await httpGetBytes(GTFS_ALERTS_URL), now);
}
