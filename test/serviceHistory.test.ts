import { describe, it, expect } from "vitest";
import { emptyHistory, recordSample, bucketOf, observed, describeService, bestObserved,
         describeAbsence, migrateBuckets } from "../src/data/serviceHistory";

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
 * rider can use, while "seen on 5 of the last 6 weekdays at this hour" is a
 * claim they can act on.
 */
const FRI_14 = new Date("2026-08-28T18:20:00Z");   // Friday 2:20pm in Providence

describe("bucketOf", () => {
  it("buckets by weekday and hour in the rider's own timezone", () => {
    // UTC would smear the evening across two weekday buckets and put the
    // Evening routes on the wrong day for anyone reading them.
    expect(bucketOf(FRI_14)).toBe("wd-14");
    expect(bucketOf(new Date("2026-08-29T01:30:00Z"))).toBe("wd-21");  // still Friday locally
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
    // A different HOUR, not a different weekday: Tuesday 2pm and Friday 2pm
    // now share a bucket by design, so the old probe no longer isolates one.
    expect(observed(h, "3302", new Date("2026-08-28T12:20:00Z"))).toEqual({ seen: 0, days: 0 });
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
    expect(s).toContain("weekdays");
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
      expect(bucketOf(new Date("2023-11-07T22:13:20Z"))).toBe("wd-17");
      expect(bucketOf(new Date("2023-10-31T22:13:20Z"))).toBe("wd-18");
  });
});

describe("a local time this code cannot read", () => {
  /**
   * `Math.max(0, dows.indexOf(...))` turned a weekday this table does not know
   * into Sunday, and `Number("") % 24` into NaN. Every sample of a whole day
   * would have been filed under "0-NaN" and the app could print "on 3 of the 8
   * Sundays watched" on a Tuesday -- in the one file whose entire thesis is
   * never claiming more than was observed. The recorder's loader sets the
   * standard: a shape we cannot read is not a reason to throw the record away,
   * it is a reason to stop and be looked at.
   */
  const realParts = Intl.DateTimeFormat.prototype.formatToParts;

  /** Bend what Intl says, and count that the stub actually fired -- a stub
   *  that never ran would make the assertion inside it vacuous. */
  const withParts = (
    mangle: (parts: Intl.DateTimeFormatPart[]) => Intl.DateTimeFormatPart[],
    body: () => void,
  ) => {
    let fired = 0;
    Intl.DateTimeFormat.prototype.formatToParts = function (
      this: Intl.DateTimeFormat, d?: Date | number,
    ) {
      fired++;
      return mangle(realParts.call(this, d));
    };
    try { body(); } finally { Intl.DateTimeFormat.prototype.formatToParts = realParts; }
    expect(fired).toBeGreaterThan(0);
  };

  it("refuses a weekday it does not recognise instead of calling it Sunday", () => {
    withParts(
      (parts) => parts.map((p) => (p.type === "weekday" ? { ...p, value: "vendredi" } : p)),
      () => expect(() => bucketOf(FRI_14)).toThrow(/weekday/),
    );
  });

  it("refuses a missing hour instead of quietly calling it midnight", () => {
    // Number("") is 0, so a dropped hour part was not even loud enough to be
    // NaN -- every sample of that day would have been filed at 00:00.
    withParts(
      (parts) => parts.filter((p) => p.type !== "hour"),
      () => expect(() => bucketOf(FRI_14)).toThrow(/hour/),
    );
  });
});

describe("bestObserved", () => {
  /** A rider standing at a stop asks "will one come?". The record can answer
   *  it for the route that serves them best, which is more use than an
   *  average over routes that barely call there. */
  const build = () => {
    let h = emptyHistory("2026-07-01");
    for (let i = 0; i < 4; i++) {
      const at = new Date(Date.UTC(2026, 6, 3 + i * 7, 18, 20));
      h = recordSample(h, i < 3 ? ["A", "B"] : i < 4 ? ["B"] : [], at);
    }
    return h;                       // A seen 3 of 4, B seen 4 of 4
  };

  it("reports the route seen most often at this hour", () => {
    expect(bestObserved(build(), ["A", "B"], FRI_14)).toEqual({ routeId: "B", seen: 4, days: 4 });
  });

  it("ignores routes that do not serve the stop", () => {
    expect(bestObserved(build(), ["A"], FRI_14)).toEqual({ routeId: "A", seen: 3, days: 4 });
  });

  it("says nothing when nothing has been watched enough", () => {
    expect(bestObserved(emptyHistory("2026-07-01"), ["A"], FRI_14)).toBeNull();
    expect(bestObserved(build(), [], FRI_14)).toBeNull();
  });

  it("reports a route never seen, which is the useful answer too", () => {
    expect(bestObserved(build(), ["Z"], FRI_14)).toEqual({ routeId: "Z", seen: 0, days: 4 });
  });
});

/** The inverse claim, and the harder one to make honestly.
 *
 *  A rider handed a walk deserves to know WHY. The record can say it: if
 *  nothing has ever been seen at this hour across enough days, that is an
 *  observation, in days, in the past tense -- the same standard as every other
 *  sentence this file produces. What it must never do is turn silence into a
 *  claim: too few days watched, or any sighting at all, and it says nothing.
 */
