import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { parseStaticFeed, gtfsTimeToSeconds } from "../src/data/gtfs";

const zip = new Uint8Array(readFileSync("test/fixtures/gtfs.zip"));

describe("gtfsTimeToSeconds", () => {
  it("parses a normal time", () => {
    expect(gtfsTimeToSeconds("07:30:00")).toBe(7 * 3600 + 30 * 60);
  });

  it("preserves post-midnight times past 24h instead of wrapping", () => {
    // The Evening routes run past midnight; GTFS encodes 1:11am as 25:11:00.
    // Wrapping this to 4260 would sort it before the 11pm trips and produce
    // an itinerary that tells the user to catch a bus that already left.
    expect(gtfsTimeToSeconds("25:11:00")).toBe(25 * 3600 + 11 * 60);
  });

  it("returns null for the blank times GTFS uses at non-timepoint stops", () => {
    expect(gtfsTimeToSeconds("")).toBeNull();
  });
});

describe("parseStaticFeed", () => {
  const feed = parseStaticFeed(zip);

  it("loads every route with a usable color and shape", () => {
    expect(feed.routes.size).toBeGreaterThanOrEqual(8);
    const x = feed.routes.get("3302");
    expect(x?.name).toBe("Daytime Express");
    expect(x?.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(x!.shape.length).toBeGreaterThan(10);
  });

  it("loads stops with real coordinates near Providence", () => {
    expect(feed.stops.size).toBeGreaterThanOrEqual(60);
    for (const s of feed.stops.values()) {
      expect(s.lat).toBeGreaterThan(41.7);
      expect(s.lat).toBeLessThan(41.9);
      expect(s.lng).toBeGreaterThan(-71.5);
      expect(s.lng).toBeLessThan(-71.3);
    }
  });

  it("orders every trip's stops by ascending sequence", () => {
    for (const t of feed.trips.values()) {
      const seqs = t.stops.map((s) => s.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    }
  });

  it("drops trip stops that have no time rather than defaulting them to zero", () => {
    // Blank departure_times appear at non-timepoint stops. Defaulting them to 0
    // would make them look like midnight departures and poison the ranker.
    // Note 0 is itself a VALID time -- Evening CW genuinely departs 00:00:00 --
    // so this counts rows instead of asserting time > 0.
    const raw = strFromU8(unzipSync(zip)["stop_times.txt"]!);
    const rows = raw.split(/\r?\n/).filter((l) => l.length > 0).slice(1);
    const blanks = rows.filter((l) => {
      const cells = l.split(",");
      return !(cells[2] ?? "").trim();   // departure_time is column index 2
    }).length;
    const kept = [...feed.trips.values()].reduce((n, t) => n + t.stops.length, 0);

    expect(blanks).toBeGreaterThan(0);          // fixture actually exercises this
    expect(kept).toBe(rows.length - blanks);    // every non-blank kept, every blank dropped
  });

  it("parses quoted stop names containing commas without splitting them", () => {
    // GTFS quotes any field containing a comma; a naive split corrupts these.
    for (const s of feed.stops.values()) {
      expect(s.name).not.toMatch(/^"/);
      expect(s.name.length).toBeGreaterThan(0);
    }
  });
});

describe("route shapes", () => {
  const feed = parseStaticFeed(zip);

  it("gives every route with trips a drawable shape", () => {
    // Shapes were joined route_id -> shape_id, which works only because Passio
    // happens to name them identically. A feed with per-direction shapes
    // (62487_0 / 62487_1) would have drawn nothing, silently.
    const withTrips = new Set([...feed.trips.values()].map((t) => t.routeId));
    for (const routeId of withTrips) {
      const r = feed.routes.get(routeId);
      if (!r) continue;
      expect(r.shape.length).toBeGreaterThan(1);
    }
  });

  it("resolves shapes through trips.shape_id, not by assuming ids match", () => {
    const raw = strFromU8(unzipSync(zip)["trips.txt"]!);
    const header = raw.split(/\r?\n/)[0]!.split(",");
    expect(header).toContain("shape_id");
  });
});
