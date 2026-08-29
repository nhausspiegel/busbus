import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { parseStaticFeed } from "../src/data/gtfs";
import { planBetween } from "../src/routing/trip";
import { resetValhalla, stablePosition } from "../src/routing/walk";

/**
 * Re-planning on every board poll has to be free.
 *
 * The board used to be a dependency of the planning effect, and it was taken
 * out for a measured reason: the trip was re-planned every thirty seconds,
 * asked a volunteer-run router for walking times every time, and a throttled
 * response -- which arrives without CORS headers, so the browser reports a
 * network error rather than a 429 -- was caught and shown to the rider as
 * "No shuttle route" while a perfectly good list sat underneath.
 *
 * The itineraries still have to refresh, because every one of them is built
 * from live departures and stops being true when those move. So the repeat
 * plan must reach the cache instead of the network. The cache is keyed on the
 * request, and the request carries the origin's coordinates, which is why the
 * position is snapped before it is used.
 */
const feed = parseStaticFeed(new Uint8Array(readFileSync("public/gtfs/google_transit.zip")));
const ANGELL = { lat: 41.82661, lng: -71.40082 };
const RIVER = { lat: 41.82031, lng: -71.40934 };

let calls = 0;
const original = globalThis.fetch;

beforeEach(() => {
  resetValhalla();
  calls = 0;
  globalThis.fetch = (async (u: unknown) => {
    calls++;
    // OSRM /table: a duration for every source/target pair.
    const n = String(u).split(";").length;
    return {
      ok: true,
      json: async () => ({ durations: [Array(n).fill(240), Array(n).fill(240)] }),
    } as unknown as Response;
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = original; });

const plan = (origin: { lat: number; lng: number }) =>
  planBetween(feed, new Map(), stablePosition(origin), RIVER, new Date());

describe("re-planning while the rider stands still", () => {
  it("sends nothing the second time", async () => {
    await plan(ANGELL);
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);        // it really did ask once

    // Three more polls, each with a fresh geolocation fix a metre or two off.
    await plan({ lat: 41.826612, lng: -71.400823 });
    await plan({ lat: 41.826605, lng: -71.400811 });
    await plan({ lat: 41.826618, lng: -71.400829 });
    expect(calls).toBe(afterFirst);
  });

  it("asks again once the rider has actually moved", async () => {
    // The control. Without this the test above would pass on a planner that
    // never asks anything at all.
    await plan(ANGELL);
    const afterFirst = calls;
    await plan({ lat: 41.8285, lng: -71.4035 });   // ~300m
    expect(calls).toBeGreaterThan(afterFirst);
  });
});
