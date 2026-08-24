import type { LatLng, Stop } from "../data/types";

const VALHALLA = "https://valhalla1.openstreetmap.de";

/**
 * Every Valhalla call goes through here: cached, de-duplicated, and backed off.
 *
 * valhalla1.openstreetmap.de is volunteer-run and throttles. A throttled
 * response arrives WITHOUT CORS headers, so the browser cannot read its status
 * and it surfaces as `TypeError: Failed to fetch` in about 100ms -- measured on
 * 2026-08-24, on the very first request of a pin drop. It looks like an outage
 * and is not one, which is why the old code kept retrying straight into it.
 *
 * Three things stop that:
 *
 * - **Cache.** The walk between two fixed points does not change, so the same
 *   question is never asked twice. Keyed on the request body, which already
 *   holds the coordinates.
 * - **De-duplication.** The promise is cached, not the result, so N callers
 *   asking at once make one request.
 * - **Cooldown.** After a failure nothing is sent for a spell that doubles per
 *   consecutive failure, with jitter. Retrying instantly is what turns being
 *   throttled into staying throttled.
 */
const cache = new Map<string, Promise<unknown>>();
/** Bounded so a long session cannot grow it without limit. */
const MAX_CACHE = 200;
let coolUntil = 0;
let backoffMs = 0;
const FIRST_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

/** How long until Valhalla will be asked again, ms. 0 when it is ready. */
export function valhallaCooldownMs(now = Date.now()): number {
  return Math.max(0, coolUntil - now);
}

/** Test seam: forget every cached answer and clear any cooldown. */
export function resetValhalla(): void {
  cache.clear();
  coolUntil = 0;
  backoffMs = 0;
}

async function post(path: string, body: unknown): Promise<unknown> {
  const key = `${path}|${JSON.stringify(body)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const waiting = valhallaCooldownMs();
  if (waiting > 0)
    throw new Error(`valhalla is being rested for another ${waiting}ms`);

  const p = (async () => {
    const res = await fetch(`${VALHALLA}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`valhalla ${path} -> HTTP ${res.status}`);
    return res.json();
  })();

  cache.set(key, p);
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  p.then(() => { backoffMs = 0; })
    .catch(() => {
      // A failure must never be cached: the next attempt has to be free to
      // succeed once the server is willing again.
      cache.delete(key);
      backoffMs = backoffMs ? Math.min(backoffMs * 2, MAX_BACKOFF_MS) : FIRST_BACKOFF_MS;
      coolUntil = Date.now() + backoffMs + Math.floor(Math.random() * 500);
    });
  return p;
}

/** Great-circle distance in metres. Used ONLY to pre-select candidate stops
 *  before asking Valhalla for real walking times -- never as a walking
 *  estimate itself. College Hill is steep enough that straight-line distance
 *  badly misreports uphill walking time. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** The k nearest stops by straight-line distance, closest first.
 *  51 of 70 stops fall within a 10-minute walk of central campus, so asking
 *  Valhalla about all of them would be wasteful; k=8 covers every realistic
 *  boarding choice. */
