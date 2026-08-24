import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStaticFeed } from "../src/data/gtfs";
import { serviceDayStart, scheduledDepartures, buildBoard } from "../src/data/departures";
import type { Departure } from "../src/data/types";

const feed = parseStaticFeed(new Uint8Array(readFileSync("test/fixtures/gtfs.zip")));

const dep = (o: Partial<Departure>): Departure => ({
  stopId: "S", tripId: "T", routeId: "R", seq: 1, time: 1000, live: false, ...o,
});

describe("serviceDayStart", () => {
  it("returns local midnight, so 25:11:00 lands after 23:00:00 of the same day", () => {
    const noon = new Date(2026, 7, 18, 12, 0, 0);
    const start = serviceDayStart(noon);
    expect(noon.getTime() / 1000 - start).toBe(12 * 3600);
  });
});

describe("scheduledDepartures", () => {
  const start = serviceDayStart(new Date(2026, 7, 18, 12, 0, 0));
  const deps = scheduledDepartures(feed, start);

  it("produces absolute times from the timetable", () => {
    expect(deps.length).toBeGreaterThan(100);
    for (const d of deps) expect(d.live).toBe(false);
  });

  it("keeps post-midnight trips after the evening ones", () => {
    // 25:11:00 must land 25h11m after the service day starts, not 1h11m.
    const sameDay = deps.filter((d) => d.time >= start);
    expect(Math.max(...sameDay.map((d) => d.time)) - start).toBeGreaterThan(24 * 3600);
  });

  it("puts a post-midnight bus minutes away for a rider at 00:15, not a day", () => {
    // The real failure this guards: GTFS encodes after-midnight service as
    // 24:xx belonging to the PREVIOUS service day. Generating only the current
    // day placed those buses ~24 hours out and left the board empty during
    // exactly the hours the shuttle is the only way home.
    const at0015 = new Date(2026, 7, 19, 0, 15, 0);
    const nowS = Math.floor(at0015.getTime() / 1000);
    const soon = scheduledDepartures(feed, serviceDayStart(at0015))
      .filter((d) => d.time >= nowS && d.time < nowS + 3600);
    expect(soon.length).toBeGreaterThan(0);
  });
});

describe("buildBoard", () => {
  it("groups by stop and sorts each list ascending by time", () => {
    const board = buildBoard([], [dep({ stopId: "A", time: 300 }), dep({ stopId: "A", time: 100 })]);
    expect(board.get("A")!.map((d) => d.time)).toEqual([100, 300]);
  });

  it("lets a live prediction replace the scheduled entry for the same trip+stop", () => {
    // The bus is running 4 minutes late. Showing both would offer the user a
    // departure that will not happen.
    const scheduled = dep({ stopId: "A", tripId: "T1", time: 1000, live: false });
    const live = dep({ stopId: "A", tripId: "T1", time: 1240, live: true });
    const board = buildBoard([live], [scheduled]);
    expect(board.get("A")).toHaveLength(1);
    expect(board.get("A")![0]!.time).toBe(1240);
    expect(board.get("A")![0]!.live).toBe(true);
  });

  it("keeps scheduled departures for trips with no live data", () => {
    // Only ~1-2 trips are live at once; the rest of the timetable must survive.
    const board = buildBoard(
      [dep({ stopId: "A", tripId: "T1", time: 1240, live: true })],
      [dep({ stopId: "A", tripId: "T2", time: 1500, live: false })],
    );
    expect(board.get("A")).toHaveLength(2);
  });

  it("returns an empty board when nothing is running", () => {
    expect(buildBoard([], []).size).toBe(0);
  });
});

describe("buildBoard with duplicate trips in the feed", () => {
  // Passio publishes some trips twice under different trip_ids: measured on
  // the shipped feed, 218795 and 218820 are byte-identical -- same route,
  // same service_id, same shape, same 12 stops at the same seconds -- so the
  // Sciences Library card listed "Evening CW Route - 4 min - 9:37 PM" twice,
  // identical, and the second row crowded out a different route.
  const dep = (tripId: string, time: number, live = false) =>
    ({ stopId: "7851", tripId, routeId: "3469", seq: 4, time, live });

  it("lists one departure when two trip ids leave at the same second", () => {
    const got = buildBoard([], [dep("218795", 1000), dep("218820", 1000)]);
    expect(got.get("7851")).toHaveLength(1);
  });

  it("keeps the live one when a duplicate is scheduled", () => {
    // Two identical buses cannot both be right; the one reporting its own
    // position is the better claim.
    const got = buildBoard([dep("218795", 1000, true)], [dep("218820", 1000)]);
    expect(got.get("7851")).toHaveLength(1);
    expect(got.get("7851")![0]!.live).toBe(true);
  });

  it("keeps a loop's two visits to the same stop", () => {
    // Trip 899418 serves stop 8380 at seq 1 and again at seq 15. Those are two
    // real chances to board and must both survive.
    const got = buildBoard([], [dep("899418", 1000), { ...dep("899418", 2800), seq: 15 }]);
    expect(got.get("7851")).toHaveLength(2);
  });

  it("keeps two different routes leaving at the same second", () => {
    const got = buildBoard([], [dep("a", 1000), { ...dep("b", 1000), routeId: "3470" }]);
    expect(got.get("7851")).toHaveLength(2);
  });
});
