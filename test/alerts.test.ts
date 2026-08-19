import { describe, it, expect } from "vitest";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { parseAlerts } from "../src/data/alerts";

const NOW = 1_700_000_000;

/** Build a real protobuf with the same library that decodes it, so the test
 *  exercises the actual wire format rather than a hand-made stand-in. */
function encodeAlerts(alerts: { start?: number; end?: number; header: string; route?: string }[]) {
  const msg = GtfsRealtimeBindings.transit_realtime.FeedMessage.create({
    header: { gtfsRealtimeVersion: "2.0" },
    entity: alerts.map((a, i) => ({
      id: String(i + 1),
      alert: {
        activePeriod: (a.start !== undefined || a.end !== undefined)
          ? [{ ...(a.start !== undefined ? { start: a.start } : {}),
               ...(a.end !== undefined ? { end: a.end } : {}) }]
          : [],
        informedEntity: a.route ? [{ routeId: a.route }] : [],
        headerText: { translation: [{ text: a.header, language: "en" }] },
        descriptionText: { translation: [{ text: `${a.header} detail`, language: "en" }] },
      },
    })),
  });
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.encode(msg).finish();
}

describe("parseAlerts", () => {
  it("returns empty for an empty feed rather than throwing", () => {
    expect(parseAlerts(new Uint8Array(0), NOW)).toEqual([]);
  });

  it("decodes an active alert with its route and text", () => {
    const got = parseAlerts(
      encodeAlerts([{ start: NOW - 60, end: NOW + 3600, header: "College St closed", route: "3302" }]), NOW);
    expect(got).toHaveLength(1);
    expect(got[0]!.header).toBe("College St closed");
    expect(got[0]!.routeIds).toEqual(["3302"]);
    expect(got[0]!.description).toContain("detail");
  });

  it("drops an alert that already ended", () => {
    // Showing last week's closure trains riders to ignore the banner entirely.
    const got = parseAlerts(
      encodeAlerts([{ start: NOW - 7200, end: NOW - 3600, header: "Old detour" }]), NOW);
    expect(got).toEqual([]);
  });

  it("drops an alert that has not started yet", () => {
    const got = parseAlerts(
      encodeAlerts([{ start: NOW + 3600, header: "Future closure" }]), NOW);
    expect(got).toEqual([]);
  });

  it("keeps an alert with no stated period", () => {
    // Passio does publish these; treating "no window" as "not active" would
    // hide a live service change.
    const got = parseAlerts(encodeAlerts([{ header: "Ongoing detour" }]), NOW);
    expect(got).toHaveLength(1);
  });
});
