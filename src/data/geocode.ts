import type { LatLng } from "./types";

export interface Place { name: string; detail: string; at: LatLng }

/**
 * Photon rather than Nominatim.
 *
 * Nominatim is a geocoder, not an autocomplete: it matches whole words, so
 * typing "trad" or "trade" returned nothing at all and the app told the rider
 * the address did not exist in Providence -- while "trader" found Trader Joe's
 * immediately. Photon is the OSM type-ahead built on the same data for exactly
 * this, and prefixes work: measured 2026-08-24, `q=trad` returns "Trader Joe's,
 * Providence" as its second result, and it answers with
 * `Access-Control-Allow-Origin: *` so the browser can read it.
 *
 * Still volunteer infrastructure, so the caller debounces and floors the gap
 * between requests.
 */
const PHOTON = "https://photon.komoot.io/api";

/** Providence, and not much else.
 *
 *  Photon's lat/lon only BIAS the ranking -- for "trad" the top hit without a
 *  box is a restaurant in Boston -- so the box is what actually keeps the
 *  results local. It was drawn wide enough for Warwick and T.F. Green, which
 *  made the results too broad for a shuttle that never leaves the city: the
 *  rider is picking somewhere the bus or their legs can reach. These are
 *  Providence's own limits with a little margin, so East Side, Fox Point, the
 *  Jewelry District and the hospitals are all in and Warwick is not. */
const BBOX = "-71.49,41.76,-71.36,41.87";
const CAMPUS = { lat: 41.8265, lng: -71.4025 };

/** The fields we use from a Photon feature. */
interface PhotonFeature {
  geometry?: { type?: string; coordinates?: [number, number] };
  properties?: {
    name?: string; street?: string; housenumber?: string;
    city?: string; state?: string; postcode?: string; osm_value?: string;
  };
}

/** Turn Photon's GeoJSON into the two lines a rider reads.
 *  Pure, so it can be tested without calling a volunteer-run service. */
export function toPlaces(features: PhotonFeature[]): Place[] {
  const out: Place[] = [];
  for (const f of features) {
    const [lng, lat] = f.geometry?.coordinates ?? [];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const p = f.properties ?? {};
    // A named place leads with its name; a plain address leads with the
    // street, since "12" alone is not a heading.
    const street = [p.housenumber, p.street].filter(Boolean).join(" ");
    const name = p.name?.trim() || street || p.city || "Unnamed place";
    const detail = [street && street !== name ? street : null, p.city, p.state]
      .filter(Boolean).join(", ");
    out.push({ name, detail, at: { lat: lat as number, lng: lng as number } });
  }
  return out;
}

/** Search for a place by name or address, prefix-first. */
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const url = new URL(PHOTON);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "6");
  url.searchParams.set("lat", String(CAMPUS.lat));
  url.searchParams.set("lon", String(CAMPUS.lng));
  url.searchParams.set("bbox", BBOX);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Place search failed (${res.status})`);
  const data = await res.json();
  return toPlaces(data?.features ?? []);
}
