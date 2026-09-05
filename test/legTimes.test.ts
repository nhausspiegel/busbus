import { describe, it, expect } from "vitest";
import { emptyHistory } from "../src/data/serviceHistory";
import { recordLegs, legSeconds, LEG_SAMPLES, MIN_LEG_SAMPLES, MAX_LEG_SECONDS } from "../src/data/legTimes";
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
const dep = (stopId: string, seq: number, time: number, tripId = "T1"): Departure =>
  ({ stopId, tripId, routeId: "R1", seq, time, live: true });

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

  it("counts one trip once however many times it is polled", () => {
    // MIN_LEG_SAMPLES is documented as stopping "one slow afternoon being the
    // whole answer", but samples are POLLS. The recorder runs every fifteen
    // minutes and a trip is out the best part of an hour, so five samples
    // could be five readings of one bus -- and public/service-history.json
    // shows it: a 105 and a 106 sitting next to each other on the same leg.
    let h = emptyHistory("2026-08-29");
    for (let i = 0; i < 6; i++)
      h = recordLegs(h, [dep("A", 1, 1000 + i), dep("B", 2, 1240 + i * 3)]);
    expect(h.legs?.["R1|A|B"]).toEqual([240]);
    expect(legSeconds(h, "R1", "A", "B")).toBeNull();
  });

  it("still counts a second bus, and the same bus tomorrow", () => {
    // The guard must not swallow real observations: another vehicle on the
    // leg now, and this trip id when it runs again, are both new evidence.
    let h = emptyHistory("2026-08-29");
    h = recordLegs(h, [dep("A", 1, 1000, "T1"), dep("B", 2, 1240, "T1")]);
    h = recordLegs(h, [dep("A", 1, 2000, "T2"), dep("B", 2, 2260, "T2")]);
    h = recordLegs(h, [dep("A", 1, 87_400, "T1"), dep("B", 2, 87_680, "T1")]);
    expect(h.legs?.["R1|A|B"]).toEqual([240, 260, 280]);
  });

  it("throws out a leg no bus drove", () => {
    // 2037 of the 2039 adjacent legs the shipped timetable schedules are 300s
    // or less. The 1375 recorded between 7860 and 8381 sits beside readings of
    // 103, 107 and 120 on the same leg: realtime pairing a stale prediction
    // with a fresh one, not a slow bus.
    const h = recordLegs(emptyHistory("2026-08-29"),
      [dep("A", 1, 0), dep("B", 2, 1375), dep("C", 3, 1375 + MAX_LEG_SECONDS + 1)]);
    expect(h.legs).toEqual({});
  });

  it("keeps only the most recent samples, so the record follows reality", () => {
    let h = emptyHistory("2026-08-29");
    // A different bus each time: one bus can only contribute one sample.
    for (let i = 0; i < LEG_SAMPLES + 5; i++)
      h = recordLegs(h, [dep("A", 1, 0, `T${i}`), dep("B", 2, 100 + i, `T${i}`)]);
    expect(h.legs?.["R1|A|B"]).toHaveLength(LEG_SAMPLES);
    // The oldest are the ones dropped.
    expect(h.legs?.["R1|A|B"]?.[0]).toBe(105);
  });
});

describe("legSeconds", () => {
  /** One sample per trip, so each reading needs its own bus. */
  const withSamples = (samples: number[]) => {
    let h = emptyHistory("2026-08-29");
    samples.forEach((s, i) => {
      h = recordLegs(h, [dep("A", 1, 0, `T${i}`), dep("B", 2, s, `T${i}`)]);
    });
    return h;
  };

  it("says nothing until it has watched enough times", () => {
    const few = Array(MIN_LEG_SAMPLES - 1).fill(200);
    expect(legSeconds(withSamples(few), "R1", "A", "B")).toBeNull();
  });

  it("takes the median, so one bus stuck at a light does not set the time", () => {
    // 800s, not 4000: a leg over MAX_LEG_SECONDS is now refused outright, and
    // the point here is that a genuine outlier still does not set the time.
    const h = withSamples([180, 190, 200, 210, 800]);
    expect(legSeconds(h, "R1", "A", "B")).toBe(200);
  });

  it("knows nothing about a leg it has never seen", () => {
    expect(legSeconds(withSamples([180, 190, 200, 210, 220]), "R1", "B", "A")).toBeNull();
  });
});
