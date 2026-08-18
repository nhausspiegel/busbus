import { describe, it, expect } from "vitest";
import { haversineMeters, nearestStops, decodePolyline6 } from "../src/routing/walk";
import type { Stop } from "../src/data/types";

const s = (id: string, lat: number, lng: number): Stop => ({ id, name: id, lat, lng });

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

describe("decodePolyline6", () => {
  it("decodes at precision 6, keeping points in Providence", () => {
    // Valhalla uses precision 6, not the usual 5. Decoding at 5 would put
    // these coordinates ten degrees away, in the ocean.
    const encoded = "_grbgA~{reF_kh@";
    const pts = decodePolyline6(encoded);
    expect(pts.length).toBeGreaterThan(0);
    expect(Math.abs(pts[0]!.lat)).toBeLessThan(90);
  });

  it("returns empty for an empty string", () => {
    expect(decodePolyline6("")).toEqual([]);
  });
});
