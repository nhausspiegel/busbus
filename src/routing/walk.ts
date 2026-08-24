import type { LatLng, Stop } from "../data/types";

/**
 * Two independent pedestrian routers, tried in order.
 *
 * This app exists to answer "how do I get there", so that answer cannot rest
 * on a single volunteer instance. On 2026-08-24 valhalla1.openstreetmap.de
 * accepted connections and then never replied -- HTTP 000 after 20s, on both
 * endpoints, measured from outside the browser -- and directions stopped
 * working entirely. It had been the only source for six days.
 *
 * FOSSGIS also runs an OSRM with a real foot profile, on a different host.
 * Measured the same afternoon: 200 in 0.66s, 1105m in 884s, which is 4.5 km/h
 * and therefore genuinely walking. That check matters: the OSRM demo server at
 * router.project-osrm.org answers pedestrian queries with CAR routing (2.1km
 * in 176s = 42 km/h) while still returning code "Ok", so a 200 is not by
 * itself evidence of a foot profile.
 *
 * NOTE the URL says `driving`. OSRM keeps the profile slot in the path
 * whatever the graph was built with, and routed-foot's graph is pedestrian.
 */
const OSRM_FOOT = "https://routing.openstreetmap.de/routed-foot";
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
const FIRST_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
/** How long to wait for a router before giving up on a request entirely. */
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Cooldown state is PER HOST.
 *
 * It used to be one pair of module variables shared by every request, which
 * quietly destroyed the whole point of having two routers: Valhalla is down,
 * so every fallback attempt failed, and each failure put the HEALTHY OSRM into
 * a rest of up to a minute. One dead provider poisoned the working one, and
 * the legs that could not be routed in the meantime are exactly the ghost
 * lines that kept appearing. A router is rested on its own record or not at
 * all.
 */
const rest = new Map<string, { until: number; backoff: number }>();

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/** How long until this router will be asked again, ms. 0 when it is ready. */
export function cooldownMs(url: string, now = Date.now()): number {
  return Math.max(0, (rest.get(hostOf(url))?.until ?? 0) - now);
}

/** Test seam: forget every cached answer and clear every cooldown. */
export function resetValhalla(): void {
  cache.clear();
  rest.clear();
}

