import { describe, it, expect } from "vitest";
import { toPlaces, withinWalkOfStops, matchingStops } from "../src/data/geocode";

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
      properties: { housenumber: "10", street: "Waterman Street", city: "Providence", state: "RI" },
      geometry: { type: "Point", coordinates: [-71.4005, 41.8265] as [number, number] },
    }]);
    expect(got[0]!.name).toBe("10 Waterman Street");
    expect(got[0]!.detail).toBe("Providence, RI");
  });

  it("drops a result with no usable coordinates", () => {
    expect(toPlaces([{ properties: { name: "Nowhere" }, geometry: { type: "Point" } }])).toEqual([]);
  });
});

/** A rectangle around Providence necessarily swallows its neighbours: measured
 *  2026-09-05, the box that already excludes Warwick still lets through
 *  Cranston, Pawtucket, Olneyville and the north end of Warwick Ave, and live
 *  Photon returned a Cranston restaurant as the top hit for a Thayer St query.
 *  The rider is picking somewhere the bus or their legs can reach, so the test
 *  that matters is distance to the NETWORK, not membership of a box. */
describe("keeping results within reach of the shuttle", () => {
  // Four real stops, spanning the network the app actually serves.
  const stops = [
    { id: "7864", name: "Hillel House", lat: 41.82737, lng: -71.40183 },
    { id: "7866", name: "Dyer & Hay/Public Health", lat: 41.82565, lng: -71.41013 },
    { id: "7851", name: "Sciences Library", lat: 41.82633, lng: -71.40036 },
    { id: "166667", name: "South Street Landing", lat: 41.82064, lng: -71.40560 },
  ];
  const place = (name: string, lat: number, lng: number) => ({ name, detail: "", at: { lat, lng } });

  const MAX = 20 * 60;

  it("keeps places a rider could actually walk to a stop from", () => {
    const kept = withinWalkOfStops([
      place("Thayer St", 41.8288, -71.4004),
      place("RISD Fleet Library", 41.82355, -71.41183),
      place("Trader Joe's Providence", 41.8182465, -71.4004397),
    ], stops, MAX).map((p) => p.name);
    expect(kept).toEqual(["Thayer St", "RISD Fleet Library", "Trader Joe's Providence"]);
  });

  it("drops the neighbouring towns the box cannot exclude", () => {
    const kept = withinWalkOfStops([
      place("Naz's Halal, Cranston", 41.7813585, -71.4400759),
      place("Warwick Ave", 41.77, -71.43),
      place("Pawtucket centre", 41.87, -71.382),
      place("Olneyville", 41.818, -71.452),
    ], stops, MAX);
    expect(kept).toEqual([]);
  });

  it("keeps everything when the stop list has not loaded yet", () => {
    // feed is null until the GTFS fetch resolves. Filtering against an empty
    // network would drop every result and look like "no such place".
    const all = [place("Thayer St", 41.8288, -71.4004), place("Warwick", 41.72, -71.46)];
    expect(withinWalkOfStops(all, [], MAX)).toEqual(all);
  });

  it("ranks the nearest to the network first", () => {
    const ordered = withinWalkOfStops([
      place("far but in range", 41.8182465, -71.3950),
      place("right at a stop", 41.82737, -71.40183),
    ], stops, MAX).map((p) => p.name);
    expect(ordered[0]).toBe("right at a stop");
  });
});

/** The app ships 70 named stops and never offered one as a destination, so a
 *  rider typing a stop's name got whatever OSM happened to have instead. This
 *  is also the only fixable half of "Shah's Halal does not turn up": OSM has no
 *  such POI on College Hill (checked against Overpass 2026-09-05), so no
 *  geocoder built on OSM can return it -- but the stops are ours to offer. */
describe("searching the shuttle stops themselves", () => {
  const stops = [
    { id: "40950", name: "Faunce Arch", lat: 41.8265, lng: -71.4030 },
    { id: "7851", name: "Sciences Library", lat: 41.82633, lng: -71.40036 },
    { id: "7864", name: "Hillel House", lat: 41.82737, lng: -71.40183 },
  ];

  it("finds a stop by part of its name", () => {
    const got = matchingStops("faunce", stops);
    expect(got.map((p) => p.name)).toEqual(["Faunce Arch"]);
    expect(got[0]!.at).toEqual({ lat: 41.8265, lng: -71.4030 });
  });

  it("says a result is a shuttle stop, so it is not confused with an address", () => {
    expect(matchingStops("sciences", stops)[0]!.detail).toMatch(/shuttle stop/i);
  });

  it("matches on any word, not just the start of the name", () => {
    expect(matchingStops("library", stops).map((p) => p.name)).toEqual(["Sciences Library"]);
  });

  it("returns nothing for a query that matches no stop", () => {
    expect(matchingStops("trader joe", stops)).toEqual([]);
  });
});
