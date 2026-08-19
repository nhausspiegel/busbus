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
    // Consider EVERY period, not just the first. A weekend suspension is
    // published as two windows; judging it on period[0] alone hides a live
    // closure on the Sunday because Saturday's window has ended.
    const periods = a.activePeriod ?? [];
    const active = periods.length === 0 || periods.some((p) => {
      const s = p.start != null ? Number(p.start) : null;
      const e = p.end != null ? Number(p.end) : null;
      return (s === null || s <= now) && (e === null || e >= now);
    });
    // No stated period means an ongoing alert; treating that as inactive would
    // hide a live service change.
    if (!active) continue;
    const first = periods[0];
    const start = first?.start != null ? Number(first.start) : null;
    const end = first?.end != null ? Number(first.end) : null;
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
