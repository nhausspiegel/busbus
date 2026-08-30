import { unzipSync, strFromU8 } from "fflate";
import { GTFS_STATIC_URL, httpGetBytes, IS_NODE } from "./passio";
import { fetchRoutePathPayload, parseRoutePaths, fillMissingShapes,
         parseRouteStops, withRouteStops, parseActiveRoutes } from "./routePaths";
import { parseSnapped, withSnappedShapes } from "./snappedShapes";
import type { StaticFeed, Route, Stop, Trip, TripStop, LatLng } from "./types";

/** GTFS times are "HH:MM:SS" and MAY exceed 24h for post-midnight service.
 *  Returns seconds after service-day midnight, or null for blank entries. */
export function gtfsTimeToSeconds(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const p = t.split(":");
  if (p.length !== 3) return null;
  const [h, m, s] = p.map(Number);
  if (![h, m, s].every((n) => Number.isFinite(n))) return null;
  return h! * 3600 + m! * 60 + s!;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const split = (line: string): string[] => {
    // GTFS quotes any field containing a comma (stop names do this).
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const header = split(lines[0]!).map((h) => h.replace(/^﻿/, "").trim());
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

export function parseStaticFeed(zipBytes: Uint8Array): StaticFeed {
  const files = unzipSync(zipBytes);
  const table = (name: string): Record<string, string>[] =>
    files[name] ? parseCsv(strFromU8(files[name]!)) : [];

  // shapes.txt -> one ordered polyline per shape_id
  const shapes = new Map<string, { seq: number; p: LatLng }[]>();
  for (const r of table("shapes.txt")) {
    const id = r["shape_id"]!;
    if (!shapes.has(id)) shapes.set(id, []);
    shapes.get(id)!.push({
      seq: Number(r["shape_pt_sequence"]),
      p: { lat: Number(r["shape_pt_lat"]), lng: Number(r["shape_pt_lon"]) },
    });
  }
  const shapeOf = (id: string): LatLng[] =>
    (shapes.get(id) ?? []).sort((a, b) => a.seq - b.seq).map((x) => x.p);

  const routeRows = table("routes.txt");

  const stops = new Map<string, Stop>();
  for (const r of table("stops.txt")) {
    stops.set(r["stop_id"]!, {
      id: r["stop_id"]!,
      name: r["stop_name"] ?? "",
      lat: Number(r["stop_lat"]),
      lng: Number(r["stop_lon"]),
    });
  }

  const tripRoute = new Map<string, string>();
  // GTFS puts shape_id on the TRIP, not the route. Passio currently sets
  // shape_id == route_id, so joining shapes by route id happens to work -- but
  // the day any route gets per-direction shapes (62487_0 / 62487_1) that route
  // would silently draw nothing. Resolve it properly via trips.
  const routeShape = new Map<string, string>();
  for (const r of table("trips.txt")) {
    tripRoute.set(r["trip_id"]!, r["route_id"]!);
    const shapeId = r["shape_id"];
    if (shapeId && !routeShape.has(r["route_id"]!)) routeShape.set(r["route_id"]!, shapeId);
  }

  const tripStops = new Map<string, TripStop[]>();
  for (const r of table("stop_times.txt")) {
    const time = gtfsTimeToSeconds(r["departure_time"] ?? "");
    if (time === null) continue;  // blank at non-timepoint stops; skip, never default
    const id = r["trip_id"]!;
    if (!tripStops.has(id)) tripStops.set(id, []);
    tripStops.get(id)!.push({ stopId: r["stop_id"]!, seq: Number(r["stop_sequence"]), time });
  }

  const routes = new Map<string, Route>();
  for (const r of routeRows) {
    const id = r["route_id"]!;
    routes.set(id, {
      id,
      name: r["route_long_name"] ?? "",
      shortName: r["route_short_name"] ?? "",
      // GTFS ships bare hex with no leading '#'.
      color: "#" + (r["route_color"] || "888888"),
      // Prefer the shape its trips actually reference; fall back to the
      // route id for feeds that omit shape_id entirely.
      shape: shapeOf(routeShape.get(id) ?? id),
    });
  }

  const trips = new Map<string, Trip>();
  for (const [id, ts] of tripStops) {
    trips.set(id, {
      id,
      routeId: tripRoute.get(id) ?? "",
      stops: ts.sort((a, b) => a.seq - b.seq),
    });
  }

  const info = table("feed_info.txt")[0];
  return { routes, stops, trips, feedEndDate: info?.["feed_end_date"] ?? "" };
}

export async function fetchStaticFeed(): Promise<StaticFeed> {
  const feed = parseStaticFeed(await httpGetBytes(GTFS_STATIC_URL));
  // One live route -- 22427, Brown Stadium Loop -- is in routes.txt with no
  // trips and no shape, so the GTFS alone cannot draw it and the app left it
  // off a map that Passio's own app shows it on. Filled in from the private
  // endpoint, which is the same geometry the shapes come from, and only for
  // routes the GTFS leaves empty. A failure here costs that one route its
  // line, which is what happens today anyway.
  try {
    const payload = await fetchRoutePathPayload();
    fillMissingShapes(feed, parseRoutePaths(payload));
    withRouteStops(feed, parseRouteStops(payload));
    const active = parseActiveRoutes(payload);
    if (active.size) feed.activeRouteIds = active;
  } catch { /* GTFS-shaped routes are unaffected */ }

  // Then put every route on the centreline of the road it actually drives.
  // Built at build time by scripts/snap-to-streets.ts; a failure here leaves
  // the traced shapes, which is where the app was before.
  if (!IS_NODE) {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}gtfs/shapes-snapped.json`);
      if (res.ok) withSnappedShapes(feed, parseSnapped(await res.json()));
    } catch { /* traced shapes still describe the route */ }
  }
  return feed;
}
