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
export async function fetchRoutePathPayload(): Promise<unknown> {
  const res = await fetch(`${PRIVATE_BASE}/mapGetData.php?getStops=2`, {
    // User-Agent only under Node: in a browser it is a forbidden header, and
    // asking for it turns this into a preflight passiogo.com does not answer.
    method: "POST",
    headers: { "Content-Type": "application/json", ...(IS_NODE ? { "User-Agent": USER_AGENT } : {}) },
    body: JSON.stringify({ s0: SYSTEM_ID, sA: 1 }),
  });
  if (!res.ok) throw new Error(`getStops -> HTTP ${res.status}`);
  // Returned raw: one request carries both the geometry and the stop lists,
  // and asking twice for the same payload is a second call to someone else's
  // server for nothing.
  return res.json();
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

/** The stop ids a route calls at, in riding order.
 *
 *  `routes` is `{"<routeId>": ["Name", "#colour", ["<seq>", "<stopId>", 0], ...]}`
 *  -- the header entries are strings, every stop is an array. */
export function parseRouteStops(payload: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const routes = (payload as { routes?: Record<string, unknown> })?.routes;
  if (!routes || typeof routes !== "object") return out;

  for (const [routeId, row] of Object.entries(routes)) {
    if (!Array.isArray(row)) continue;
    const ordered = row
      .filter((e): e is unknown[] => Array.isArray(e))
      // Sorted by Passio's own sequence rather than trusting array order,
      // and the id is kept as a string: these join to GTFS stop_id.
      .map((e) => ({ seq: Number(e[0]), stopId: String(e[1] ?? "") }))
      .filter((e) => e.stopId !== "" && Number.isFinite(e.seq))
      .sort((a, b) => a.seq - b.seq)
      .map((e) => e.stopId);
    if (ordered.length) out.set(routeId, ordered);
  }
  return out;
}

/**
 * Record which stops each route serves, for the map to draw.
 *
 * Deliberately NOT fed into stopRoutes(). That function decides which stops
 * may take one of the eight candidate slots when planning a trip, and a stop
 * known only from this list has no trip behind it and so no times to ride on.
 * Letting one compete for a slot is how unservable stops crowded real ones out
 * before -- 6 of the 8 nearest to Barus & Holley were parking lots and
 * monuments, and rides went missing from places that plainly have one.
 *
 * Same reason as the shapes: this fills a hole in the export rather than
 * overruling it. The Connector and both Evening routes already agree with
 * Passio stop for stop; the Daytime Express ships one trip covering two of its
 * nine stops, and the Stadium Loop ships none of its four.
 */
export function withRouteStops(feed: StaticFeed, served: Map<string, string[]>): StaticFeed {
  const known = new Set(feed.stops.keys());
  feed.routeStops = new Map(
    [...served].map(([routeId, ids]) => [routeId, ids.filter((id) => known.has(id))]));
  return feed;
}

/**
 * Which routes are running at all, per Passio's own exclusion list.
 *
 * The app carried a hardcoded set of five route ids, which is a list that goes
 * stale silently: when Brown turns the Commencement routes on, a hardcoded set
 * keeps them off the map and nothing says why. The same payload the shapes
 * come from answers it -- `routes` lists all eight and `excludedRoutesID`
 * names the ones not running.
 *
 * Measured 2026-08-29 the exclusions were [-1, 72922, 72923, 72924] -- both
 * Commencement routes and Bruno's Block Party -- leaving exactly the five that
 * had been written down by hand.
 *
 * An empty set means "could not tell", not "nothing is running": the caller
 * keeps its own fallback, because blanking the map is the worse failure.
 */
export function parseActiveRoutes(payload: unknown): Set<string> {
  const p = payload as { routes?: Record<string, unknown>; excludedRoutesID?: unknown[] };
  const all = Object.keys(p?.routes ?? {});
  const excluded = new Set((Array.isArray(p?.excludedRoutesID) ? p.excludedRoutesID : []).map(String));
  return new Set(all.filter((id) => !excluded.has(id)));
}
