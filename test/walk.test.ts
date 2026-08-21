import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { haversineMeters, nearestStops, decodePolyline6, parseWalkRoute } from "../src/routing/walk";
import type { Stop } from "../src/data/types";

const s = (id: string, lat: number, lng: number): Stop => ({ id, name: id, lat, lng });

describe("parseWalkRoute", () => {
  // A real Valhalla pedestrian response, frozen. The same call already supplied
  // the drawn walking line and threw the maneuvers away.
  const raw = JSON.parse(readFileSync("test/fixtures/valhalla-walk-route.json", "utf8"));
  const got = parseWalkRoute(raw);

  it("reads the walking directions out of the response the map already fetched", () => {
    expect(got.steps.length).toBe(19);
    expect(got.steps[0]!.instruction).toBe("Walk west on the walkway.");
    expect(got.steps[got.steps.length - 1]!.instruction)
      .toBe("You have arrived at your destination.");
  });

  it("converts Valhalla's kilometres to metres", () => {
    // `length` is 0.008 for the first maneuver and `units` is "kilometers".
    // Passing that through as metres would tell a rider to walk 8mm.
    expect(got.steps[0]!.metres).toBeCloseTo(8, 0);
    const total = got.steps.reduce((m, x) => m + x.metres, 0);
    expect(total).toBeGreaterThan(1200);      // the trip summary says 1.265 km
    expect(total).toBeLessThan(1350);
  });

  it("still returns the drawable line", () => {
    expect(got.path.length).toBeGreaterThan(10);
    expect(got.path[0]!.lat).toBeGreaterThan(41.7);
    expect(got.path[0]!.lat).toBeLessThan(41.9);
  });

  it("returns nothing usable rather than throwing on an empty response", () => {
    expect(parseWalkRoute({})).toEqual({ path: [], steps: [] });
  });
});

describe("haversineMeters", () => {
  it("measures a known campus distance within tolerance", () => {
    // John Hay Library -> South Street Landing, ~0.95 km straight line.
    const d = haversineMeters({ lat: 41.826195, lng: -71.404656 }, { lat: 41.817892, lng: -71.406899 });
    expect(d).toBeGreaterThan(850);
    expect(d).toBeLessThan(1100);
  });

  it("is zero for identical points", () => {
    expect(haversineMeters({ lat: 41.8, lng: -71.4 }, { lat: 41.8, lng: -71.4 })).toBe(0);
  });
});

describe("nearestStops", () => {
  const stops = [s("far", 41.90, -71.40), s("near", 41.8262, -71.4047), s("mid", 41.84, -71.40)];

  it("returns the k closest, closest first", () => {
    const got = nearestStops({ lat: 41.826195, lng: -71.404656 }, stops, 2);
    expect(got.map((x) => x.id)).toEqual(["near", "mid"]);
  });

  it("returns everything when k exceeds the stop count", () => {
    expect(nearestStops({ lat: 41.826, lng: -71.404 }, stops, 99)).toHaveLength(3);
  });

  it("returns empty for no stops rather than throwing", () => {
    // Happens when the feed fails to load; the UI must degrade, not crash.
    expect(nearestStops({ lat: 41.8, lng: -71.4 }, [], 5)).toEqual([]);
  });
});

/** Encode at precision 6, the way Valhalla does, so the test exercises a real
 *  round trip instead of a magic string. The previous fixture string actually
 *  decoded to southern Spain, which is why an `abs(lat) < 90` assertion passed
 *  while proving nothing. */
function encodePolyline6(points: { lat: number; lng: number }[]): string {
  let out = "", prevLat = 0, prevLng = 0;
  const chunk = (v: number) => {
    let s = v < 0 ? ~(v << 1) : v << 1;
    let r = "";
    while (s >= 0x20) { r += String.fromCharCode((0x20 | (s & 0x1f)) + 63); s >>= 5; }
    return r + String.fromCharCode(s + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e6), lng = Math.round(p.lng * 1e6);
    out += chunk(lat - prevLat) + chunk(lng - prevLng);
    prevLat = lat; prevLng = lng;
  }
  return out;
}

describe("decodePolyline6", () => {
  it("round-trips Providence coordinates at precision 6", () => {
    const path = [
      { lat: 41.826195, lng: -71.404656 },   // John Hay Library
      { lat: 41.823132, lng: -71.408373 },   // Dyer & Hay
      { lat: 41.817892, lng: -71.406899 },   // South Street Landing
    ];
    const got = decodePolyline6(encodePolyline6(path));
    expect(got).toHaveLength(3);
    got.forEach((p, i) => {
      expect(p.lat).toBeCloseTo(path[i]!.lat, 5);
      expect(p.lng).toBeCloseTo(path[i]!.lng, 5);
    });
  });

  it("decoded at precision 5 the same string would land nowhere near Providence", () => {
    // Guards the actual mistake: Valhalla uses 1e6, most polyline code uses
    // 1e5, and getting it wrong silently draws the walk in another hemisphere.
    const encoded = encodePolyline6([{ lat: 41.826195, lng: -71.404656 }]);
    const wrong = decodePolyline6(encoded).map((p) => ({ lat: p.lat * 10, lng: p.lng * 10 }));
    expect(Math.abs(wrong[0]!.lat)).toBeGreaterThan(90);
  });

  it("returns empty for an empty string", () => {
    expect(decodePolyline6("")).toEqual([]);
  });
});
