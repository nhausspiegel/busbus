import { describe, it, expect } from "vitest";
import { emptyHistory, recordSample, bucketOf, observed, describeService } from "../src/data/serviceHistory";

/**
 * The only honest way this app can say when service runs.
 *
 * The timetable cannot: calendar.txt is one row marking every route running
 * daily through 2027 and there is no calendar_dates.txt, so the data has no
 * field in which "not running today" could be written. What CAN be said is
 * what was actually seen -- record when vehicles really report, then state
 * that history and nothing more.
 *
 * Counted in DAYS, not samples. A recorder running every ten minutes puts six
 * samples in an hour, so "seen in 30 of 36 samples" says almost nothing a
 * rider can use, while "seen on 5 of the last 6 Fridays at this hour" is a
 * claim they can act on.
 */
const FRI_14 = new Date("2026-08-28T18:20:00Z");   // Friday 2:20pm in Providence

describe("bucketOf", () => {
  it("buckets by weekday and hour in the rider's own timezone", () => {
    // UTC would smear the evening across two weekday buckets and put the
    // Evening routes on the wrong day for anyone reading them.
    expect(bucketOf(FRI_14)).toBe("5-14");
    expect(bucketOf(new Date("2026-08-29T01:30:00Z"))).toBe("5-21");  // still Friday locally
  });
});

describe("recordSample", () => {
  it("counts a day once however many times it samples", () => {
    let h = emptyHistory("2026-08-28");
    for (let i = 0; i < 6; i++) h = recordSample(h, ["3302"], FRI_14);
    expect(observed(h, "3302", FRI_14)).toEqual({ seen: 1, days: 1 });
  });

  it("counts a second Friday separately", () => {
    let h = emptyHistory("2026-08-21");
    h = recordSample(h, ["3302"], new Date("2026-08-21T18:20:00Z"));
    h = recordSample(h, ["3302"], FRI_14);
    expect(observed(h, "3302", FRI_14)).toEqual({ seen: 2, days: 2 });
  });

  it("records the day as observed even when nothing was running", () => {
    // This is the half that makes the number mean anything. Counting only the
    // days a bus appeared would make one sighting read as "every time".
    let h = emptyHistory("2026-08-21");
    h = recordSample(h, [], new Date("2026-08-21T18:20:00Z"));
    h = recordSample(h, ["3302"], FRI_14);
    expect(observed(h, "3302", FRI_14)).toEqual({ seen: 1, days: 2 });
  });

  it("keeps routes apart", () => {
    let h = emptyHistory("2026-08-28");
    h = recordSample(h, ["3302"], FRI_14);
    expect(observed(h, "3469", FRI_14)).toEqual({ seen: 0, days: 1 });
  });

  it("says nothing about an hour it has never sampled", () => {
    const h = recordSample(emptyHistory("2026-08-28"), ["3302"], FRI_14);
    expect(observed(h, "3302", new Date("2026-08-25T18:20:00Z"))).toEqual({ seen: 0, days: 0 });
  });
});

describe("describeService", () => {
  const build = (seen: number, days: number) => {
    let h = emptyHistory("2026-08-01");
    for (let i = 0; i < days; i++) {
      const at = new Date(Date.UTC(2026, 6, 3 + i * 7, 18, 20));   // successive Fridays
      h = recordSample(h, i < seen ? ["3302"] : [], at);
    }
    return h;
  };

  it("says nothing until it has watched enough to mean something", () => {
    // One Friday is an anecdote. Saying "seen on 1 of 1" invites a rider to
    // read a single sighting as a schedule, which is the mistake this whole
    // feature exists to avoid.
    expect(describeService(build(1, 1), "3302", FRI_14)).toBeNull();
    expect(describeService(build(2, 2), "3302", FRI_14)).toBeNull();
  });

  it("states the record and nothing more", () => {
    const s = describeService(build(3, 4), "3302", FRI_14)!;
    expect(s).toContain("3 of the 4");
    expect(s).toContain("Fridays");
    // No prediction, no "should", no schedule.
    expect(s).not.toMatch(/will|expect|scheduled|usually runs/i);
  });

  it("reports never having seen it, which is worth knowing too", () => {
    expect(describeService(build(0, 5), "3302", FRI_14)).toContain("0 of the 5");
  });
});

describe("daylight saving", () => {
  it("files a sample under the hour the rider would read on the clock", () => {
    // Same instant-of-week either side of the November change lands in
    // different buckets, because 2pm is 2pm to the person waiting for the bus
    // whatever the offset is doing. The cost is that the record thins out for
    // a week around the change, which is the right way round: better a thin
    // record than one that says 2pm and means 3pm.
    expect(bucketOf(new Date("2023-11-07T22:13:20Z"))).toBe("2-17");
    expect(bucketOf(new Date("2023-10-31T22:13:20Z"))).toBe("2-18");
  });
});
