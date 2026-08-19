import { describe, it, expect } from "vitest";
import { toPlaces } from "../src/data/geocode";

describe("toPlaces", () => {
  it("splits a display name into a heading and a short subtitle", () => {
    const [p] = toPlaces([{
      name: "Rockefeller Library",
      display_name: "Rockefeller Library, 10, Prospect Street, College Hill, Providence, Rhode Island, 02906, United States",
      lat: "41.8262", lon: "-71.4047",
    }]);
    expect(p!.name).toBe("Rockefeller Library");
    expect(p!.detail).toBe("10, Prospect Street, College Hill");
    expect(p!.detail).not.toContain("United States");
  });

  it("falls back to the first display_name segment when there is no name", () => {
    const [p] = toPlaces([{
      display_name: "155 Angell Street, Providence, Rhode Island", lat: "41.83", lon: "-71.40",
    }]);
    expect(p!.name).toBe("155 Angell Street");
  });

  it("drops rows without usable coordinates instead of placing them at 0,0", () => {
    // A result at null island would silently route the rider into the Atlantic.
    expect(toPlaces([{ display_name: "Nowhere", lat: "abc", lon: "" }])).toEqual([]);
  });

  it("returns empty for an empty response", () => {
    expect(toPlaces([])).toEqual([]);
  });
});