async function ask(url: string, body?: unknown): Promise<unknown> {
  const key = body === undefined ? url : `${url}|${JSON.stringify(body)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const waiting = cooldownMs(url);
  if (waiting > 0)
    throw new Error(`${hostOf(url)} is being rested for another ${waiting}ms`);

  const p = (async () => {
    // A hung request is the worse failure mode. Measured 2026-08-24: a direct
    // sources_to_targets call sat open past 30 SECONDS without resolving or
    // rejecting -- the server accepts the connection under load and then never
    // answers. With no deadline the app waits on it forever, which is exactly
    // the "Finding shuttles..." that never finishes. Backing off cannot help a
    // request that never comes back; only abandoning it can.
    const ctl = new AbortController();
    const bell = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        ...(body === undefined ? {} : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(bell);
    }
  })();

  cache.set(key, p);
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const host = hostOf(url);
  p.then(() => { rest.delete(host); })
    .catch(() => {
      // A failure must never be cached: the next attempt has to be free to
      // succeed once the server is willing again.
      cache.delete(key);
      const prev = rest.get(host)?.backoff ?? 0;
      const backoff = prev ? Math.min(prev * 2, MAX_BACKOFF_MS) : FIRST_BACKOFF_MS;
      rest.set(host, { backoff, until: Date.now() + backoff + Math.floor(Math.random() * 500) });
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
  const pts = [...sources, ...targets];
  const coords = pts.map((p) => `${p.lng},${p.lat}`).join(";");
  const srcIdx = sources.map((_, i) => i).join(";");
  const dstIdx = targets.map((_, i) => sources.length + i).join(";");
  try {
    const data = await ask(
      `${OSRM_FOOT}/table/v1/driving/${coords}?sources=${srcIdx}&destinations=${dstIdx}`,
    ) as { durations?: (number | null)[][] };
    const rows = data?.durations ?? [];
    estimated = false;
    return sources.map((_, i) =>
      targets.map((__, j) => {
        const t = rows[i]?.[j];
        return typeof t === "number" ? t : null;
      }));
  } catch {
    // Fall through to the other router rather than giving up on the question.
  }
  try {
    const data = await ask(`${VALHALLA}/sources_to_targets`, {
      sources: sources.map((p) => ({ lat: p.lat, lon: p.lng })),
      targets: targets.map((p) => ({ lat: p.lat, lon: p.lng })),
      costing: "pedestrian",
    }) as { sources_to_targets?: { time?: number }[][] };
    const rows = data?.sources_to_targets ?? [];
    estimated = false;
    return sources.map((_, i) =>
      targets.map((__, j) => {
        const t = rows[i]?.[j]?.time;
        return typeof t === "number" ? t : null;
      }));
  } catch {
    // Both routers are unreachable at once. Rank the trips on an estimate
    // rather than showing the rider nothing -- this only affects which
    // itinerary sorts first, and no line is ever drawn from it.
    estimated = true;
    return sources.map((a) => targets.map((b) => estimateSeconds(a, b)));
  }
}


/**
 * Walking seconds worked out from the map, for when Valhalla will not answer.
 *
 * Measured 2026-08-24: valhalla1.openstreetmap.de returned HTTP 000 -- no
 * response at all -- on three consecutive attempts on both endpoints, from
 * outside the browser. It is volunteer infrastructure and it goes dark. When
 * it does, the choice is between an app that cannot answer "how do I get
 * there" at all and one that answers approximately, and approximately is
 * plainly more useful so long as it says so.
 *
 * Straight-line distance times a detour factor, over a walking speed. It is
 * NOT a routed path and no line is ever drawn from it -- callers ask
 * `walkTimesAreEstimated()` and say so. College Hill is steep enough that this
 * misreports uphill walks, which is exactly why Valhalla is preferred whenever
 * it is reachable.
 */
const WALK_M_PER_S = 1.35;
/** Street grids and buildings, so real walking is longer than the crow flies. */
const DETOUR = 1.35;
let estimated = false;

/** Whether the most recent walking times came from the estimate rather than
 *  from Valhalla. Reset the moment a real answer arrives. */
export function walkTimesAreEstimated(): boolean { return estimated; }

function estimateSeconds(a: LatLng, b: LatLng): number {
  return Math.round((haversineMeters(a, b) * DETOUR) / WALK_M_PER_S);
}

/** Real pedestrian walking seconds from one point to many stops, in ONE call.
 *
 *  Valhalla is used rather than OSRM's public demo: that server has no foot
 *  profile loaded and silently answers pedestrian queries with car routing
 *  (2.1km in 176s = 42km/h) while still returning code "Ok". */
export async function walkMatrix(from: LatLng, to: Stop[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (to.length === 0) return out;
  const row = (await walkMatrixMulti([from], to))[0] ?? [];
  to.forEach((stop, i) => {
    const t = row[i];
    if (typeof t === "number") out.set(stop.id, t);
  });
  return out;
}

/** Walking seconds between two points. Used to decide whether the rider
 *  should simply walk instead of waiting for a shuttle. */
export async function walkSeconds(from: LatLng, to: LatLng): Promise<number | null> {
  const row = await walkMatrixMulti([from], [to]).catch(() => []);
  return row[0]?.[0] ?? null;
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
export async function walkRoute(
  from: LatLng, to: LatLng,
): Promise<{ path: LatLng[]; steps: WalkStep[] }> {
  try {
    const data = await ask(
      `${OSRM_FOOT}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}` +
      `?overview=full&geometries=geojson&steps=true`);
    return parseOsrmRoute(data);
  } catch {
    // Fall through to the other router.
  }
  return parseWalkRoute(await ask(`${VALHALLA}/route`, {
    locations: [
      { lat: from.lat, lon: from.lng },
      { lat: to.lat, lon: to.lng },
    ],
    costing: "pedestrian",
  }));
}

/** Which way to turn, in the words a rider would use.
 *
 *  OSRM reports a maneuver as a type and a modifier rather than a sentence,
 *  so the sentence is composed here. Valhalla writes its own narrative, which
 *  is why only this provider needs it. */
function osrmInstruction(
  type: string, modifier: string | undefined, name: string,
): string {
  const onto = name ? ` onto ${name}` : "";
  switch (type) {
    case "depart": return name ? `Head along ${name}` : "Start walking";
    case "arrive": return "Arrive at your destination";
    case "roundabout":
    case "rotary": return `Take the roundabout${onto}`;
    case "continue": return name ? `Continue on ${name}` : "Continue straight";
    case "new name": return name ? `Continue onto ${name}` : "Continue";
    default: {
      if (!modifier || modifier === "straight")
        return name ? `Continue onto ${name}` : "Continue straight";
      // "slight left" reads better than "Turn slight left".
      const how = modifier.startsWith("slight") || modifier.startsWith("sharp")
        ? `Bear ${modifier.replace(/^(slight|sharp) /, "")}`
        : `Turn ${modifier}`;
      return `${how}${onto}`;
    }
  }
}

/** Pull the drawable line and the turn-by-turn out of one OSRM response.
 *  Separated from the fetch so it can be tested against a frozen response. */
export function parseOsrmRoute(data: unknown): { path: LatLng[]; steps: WalkStep[] } {
  const route = (data as {
    routes?: {
      geometry?: { coordinates?: [number, number][] };
      legs?: { steps?: {
        name?: string; distance?: number; duration?: number;
        maneuver?: { type?: string; modifier?: string };
      }[] }[];
    }[];
  })?.routes?.[0];
  // GeoJSON is [lng, lat]; reading it the other way round puts Providence in
  // the Indian Ocean.
  const path = (route?.geometry?.coordinates ?? [])
    .map(([lng, lat]) => ({ lat, lng }));
  const steps: WalkStep[] = [];
  for (const st of route?.legs?.[0]?.steps ?? []) {
    const metres = Math.round(st.distance ?? 0);
    // OSRM emits a final zero-length arrive step, and short connector steps
    // between sidewalk segments that no rider would call a turn.
    if (metres < 5 && st.maneuver?.type !== "arrive") continue;
    steps.push({
      instruction: osrmInstruction(
        st.maneuver?.type ?? "", st.maneuver?.modifier, (st.name ?? "").trim()),
      metres,
      seconds: Math.round(st.duration ?? 0),
    });
  }
  return { path, steps };
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
