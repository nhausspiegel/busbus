import { describe, it, expect } from "vitest";
import { emptyHistory } from "../src/data/serviceHistory";
import { recordLegs, legSeconds, LEG_SAMPLES, MIN_LEG_SAMPLES } from "../src/data/legTimes";
import type { Departure } from "../src/data/types";

/**
 * How long a ride actually takes, learned by watching.
 *
 * The Daytime Express is the case this exists for. Its GTFS trip carries two
 * of the nine stops it calls at, so the planner can only build a ride between
 * those two -- a rider at John Hay Library gets offered a walk while a shuttle
 * they could board goes past. The stop ORDER comes from Passio, but no source
 * gives the durations, and inventing one from distance would be exactly the
 * unfounded claim this project refuses.
 *
 * Watching is the honest way to get them: realtime publishes absolute times
 * per stop, so the gap between two of them on one trip IS a measured leg.
 */
const dep = (stopId: string, seq: number, time: number): Departure =>
  ({ stopId, tripId: "T1", routeId: "R1", seq, time, live: true });

describe("recordLegs", () => {
  it("measures the gap between stops realtime reported on one trip", () => {
    const h = recordLegs(emptyHistory("2026-08-29"),
      [dep("A", 1, 1000), dep("B", 2, 1240), dep("C", 3, 1600)]);
    expect(h.legs?.["R1|A|B"]).toEqual([240]);
    expect(h.legs?.["R1|B|C"]).toEqual([360]);
  });

  it("records only ADJACENT stops, not every pair", () => {
    // A->C is two legs. Storing it as its own leg would double count, and
    // would be wrong the moment a trip skips a stop.
    const h = recordLegs(emptyHistory("2026-08-29"),
      [dep("A", 1, 1000), dep("B", 2, 1240), dep("C", 3, 1600)]);
    expect(h.legs?.["R1|A|C"]).toBeUndefined();
  });

  it("ignores a pair that goes backwards or takes no time", () => {
    // Passio's realtime is not always ordered or sane; a zero or negative leg
    // is not a fast bus, it is a bad reading.
    const h = recordLegs(emptyHistory("2026-08-29"),
      [dep("A", 1, 1000), dep("B", 2, 1000), dep("C", 3, 900)]);
    expect(h.legs).toEqual({});
  });

  it("keeps only the most recent samples, so the record follows reality", () => {
    let h = emptyHistory("2026-08-29");
    for (let i = 0; i < LEG_SAMPLES + 5; i++)
      h = recordLegs(h, [dep("A", 1, 0), dep("B", 2, 100 + i)]);
    expect(h.legs?.["R1|A|B"]).toHaveLength(LEG_SAMPLES);
    // The oldest are the ones dropped.
    expect(h.legs?.["R1|A|B"]?.[0]).toBe(105);
  });
});

describe("legSeconds", () => {
  const withSamples = (samples: number[]) => {
    let h = emptyHistory("2026-08-29");
    for (const s of samples) h = recordLegs(h, [dep("A", 1, 0), dep("B", 2, s)]);
    return h;
  };

  it("says nothing until it has watched enough times", () => {
    const few = Array(MIN_LEG_SAMPLES - 1).fill(200);
    expect(legSeconds(withSamples(few), "R1", "A", "B")).toBeNull();
  });

  it("takes the median, so one bus stuck at a light does not set the time", () => {
    const h = withSamples([180, 190, 200, 210, 4000]);
    expect(legSeconds(h, "R1", "A", "B")).toBe(200);
  });

  it("knows nothing about a leg it has never seen", () => {
    expect(legSeconds(withSamples([180, 190, 200, 210, 220]), "R1", "B", "A")).toBeNull();
  });
});
