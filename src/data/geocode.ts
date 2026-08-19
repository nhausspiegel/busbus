import type { LatLng } from "./types";

export interface Place { name: string; detail: string; at: LatLng }

/** Bounding box around College Hill / downtown Providence. Keeps results
 *  local, and keeps us off Nominatim's global index for no reason. */
const VIEWBOX = "-71.45,41.87,-71.36,41.79";

/** Shape of the fields we use from a Nominatim result. */
interface NominatimRow {
  display_name?: string;
  name?: string;
  lat?: string;
  lon?: string;
}

/** Split Nominatim's one-line display_name into a heading and a subtitle.
 *  Pure so it can be tested without hitting a volunteer-run service. */
export function toPlaces(rows: NominatimRow[]): Place[] {
  const out: Place[] = [];
  for (const r of rows) {
    const lat = Number(r.lat), lng = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const parts = (r.display_name ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    const name = r.name?.trim() || parts[0] || "Unnamed place";
    // Drop the country and postcode tail; a rider on campus does not need
    // "United States" to tell two Providence addresses apart.
    const detail = parts.slice(1, 4).join(", ");
    out.push({ name, detail, at: { lat, lng } });
  }
  return out;
}

/** Search for a place by name or address.
 *
 *  Nominatim is volunteer infrastructure with a strict usage policy, so this is
 *  called on submit only -- never per keystroke. */
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "6");
  url.searchParams.set("viewbox", VIEWBOX);
  url.searchParams.set("bounded", "1");
  url.searchParams.set("addressdetails", "0");
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Place search failed (${res.status})`);
  return toPlaces(await res.json());
}
