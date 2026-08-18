import type { LatLng, Stop } from "../data/types";

const VALHALLA = "https://valhalla1.openstreetmap.de";

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

/** Real pedestrian walking seconds from one point to many stops, in ONE call.
 *
 *  Valhalla is used rather than OSRM's public demo: that server has no foot
 *  profile loaded and silently answers pedestrian queries with car routing
 *  (2.1km in 176s = 42km/h) while still returning code "Ok". */
export async function walkMatrix(from: LatLng, to: Stop[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (to.length === 0) return out;
  const res = await fetch(`${VALHALLA}/sources_to_targets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sources: [{ lat: from.lat, lon: from.lng }],
      targets: to.map((s) => ({ lat: s.lat, lon: s.lng })),
      costing: "pedestrian",
    }),
  });
  if (!res.ok) throw new Error(`valhalla matrix -> HTTP ${res.status}`);
  const data = await res.json();
  const row = data?.sources_to_targets?.[0] ?? [];
  row.forEach((cell: { time?: number }, i: number) => {
    const stop = to[i];
    if (stop && typeof cell?.time === "number") out.set(stop.id, cell.time);
  });
  return out;
}

/** Sidewalk-following polyline for drawing one walking leg. */
export async function walkGeometry(from: LatLng, to: LatLng): Promise<LatLng[]> {
  const res = await fetch(`${VALHALLA}/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      locations: [
        { lat: from.lat, lon: from.lng },
        { lat: to.lat, lon: to.lng },
      ],
      costing: "pedestrian",
    }),
  });
  if (!res.ok) throw new Error(`valhalla route -> HTTP ${res.status}`);
  const data = await res.json();
  const shape: string | undefined = data?.trip?.legs?.[0]?.shape;
  return shape ? decodePolyline6(shape) : [];
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
