import { describe, it, expect } from "vitest";
import { toPlaces } from "../src/data/geocode";

/**
 * Real Photon output, captured 2026-08-24 from
 * `?q=trad&lat=41.826&lon=-71.400&bbox=-71.65,41.65,-71.15,42.00`.
 *
 * The query matters: "trad" is the case that sent us here. Nominatim matches
 * whole words, so it returned nothing for a partial one and the app told the
 * rider the address did not exist in Providence -- while "trader" found the
 * shop immediately. Photon answers the prefix, and with the bbox the
 * Providence branch is the first result rather than a restaurant in Boston.
 */
const captured = [
  {
    properties: {
      osm_key: "shop", osm_value: "supermarket", housenumber: "425",
      name: "Trader Joe's", street: "South Main Street", locality: "Fox Point",
      city: "Providence", county: "Providence", state: "RI",
      country: "United States", postcode: "02903",
    },
    geometry: { type: "Point", coordinates: [-71.4004397, 41.8182465] as [number, number] },
  },
  {
    properties: {
      osm_key: "shop", osm_value: "supermarket", housenumber: "1000",
      name: "Trader Joe's", street: "Bald Hill Road",
      city: "Warwick", county: "Kent", state: "RI", country: "United States",
    },
    geometry: { type: "Point", coordinates: [-71.4655, 41.7268] as [number, number] },
  },
];

describe("toPlaces", () => {
  it("finds the place a rider was half-way through typing", () => {
    const got = toPlaces(captured);
    expect(got[0]!.name).toBe("Trader Joe's");
    expect(got[0]!.detail).toContain("Providence");
    // Photon is GeoJSON: [lng, lat]. Reading them the other way round puts
    // Providence in the Indian Ocean.
    expect(got[0]!.at.lat).toBeCloseTo(41.8182, 3);
    expect(got[0]!.at.lng).toBeCloseTo(-71.4004, 3);
  });

  it("keeps two branches of the same shop apart", () => {
    // Both are called "Trader Joe's"; the subtitle is the only thing that
    // tells a rider which one they are about to walk to.
    const got = toPlaces(captured);
    expect(got[0]!.name).toBe(got[1]!.name);
    expect(got[0]!.detail).not.toBe(got[1]!.detail);
    expect(got[1]!.detail).toContain("Warwick");
  });

  it("leads a plain address with its street, not its house number", () => {
    const got = toPlaces([{
      properties: { housenumber: "129", street: "Angell Street", city: "Providence", state: "RI" },
      geometry: { type: "Point", coordinates: [-71.4005, 41.8265] as [number, number] },
    }]);
    expect(got[0]!.name).toBe("129 Angell Street");
    expect(got[0]!.detail).toBe("Providence, RI");
  });

  it("drops a result with no usable coordinates", () => {
    expect(toPlaces([{ properties: { name: "Nowhere" }, geometry: { type: "Point" } }])).toEqual([]);
  });
});
