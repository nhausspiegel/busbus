import { describe, it, expect } from "vitest";
import { planWithTransfers } from "../src/routing/transfers";
import type { StaticFeed, DepartureBoard, Stop, Trip } from "../src/data/types";

const NOW = 1_700_000_000;

/** A->X on route R1, then X->B on route R2. No single ride reaches B. */
function twoLegFixture() {
  const mk = (id: string, lat: number, lng: number): Stop => ({ id, name: id, lat, lng });
  const stops = new Map<string, Stop>([
    ["A", mk("A", 41.830, -71.400)],
    ["X", mk("X", 41.825, -71.404)],
    ["B", mk("B", 41.818, -71.407)],
  ]);
  const t1: Trip = { id: "T1", routeId: "R1", stops: [
    { stopId: "A", seq: 1, time: 0 }, { stopId: "X", seq: 2, time: 300 }] };
  const t2: Trip = { id: "T2", routeId: "R2", stops: [
    { stopId: "X", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 300 }] };
  const feed: StaticFeed = {
    routes: new Map([
      ["R1", { id: "R1", name: "R1", shortName: "1", color: "#111111", shape: [] }],
      ["R2", { id: "R2", name: "R2", shortName: "2", color: "#222222", shape: [] }],
    ]),
    stops, trips: new Map([["T1", t1], ["T2", t2]]), feedEndDate: "20991231",
  };
  const board: DepartureBoard = new Map([
    ["A", [{ stopId: "A", tripId: "T1", routeId: "R1", seq: 1, time: NOW + 120, live: false }]],
    ["X", [{ stopId: "X", tripId: "T2", routeId: "R2", seq: 1, time: NOW + 600, live: false }]],
    ["B", [{ stopId: "B", tripId: "T2", routeId: "R2", seq: 2, time: NOW + 900, live: false }]],
  ]);
  return { feed, board };
}

const opts = (f: ReturnType<typeof twoLegFixture>) => ({
  feed: f.feed, board: f.board,
  origin: { lat: 41.830, lng: -71.400 }, destination: { lat: 41.818, lng: -71.407 },
  walkFromOrigin: new Map([["A", 60]]),
  walkToDestination: new Map([["B", 60]]),
  now: NOW,
});

describe("planWithTransfers", () => {
  it("finds a two-ride trip when no single ride connects origin to destination", () => {
    const f = twoLegFixture();
    const got = planWithTransfers(opts(f));
    expect(got.length).toBeGreaterThan(0);
    expect(got[0]!.transfers).toBe(1);
    expect(got[0]!.rides.map((r) => r.routeId)).toEqual(["R1", "R2"]);
  });

  it("does not offer a transfer the rider cannot physically make", () => {
    // First bus reaches X at NOW+420; make the connection leave at NOW+300.
    const f = twoLegFixture();
    f.board.set("X", [{ stopId: "X", tripId: "T2", routeId: "R2", seq: 1, time: NOW + 300, live: false }]);
    expect(planWithTransfers(opts(f))).toHaveLength(0);
  });

  it("prefers a single ride over a transfer that arrives no earlier", () => {
    // Riders dislike transfers; only offer one when it genuinely arrives sooner.
    const f = twoLegFixture();
    f.feed.routes.set("R3", { id: "R3", name: "R3", shortName: "3", color: "#333333", shape: [] });
    f.feed.trips.set("T3", { id: "T3", routeId: "R3", stops: [
      { stopId: "A", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 600 }] });
    f.board.get("A")!.push({ stopId: "A", tripId: "T3", routeId: "R3", seq: 1, time: NOW + 120, live: false });
    f.board.get("B")!.push({ stopId: "B", tripId: "T3", routeId: "R3", seq: 2, time: NOW + 720, live: false });
    const got = planWithTransfers(opts(f));
    expect(got[0]!.transfers).toBe(0);
  });

  it("respects the transfer slack rather than assuming an instant connection", () => {
    // Bus 1 reaches X at NOW+420. A connection at exactly NOW+420 is too tight.
    const f = twoLegFixture();
    f.board.set("X", [{ stopId: "X", tripId: "T2", routeId: "R2", seq: 1, time: NOW + 420, live: false }]);
    expect(planWithTransfers(opts(f))).toHaveLength(0);
  });

  it("does not crash when a direct walk is offered alongside transfers", () => {
    // The second-leg search used to inherit directWalkSeconds and could answer
    // with a walk-only itinerary; reading rides[0] off it threw, and the UI
    // reported "no route" for every search.
    const f = twoLegFixture();
    expect(() => planWithTransfers({ ...opts(f), directWalkSeconds: 900 })).not.toThrow();
  });

  it("still ranks a short walk above a two-leg transfer", () => {
    const f = twoLegFixture();
    const got = planWithTransfers({ ...opts(f), directWalkSeconds: 240 });
    expect(got[0]!.rides).toHaveLength(0);
  });

  it("degrades to direct-only when maxTransfers is 0", () => {
    const f = twoLegFixture();
    expect(planWithTransfers({ ...opts(f), maxTransfers: 0 })).toEqual([]);
  });
});
