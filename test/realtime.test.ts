import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseTripUpdates } from "../src/data/realtime";

const pb = new Uint8Array(readFileSync("test/fixtures/tripUpdates.pb"));

describe("parseTripUpdates", () => {
  const deps = parseTripUpdates(pb);

  it("decodes the departures the fixture actually contains", () => {
    // Was `expect(Array.isArray(deps)).toBe(true)`, which the return type
    // guarantees -- it could only fail by throwing, and it ran against the
    // non-empty fixture so it tested neither branch of its own name.
    expect(deps.length).toBeGreaterThan(0);
    expect(new Set(deps.map((d) => d.tripId)).size).toBeGreaterThan(0);
    for (const d of deps) expect(d.stopId).not.toBe("");
  });

  it("marks everything it returns as live", () => {
    for (const d of deps) expect(d.live).toBe(true);
  });

  it("returns absolute epoch seconds, not service-day offsets", () => {
    // A service-day offset would be < 100000; an epoch is > 1.6e9. Confusing
    // the two silently produces itineraries decades in the past.
    for (const d of deps) expect(d.time).toBeGreaterThan(1_600_000_000);
  });

  it("carries real stop sequences, not the zero fallback", () => {
    // `seq` is `stopSequence ?? 0` on a protobuf uint32, so `>= 0` was
    // unfalsifiable -- and it passed on a feed carrying no sequences at all,
    // which is precisely the case that makes seq useless downstream.
    expect(deps.every((d) => d.seq > 0)).toBe(true);
    expect(new Set(deps.map((d) => d.seq)).size).toBeGreaterThan(1);
  });

  it("returns an empty array for an empty protobuf rather than throwing", () => {
    expect(parseTripUpdates(new Uint8Array(0))).toEqual([]);
  });
});
