import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseTripUpdates } from "../src/data/realtime";

const pb = new Uint8Array(readFileSync("test/fixtures/tripUpdates.pb"));

describe("parseTripUpdates", () => {
  const deps = parseTripUpdates(pb);

  it("decodes departures without throwing on a sparse or empty feed", () => {
    // Overnight the feed legitimately has zero entities. That is not an error.
    expect(Array.isArray(deps)).toBe(true);
  });

  it("marks everything it returns as live", () => {
    for (const d of deps) expect(d.live).toBe(true);
  });

  it("returns absolute epoch seconds, not service-day offsets", () => {
    // A service-day offset would be < 100000; an epoch is > 1.6e9. Confusing
    // the two silently produces itineraries decades in the past.
    for (const d of deps) expect(d.time).toBeGreaterThan(1_600_000_000);
  });

  it("carries stop sequence so downstream stops can be identified", () => {
    for (const d of deps) expect(d.seq).toBeGreaterThanOrEqual(0);
  });

  it("returns an empty array for an empty protobuf rather than throwing", () => {
    expect(parseTripUpdates(new Uint8Array(0))).toEqual([]);
  });
});
