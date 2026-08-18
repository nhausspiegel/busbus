export const SYSTEM_ID = "1067";     // Brown University
export const SYSTEM_SLUG = "brown";  // `username` from getSystems; builds GTFS URLs

export const GTFS_BASE = `https://passio3.com/${SYSTEM_SLUG}/passioTransit/gtfs`;
export const GTFS_STATIC_URL = `${GTFS_BASE}/google_transit.zip`;
export const GTFS_TRIP_UPDATES_URL = `${GTFS_BASE}/realtime/tripUpdates`;
export const GTFS_VEHICLES_URL = `${GTFS_BASE}/realtime/vehiclePositions`;
export const GTFS_ALERTS_URL = `${GTFS_BASE}/realtime/serviceAlerts`;

export const USER_AGENT = "busbus/0.1 (github.com/busbus/busbus)";

export async function httpGetBytes(url: string): Promise<Uint8Array> {
  // Browsers forbid setting User-Agent; it applies when running under Node
  // (tests, scripts). Harmless either way.
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
