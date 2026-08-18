export const SYSTEM_ID = "1067";     // Brown University
export const SYSTEM_SLUG = "brown";  // `username` from getSystems; builds GTFS URLs

export const GTFS_BASE = `https://passio3.com/${SYSTEM_SLUG}/passioTransit/gtfs`;
/** Whether we are running outside a browser (scripts, tests). */
export const IS_NODE = typeof window === "undefined";

/** The static zip is the one feed that sends NO CORS header, so a browser has
 *  to reach it through a proxy. Node talks to Passio directly. */
export const GTFS_STATIC_URL = IS_NODE
  ? `${GTFS_BASE}/google_transit.zip`
  : "/passio-gtfs/google_transit.zip";
export const GTFS_TRIP_UPDATES_URL = `${GTFS_BASE}/realtime/tripUpdates`;
export const GTFS_VEHICLES_URL = `${GTFS_BASE}/realtime/vehiclePositions`;
export const GTFS_ALERTS_URL = `${GTFS_BASE}/realtime/serviceAlerts`;

export const USER_AGENT = "busbus/0.1 (github.com/busbus/busbus)";

export async function httpGetBytes(url: string): Promise<Uint8Array> {
  // Set User-Agent ONLY under Node (scripts, tests). In a browser it is a
  // forbidden header, and merely asking for it turns this into a non-simple
  // cross-origin request -- which triggers a CORS preflight that passio3.com
  // does not answer, so the fetch fails outright. Politeness where it works,
  // silence where it breaks things.
  const res = await fetch(url, IS_NODE ? { headers: { "User-Agent": USER_AGENT } } : {});
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