describe("describeAbsence", () => {
  const SAT_22 = new Date("2026-09-06T02:20:00Z");   // Saturday 10:20pm locally

  it("says nothing until enough days have been watched", () => {
    let h = emptyHistory("2026-08-29");
    h = recordSample(h, [], new Date("2026-08-30T02:20:00Z"));
    h = recordSample(h, [], SAT_22);
    expect(describeAbsence(h, ["3302"], SAT_22)).toBeNull();   // two Saturdays is not a record
  });

  it("reports the hours nothing was ever seen, once there is a record", () => {
    let h = emptyHistory("2026-08-01");
    for (const d of ["2026-08-09", "2026-08-16", "2026-08-23", "2026-09-06"])
      h = recordSample(h, [], new Date(`${d}T02:20:00Z`));     // watched, nothing running
    const said = describeAbsence(h, ["3302"], SAT_22);
    expect(said).toMatch(/Saturdays/);
    expect(said).toMatch(/\b4\b/);
    expect(said).toMatch(/seen/i);
  });

  it("says nothing when the route HAS been seen at this hour", () => {
    let h = emptyHistory("2026-08-01");
    for (const d of ["2026-08-09", "2026-08-16", "2026-08-23"])
      h = recordSample(h, ["3302"], new Date(`${d}T02:20:00Z`));
    expect(describeAbsence(h, ["3302"], SAT_22)).toBeNull();
  });

  it("says nothing when ANY of the routes has been seen", () => {
    // One running shuttle is enough to make "nothing runs now" false.
    let h = emptyHistory("2026-08-01");
    for (const d of ["2026-08-09", "2026-08-16", "2026-08-23"])
      h = recordSample(h, ["62487"], new Date(`${d}T02:20:00Z`));
    expect(describeAbsence(h, ["3302", "62487"], SAT_22)).toBeNull();
  });

  it("never claims anything about the future", () => {
    let h = emptyHistory("2026-08-01");
    for (const d of ["2026-08-09", "2026-08-16", "2026-08-23"])
      h = recordSample(h, [], new Date(`${d}T02:20:00Z`));
    const said = describeAbsence(h, ["3302"], SAT_22) ?? "";
    expect(said).not.toMatch(/will|won't|expect|scheduled|due|tonight|tomorrow/i);
  });
});

/**
 * Why the bucket is a day TYPE and not a weekday.
 *
 * Keyed on the weekday, a bucket can only gain one day per WEEK, so the
 * three-day floor took three weeks to clear and the app said nothing about
 * service for most of a month. Grouping Mon-Fri makes a weekday bucket gain
 * five days a week and clears the same floor in under one -- with MORE
 * evidence behind the sentence, not less.
 *
 * The assumption is that weekday service is uniform, which is how GTFS itself
 * models it (calendar.txt carries a flag per weekday precisely because they
 * usually agree). Saturday and Sunday stay separate, because they usually do
 * not.
 */
describe("day-type buckets", () => {
  const at = (iso: string) => new Date(iso);
  const MON = at("2026-08-31T17:20:00Z");   // Monday 1:20pm local
  const TUE = at("2026-09-01T17:20:00Z");
  const WED = at("2026-09-02T17:20:00Z");
  const SAT = at("2026-09-05T17:20:00Z");
  const SUN = at("2026-09-06T17:20:00Z");

  it("puts every weekday in one bucket, and each weekend day in its own", () => {
    expect(bucketOf(MON)).toBe(bucketOf(TUE));
    expect(bucketOf(TUE)).toBe(bucketOf(WED));
    expect(bucketOf(SAT)).not.toBe(bucketOf(MON));
    expect(bucketOf(SUN)).not.toBe(bucketOf(SAT));
  });

  it("reaches a usable record in days rather than weeks", () => {
    let h = emptyHistory("2026-08-31");
    for (const d of [MON, TUE, WED]) h = recordSample(h, ["3302"], d);
    // Three consecutive weekdays, not three weeks.
    expect(observed(h, "3302", WED)).toEqual({ seen: 3, days: 3 });
    expect(describeService(h, "3302", WED)).toMatch(/3 of the 3 weekdays/);
  });

  it("does not let a weekday sighting speak for a Sunday", () => {
    let h = emptyHistory("2026-08-31");
    for (const d of [MON, TUE, WED]) h = recordSample(h, ["3302"], d);
    expect(observed(h, "3302", SUN)).toEqual({ seen: 0, days: 0 });
    expect(describeService(h, "3302", SUN)).toBeNull();
  });
});

describe("migrateBuckets", () => {
  it("folds a weekday-keyed record into day types without losing a day", () => {
    // Distinct weekdays are distinct DATES, so the counts add exactly.
    const old = {
      since: "2026-08-01", updated: "2026-09-06T00:00:00Z",
      days: { "1-13": { n: 2, last: "2026-09-01" },
              "3-13": { n: 1, last: "2026-09-02" },
              "6-13": { n: 4, last: "2026-09-05" } },
      seen: { "3302": { "1-13": { n: 2, last: "2026-09-01" },
                        "3-13": { n: 1, last: "2026-09-02" } } },
    } as never;
    const next = migrateBuckets(old);
    expect(next.days["wd-13"]).toEqual({ n: 3, last: "2026-09-02" });
    expect(next.days["sa-13"]).toEqual({ n: 4, last: "2026-09-05" });
    expect(next.seen["3302"]!["wd-13"]).toEqual({ n: 3, last: "2026-09-02" });
    expect(next.days["1-13"]).toBeUndefined();
  });

  it("leaves an already-migrated record alone", () => {
    const cur = { since: "x", updated: "y",
                  days: { "wd-13": { n: 5, last: "2026-09-04" } }, seen: {} } as never;
    expect(migrateBuckets(cur).days).toEqual({ "wd-13": { n: 5, last: "2026-09-04" } });
  });
});