export function nearestStops(from: LatLng, stops: Stop[], k: number): Stop[] {
  return [...stops]
    .map((s) => ({ s, d: haversineMeters(from, s) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, k)
    .map((x) => x.s);
}

/** Walking seconds for every source/target pair, in a single request.
 *
 *  Valhalla here is FOSSGIS's community instance. Firing three parallel
 *  requests per search got them throttled, and a throttled response carries no
 *  CORS headers, so the browser reports it as a CORS failure rather than a rate
 *  limit -- which is a genuinely confusing way to learn you are being rude.
 *  One request answers the whole search. */
export async function walkMatrixMulti(
  sources: LatLng[], targets: LatLng[],
): Promise<(number | null)[][]> {
  if (sources.length === 0 || targets.length === 0) return [];
  const data = await post("/sources_to_targets", {
    sources: sources.map((p) => ({ lat: p.lat, lon: p.lng })),
    targets: targets.map((p) => ({ lat: p.lat, lon: p.lng })),
    costing: "pedestrian",
  }) as { sources_to_targets?: { time?: number }[][] };
  const rows = data?.sources_to_targets ?? [];
  return sources.map((_, i) =>
    targets.map((__, j) => {
      const t = rows[i]?.[j]?.time;
      return typeof t === "number" ? t : null;
    }));
}

/** Real pedestrian walking seconds from one point to many stops, in ONE call.
 *
 *  Valhalla is used rather than OSRM's public demo: that server has no foot
 *  profile loaded and silently answers pedestrian queries with car routing
 *  (2.1km in 176s = 42km/h) while still returning code "Ok". */
export async function walkMatrix(from: LatLng, to: Stop[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (to.length === 0) return out;
  const data = await post("/sources_to_targets", {
    sources: [{ lat: from.lat, lon: from.lng }],
    targets: to.map((s) => ({ lat: s.lat, lon: s.lng })),
    costing: "pedestrian",
  }) as { sources_to_targets?: { time?: number }[][] };
  const row = data?.sources_to_targets?.[0] ?? [];
  row.forEach((cell: { time?: number }, i: number) => {
    const stop = to[i];
    if (stop && typeof cell?.time === "number") out.set(stop.id, cell.time);
  });
  return out;
}

/** Walking seconds between two points. Used to decide whether the rider
 *  should simply walk instead of waiting for a shuttle. */
export async function walkSeconds(from: LatLng, to: LatLng): Promise<number | null> {
  const data = await post("/sources_to_targets", {
    sources: [{ lat: from.lat, lon: from.lng }],
    targets: [{ lat: to.lat, lon: to.lng }],
    costing: "pedestrian",
  }).catch(() => null) as { sources_to_targets?: { time?: number }[][] } | null;
  const t = data?.sources_to_targets?.[0]?.[0]?.time;
  return typeof t === "number" ? t : null;
}

/** One turn of a walking leg, as Valhalla words it. */
export interface WalkStep { instruction: string; metres: number; seconds: number }

/** Pull the drawable line AND the turn-by-turn out of one /route response.
 *
 *  Split out from the fetch so it can be tested against a frozen response:
 *  Valhalla is volunteer-run and tests never call it. */
export function parseWalkRoute(data: unknown): { path: LatLng[]; steps: WalkStep[] } {
  const leg = (data as { trip?: { legs?: { shape?: string;
    maneuvers?: { instruction?: string; length?: number; time?: number }[] }[] } })
    ?.trip?.legs?.[0];
  return {
    path: leg?.shape ? decodePolyline6(leg.shape) : [],
    // `length` is kilometres -- the response says so in trip.units. Passing it
    // through as metres would tell a rider to walk eight millimetres.
    steps: (leg?.maneuvers ?? []).map((mv) => ({
      instruction: mv.instruction ?? "",
      metres: (mv.length ?? 0) * 1000,
      seconds: mv.time ?? 0,
    })),
  };
}

/** One walking leg: the sidewalk-following polyline the map draws AND the
 *  turn-by-turn the detail view discloses. Both come out of this one response
 *  -- Valhalla is volunteer-run, so asking twice for the same walk is rude. */
export async function walkRoute(from: LatLng, to: LatLng): Promise<{ path: LatLng[]; steps: WalkStep[] }> {
  return parseWalkRoute(await post("/route", {
    locations: [
      { lat: from.lat, lon: from.lng },
      { lat: to.lat, lon: to.lng },
    ],
    costing: "pedestrian",
  }));
}

/** Valhalla encodes shapes as Google polyline at precision 6, not the
 *  usual 5. Decoding at precision 5 puts the path in the wrong hemisphere. */
export function decodePolyline6(str: string): LatLng[] {
  const out: LatLng[] = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    let shift = 0, result = 0, byte: number;
    do { byte = str.charCodeAt(i++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { byte = str.charCodeAt(i++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    out.push({ lat: lat / 1e6, lng: lng / 1e6 });
  }
  return out;
}

/**
 * What to draw for each walking leg, given whichever ones Valhalla routed.
 *
 * Every leg gets a line, always: the routed path when there is one, and
 * otherwise the straight hop marked as the guess it is. Both halves of that
 * matter. Filtering the legs down to the ones that routed, and skipping the
 * redraw when none did, is what left a straight line through the buildings on
 * screen permanently -- a rider already standing at the boarding stop has a
 * leg too short to route, and a leg over water or private land has none at
 * all. Resolving the legs together, rather than one verdict for the pair, is
 * what stops one failure from dragging a perfectly good path down with it.
 */
export function walkLegs(
  legs: { from: LatLng; to: LatLng }[],
  routed: (LatLng[] | null)[],
): { path: LatLng[]; provisional: boolean }[] {
  return legs.map((l, i) => {
    const path = routed[i];
    return path && path.length > 1
      ? { path, provisional: false }
      : { path: [l.from, l.to], provisional: true };
  });
}
