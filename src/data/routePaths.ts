import { IS_NODE, PRIVATE_BASE, SYSTEM_ID, USER_AGENT } from "./passio";
import type { LatLng, StaticFeed } from "./types";

/**
 * Route geometry for the routes the GTFS export forgets.
 *
 * The rule in this project is GTFS first, and this does not change it: it
 * speaks only where the GTFS is silent. It has to, because the silence is
 * total for one live route. Measured 2026-08-29: routes.txt carries 22427
 * "Brown Stadium Loop", trips.txt has no trips for it at all, and shapes.txt
 * holds four shape_ids -- 62487, 3302, 3470, 3469. The export ships the
 * route's name and colour and nothing that can be drawn, so the app left a
 * route off the map that Passio's own app puts on it.
 *
 * This is the same geometry, not a rival claim about it: in the same payload
 * the point counts match shapes.txt exactly for every route that has both --
 * 3302:177, 3469:24, 3470:31 -- and the Stadium Loop's three stops are already
 * in stops.txt.
 */
export async function fetchRoutePaths(): Promise<Map<string, LatLng[]>> {
  const res = await fetch(`${PRIVATE_BASE}/mapGetData.php?getStops=2`, {
    // User-Agent only under Node: in a browser it is a forbidden header, and
    // asking for it turns this into a preflight passiogo.com does not answer.
    method: "POST",
    headers: { "Content-Type": "application/json", ...(IS_NODE ? { "User-Agent": USER_AGENT } : {}) },
    body: JSON.stringify({ s0: SYSTEM_ID, sA: 1 }),
  });
  if (!res.ok) throw new Error(`getStops -> HTTP ${res.status}`);
  return parseRoutePaths(await res.json());
}

/** Pull the polylines out of Passio's getStops payload.
 *
 *  `routePoints` is `{"<routeId>": [[{lat, lng}, ...], ...]}` -- an array of
 *  segments per route, with the numbers arriving as strings. Joined in the
 *  order given, which is the order the bus drives them. */
export function parseRoutePaths(payload: unknown): Map<string, LatLng[]> {
  const out = new Map<string, LatLng[]>();
  const points = (payload as { routePoints?: Record<string, unknown> })?.routePoints;
  if (!points || typeof points !== "object") return out;

  for (const [routeId, segments] of Object.entries(points)) {
    if (!Array.isArray(segments)) continue;
    const path: LatLng[] = [];
    for (const segment of segments) {
      if (!Array.isArray(segment)) continue;
      for (const p of segment) {
        const lat = Number((p as { lat?: unknown })?.lat);
        const lng = Number((p as { lng?: unknown })?.lng);
        // A point that will not parse is dropped, not defaulted to zero --
        // one (0, 0) drags the whole line into the Atlantic.
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        path.push({ lat, lng });
      }
    }
    if (path.length >= 2) out.set(routeId, path);
  }
  return out;
}

/** Draw the routes GTFS left empty, and only those.
 *
 *  GTFS stays the source of record for every route that has a shape: letting
 *  the private feed overwrite one would put its drift into lines that are
 *  already correct, and into the tests that pin them. */
export function fillMissingShapes(feed: StaticFeed, paths: Map<string, LatLng[]>): StaticFeed {
  for (const route of feed.routes.values()) {
    if (route.shape.length >= 2) continue;
    const path = paths.get(route.id);
    if (path) route.shape = path;
  }
  return feed;
}
