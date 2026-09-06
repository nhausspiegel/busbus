import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { haversineMeters, nearestStops, decodePolyline6, parseWalkRoute , walkLegs , walkSeconds, walkRoute, resetValhalla, cooldownMs , parseOsrmRoute, stablePosition, walkMatrixMulti } from "../src/routing/walk";
import type { Stop } from "../src/data/types";

const s = (id: string, lat: number, lng: number): Stop => ({ id, name: id, lat, lng });

describe("parseWalkRoute", () => {
  // A real Valhalla pedestrian response, frozen. The same call already supplied
  // the drawn walking line and threw the maneuvers away.
  const raw = JSON.parse(readFileSync("test/fixtures/valhalla-walk-route.json", "utf8"));
  const got = parseWalkRoute(raw);

  it("reads the walking directions out of the response the map already fetched", () => {
    expect(got.steps.length).toBe(19);
    expect(got.steps[0]!.instruction).toBe("Walk west on the walkway.");
    expect(got.steps[got.steps.length - 1]!.instruction)
      .toBe("You have arrived at your destination.");
  });

  it("converts Valhalla's kilometres to metres", () => {
    // `length` is 0.008 for the first maneuver and `units` is "kilometers".
    // Passing that through as metres would tell a rider to walk 8mm.
    expect(got.steps[0]!.metres).toBeCloseTo(8, 0);
    const total = got.steps.reduce((m, x) => m + x.metres, 0);
    expect(total).toBeGreaterThan(1200);      // the trip summary says 1.265 km
    expect(total).toBeLessThan(1350);
  });

  it("still returns the drawable line", () => {
    expect(got.path.length).toBeGreaterThan(10);
    expect(got.path[0]!.lat).toBeGreaterThan(41.7);
    expect(got.path[0]!.lat).toBeLessThan(41.9);
  });

  it("returns nothing usable rather than throwing on an empty response", () => {
    expect(parseWalkRoute({})).toEqual({ path: [], steps: [] });
  });
});

describe("haversineMeters", () => {
  it("measures a known campus distance within tolerance", () => {
    // John Hay Library -> South Street Landing, ~0.95 km straight line.
    const d = haversineMeters({ lat: 41.826195, lng: -71.404656 }, { lat: 41.817892, lng: -71.406899 });
    expect(d).toBeGreaterThan(850);
    expect(d).toBeLessThan(1100);
  });

  it("is zero for identical points", () => {
    expect(haversineMeters({ lat: 41.8, lng: -71.4 }, { lat: 41.8, lng: -71.4 })).toBe(0);
  });
});

describe("nearestStops", () => {
  const stops = [s("far", 41.90, -71.40), s("near", 41.8262, -71.4047), s("mid", 41.84, -71.40)];

  it("returns the k closest, closest first", () => {
    const got = nearestStops({ lat: 41.826195, lng: -71.404656 }, stops, 2);
    expect(got.map((x) => x.id)).toEqual(["near", "mid"]);
  });

  it("returns everything when k exceeds the stop count", () => {
    expect(nearestStops({ lat: 41.826, lng: -71.404 }, stops, 99)).toHaveLength(3);
  });

  it("returns empty for no stops rather than throwing", () => {
    // Happens when the feed fails to load; the UI must degrade, not crash.
    expect(nearestStops({ lat: 41.8, lng: -71.4 }, [], 5)).toEqual([]);
  });
});

/** Encode at precision 6, the way Valhalla does, so the test exercises a real
 *  round trip instead of a magic string. The previous fixture string actually
 *  decoded to southern Spain, which is why an `abs(lat) < 90` assertion passed
 *  while proving nothing. */
function encodePolyline6(points: { lat: number; lng: number }[]): string {
  let out = "", prevLat = 0, prevLng = 0;
  const chunk = (v: number) => {
    let s = v < 0 ? ~(v << 1) : v << 1;
    let r = "";
    while (s >= 0x20) { r += String.fromCharCode((0x20 | (s & 0x1f)) + 63); s >>= 5; }
    return r + String.fromCharCode(s + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e6), lng = Math.round(p.lng * 1e6);
    out += chunk(lat - prevLat) + chunk(lng - prevLng);
    prevLat = lat; prevLng = lng;
  }
  return out;
}

describe("decodePolyline6", () => {
  it("round-trips Providence coordinates at precision 6", () => {
    const path = [
      { lat: 41.826195, lng: -71.404656 },   // John Hay Library
      { lat: 41.823132, lng: -71.408373 },   // Dyer & Hay
      { lat: 41.817892, lng: -71.406899 },   // South Street Landing
    ];
    const got = decodePolyline6(encodePolyline6(path));
    expect(got).toHaveLength(3);
    got.forEach((p, i) => {
      expect(p.lat).toBeCloseTo(path[i]!.lat, 5);
      expect(p.lng).toBeCloseTo(path[i]!.lng, 5);
    });
  });

  it("decoded at precision 5 the same string would land nowhere near Providence", () => {
    // Guards the actual mistake: Valhalla uses 1e6, most polyline code uses
    // 1e5, and getting it wrong silently draws the walk in another hemisphere.
    const encoded = encodePolyline6([{ lat: 41.826195, lng: -71.404656 }]);
    const wrong = decodePolyline6(encoded).map((p) => ({ lat: p.lat * 10, lng: p.lng * 10 }));
    expect(Math.abs(wrong[0]!.lat)).toBeGreaterThan(90);
  });

  it("returns empty for an empty string", () => {
    expect(decodePolyline6("")).toEqual([]);
  });
});

describe("walkLegs", () => {
  const a = { lat: 41.82, lng: -71.40 };
  const b = { lat: 41.83, lng: -71.41 };
  const c = { lat: 41.84, lng: -71.42 };
  const routed = [{ lat: 41.821, lng: -71.401 }, { lat: 41.825, lng: -71.405 }, b];

  it("draws a leg for every leg, even when nothing routes", () => {
    // The bug: the walk paths were filtered on "did any come back non-empty"
    // and setOverlay was skipped when none did, so a rider already standing at
    // the boarding stop -- or one leg that Valhalla could not route -- left the
    // straight guess on screen permanently with no way to replace it.
    const got = walkLegs([{ from: a, to: b }, { from: b, to: c }], [null, null]);
    expect(got).toHaveLength(2);
    expect(got.every((l) => l.provisional)).toBe(true);
    expect(got[0]!.path).toEqual([a, b]);
  });

  it("keeps a routed leg real when the other one fails", () => {
    // One verdict shared between both legs meant a single failure drew BOTH as
    // straight lines through the buildings.
    const got = walkLegs([{ from: a, to: b }, { from: b, to: c }], [routed, null]);
    expect(got[0]).toEqual({ path: routed, provisional: false });
    expect(got[1]).toEqual({ path: [b, c], provisional: true });
  });

  it("treats a path too short to draw as unrouted", () => {
    expect(walkLegs([{ from: a, to: b }], [[a]])[0]!.provisional).toBe(true);
  });
});

describe("the Valhalla request layer", () => {
  // valhalla1.openstreetmap.de is volunteer-run and throttles. Measured on
  // 2026-08-24: the first request of a pin drop came back as
  // `TypeError: Failed to fetch` in 100ms, because a throttled response
  // arrives without CORS headers and the browser cannot read its status. It
  // reads as an outage and is not one, so the old code retried straight into
  // it and stayed throttled.
  const ok = { sources_to_targets: [[{ time: 120 }]] };
  let calls = 0;
  const original = globalThis.fetch;

  const serve = (impl: () => Promise<unknown>) => {
    globalThis.fetch = (async () => {
      calls++;
      return impl();
    }) as typeof fetch;
  };
  const good = () => serve(async () =>
    ({ ok: true, json: async () => ok }) as unknown as Response);
  const throttled = () => serve(async () => { throw new TypeError("Failed to fetch"); });

  beforeEach(() => { resetValhalla(); calls = 0; });
  afterEach(() => { globalThis.fetch = original; });

  const A = { lat: 41.826, lng: -71.400 };
  const B = { lat: 41.830, lng: -71.405 };
  /** The router a walk request actually goes to first. */
  const OSRM = "https://routing.openstreetmap.de/routed-foot";
  const VALHALLA = "https://valhalla1.openstreetmap.de";

  it("asks the same question only once", async () => {
    good();
    await walkSeconds(A, B);
    await walkSeconds(A, B);
    expect(calls).toBe(1);
  });

  it("collapses simultaneous callers into one request", async () => {
    good();
    await Promise.all([walkSeconds(A, B), walkSeconds(A, B), walkSeconds(A, B)]);
    expect(calls).toBe(1);
  });

  it("still asks about a different walk", async () => {
    good();
    await walkSeconds(A, B);
    await walkSeconds(B, A);
    expect(calls).toBe(2);
  });

  it("rests after a failure instead of retrying into the wall", async () => {
    throttled();
    await expect(walkRoute(A, B)).rejects.toThrow();
    // Both routers were tried and both refused.
    expect(calls).toBe(2);
    expect(cooldownMs(OSRM)).toBeGreaterThan(0);
    // The second attempt must not reach the network at all.
    await expect(walkRoute(A, B)).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it("rests each router on its own record", async () => {
    // The bug this replaces: one shared cooldown meant a failure from the DEAD
    // router put the healthy one to sleep for up to a minute, which destroys
    // the entire point of having two. Valhalla returned HTTP 000 all
    // afternoon, so every fallback poisoned OSRM -- and the legs that could
    // not be routed meanwhile are exactly the ghost lines that kept appearing.
    globalThis.fetch = (async (u: unknown) => {
      calls++;
      if (String(u).includes("routed-foot")) throw new TypeError("Failed to fetch");
      return { ok: true, json: async () => ({
        trip: { legs: [{ shape: "_p~iF~ps|U", maneuvers: [] }] },
      }) } as unknown as Response;
    }) as typeof fetch;

    await walkRoute(A, B);                       // OSRM fails, Valhalla answers
    expect(cooldownMs(OSRM)).toBeGreaterThan(0); // the one that failed rests
    expect(cooldownMs(VALHALLA)).toBe(0);        // the one that worked does not
  });

  it("never caches a failure", async () => {
    throttled();
    await expect(walkRoute(A, B)).rejects.toThrow();
    // Once the server is willing again the same question must be free to
    // succeed -- a cached rejection would make the failure permanent.
    resetValhalla();
    good();
    await expect(walkRoute(A, B)).resolves.toBeTruthy();
  });

});

describe("parseOsrmRoute", () => {
  // A real response, captured 2026-08-24 from FOSSGIS's routed-foot for
  // Address J -> Trader Joe's. Frozen, because tests never call a
  // volunteer-run service.
  const captured = JSON.parse(readFileSync("test/fixtures/osrm-walk-route.json", "utf8"));

  it("reads the shape as [lng, lat], the way GeoJSON writes it", () => {
    const { path } = parseOsrmRoute(captured);
    expect(path.length).toBeGreaterThan(50);
    // Providence, not the Indian Ocean.
    for (const p of [path[0]!, path[path.length - 1]!]) {
      expect(p.lat).toBeGreaterThan(41.7);
      expect(p.lat).toBeLessThan(41.9);
      expect(p.lng).toBeLessThan(-71.3);
    }
  });

  it("turns a maneuver into something a rider could follow", () => {
    // OSRM gives a type and a modifier, never a sentence.
    const { steps } = parseOsrmRoute(captured);
    expect(steps.length).toBeGreaterThan(3);
    expect(steps.every((s) => s.instruction.length > 0)).toBe(true);
    expect(steps.some((s) => /Brown Street|Power Street/.test(s.instruction))).toBe(true);
    expect(steps.every((s) => !/undefined|\[object/.test(s.instruction))).toBe(true);
  });

  it("drops the connector steps no one would call a turn", () => {
    // The captured route has 5m and 7m hops between sidewalk segments. Read
    // aloud they are noise, and they push the real turns off the screen.
    const { steps } = parseOsrmRoute(captured);
    const tiny = steps.filter((s) => s.metres < 5 && !/Arrive/.test(s.instruction));
    expect(tiny).toEqual([]);
    expect(steps.some((s) => /Arrive/.test(s.instruction))).toBe(true);
  });

  it("returns nothing rather than throwing on a shape it does not know", () => {
    expect(parseOsrmRoute({})).toEqual({ path: [], steps: [] });
    expect(parseOsrmRoute(null)).toEqual({ path: [], steps: [] });
  });
});

describe("stablePosition", () => {
  /**
   * The walk-matrix cache is keyed on the request body, so the origin's
   * coordinates ARE the cache key. Geolocation reports a fresh fix every few
   * seconds and the low digits move whether or not the rider has, so an
   * unrounded origin produces a new key -- and a real request to a volunteer
   * router -- on a cadence nobody asked for.
   *
   * Snapping to about ten metres is what lets the trip be re-planned on every
   * board poll for free. Ten metres of walking is a few seconds against walks
   * measured in minutes.
   */
  it("collapses a jittering fix to one point", () => {
    const a = stablePosition({ lat: 41.82650, lng: -71.40250 });
    const b = stablePosition({ lat: 41.826504, lng: -71.402497 });
    expect(b).toEqual(a);
  });

  it("still moves when the rider does", () => {
    const a = stablePosition({ lat: 41.82650, lng: -71.40250 });
    const b = stablePosition({ lat: 41.82750, lng: -71.40250 });   // ~111m
    expect(b).not.toEqual(a);
    expect(haversineMeters(a, b)).toBeGreaterThan(100);
  });

  it("never moves a fix far enough to matter", () => {
    for (const p of [
      { lat: 41.826499, lng: -71.402501 },
      { lat: 41.833333, lng: -71.411111 },
      { lat: 41.820001, lng: -71.399999 },
    ]) expect(haversineMeters(p, stablePosition(p))).toBeLessThan(8);
  });
});

/** When both routers are unreachable the app still ranks trips, on a
 *  straight-line estimate. That is the right call -- showing nothing is worse
 *  -- but the rider was then handed those minutes styled exactly like measured
 *  ones. A `walkTimesAreEstimated()` flag existed for this and had zero
 *  callers, which was the appearance of the honesty rather than the thing. */
describe("walkMatrixMulti says when it fell back to an estimate", () => {
  const original = globalThis.fetch;
  afterEach(() => { globalThis.fetch = original; resetValhalla(); });

  const A = { lat: 41.826, lng: -71.400 };
  const B = { lat: 41.830, lng: -71.405 };

  it("reports measured when a router answers", async () => {
    globalThis.fetch = (async () => ({
      ok: true, status: 200,
      json: async () => ({ sources_to_targets: [[{ time: 123 }]] }),
    })) as never;
    const got = await walkMatrixMulti([A], [B]);
    expect(got.estimated).toBe(false);
    expect(got.rows[0]![0]).toBe(123);
  });

  it("reports estimated when both routers are unreachable", async () => {
    globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as never;
    const got = await walkMatrixMulti([A], [B]);
    expect(got.estimated).toBe(true);
    // Still answers, so trips can be ranked rather than the rider shown nothing.
    expect(got.rows[0]![0]).toBeGreaterThan(0);
  });
});

/**
 * Which router is asked FIRST for a matrix, and why it matters.
 *
 * Measured 2026-09-06 against both live instances, same 2-source matrix:
 *
 *     targets        4       8      16      22
 *     OSRM table   8788ms  8809ms  8801ms  8816ms   (3 repeats: 8800/8798/8807)
 *     Valhalla      588ms   146ms   137ms   232ms   (3 repeats:  179/149/148)
 *
 * OSRM's time is FLAT in the number of targets, so it is a server-side throttle
 * on the table service rather than the size of the question. It is not failing
 * -- it answers 200 -- so no fallback rule catches it, and route calculation
 * took the better part of ten seconds because the app asked the slow one first
 * and the fast one only on error.
 */
describe("the walk matrix asks the fast router first", () => {
  const original = globalThis.fetch;
  afterEach(() => { globalThis.fetch = original; resetValhalla(); });

  const A = { lat: 41.826, lng: -71.400 };
  const B = { lat: 41.830, lng: -71.405 };

  const record = () => {
    const hits: string[] = [];
    globalThis.fetch = (async (u: unknown) => {
      hits.push(String((u as { url?: string })?.url ?? u));
      return { ok: true, status: 200,
               json: async () => ({ sources_to_targets: [[{ time: 111 }]] }) };
    }) as never;
    return hits;
  };

  it("goes to Valhalla before OSRM", async () => {
    const hits = record();
    const got = await walkMatrixMulti([A], [B]);
    expect(hits[0]).toMatch(/valhalla/i);
    expect(got.rows[0]![0]).toBe(111);
    expect(got.estimated).toBe(false);
  });

  it("does not touch OSRM at all when Valhalla answers", async () => {
    const hits = record();
    await walkMatrixMulti([A], [B]);
    expect(hits.some((h) => /routed-foot|osrm/i.test(h))).toBe(false);
  });

  it("still falls back to OSRM when Valhalla fails", async () => {
    // The two-router rule stands: one host going down must not take directions
    // with it. That is why Valhalla is not simply swapped in as the only one.
    const hits: string[] = [];
    globalThis.fetch = (async (u: unknown) => {
      const url = String((u as { url?: string })?.url ?? u);
      hits.push(url);
      if (/valhalla/i.test(url)) throw new TypeError("Failed to fetch");
      return { ok: true, status: 200, json: async () => ({ durations: [[222]] }) };
    }) as never;
    const got = await walkMatrixMulti([A], [B]);
    expect(hits[0]).toMatch(/valhalla/i);
    expect(hits.some((h) => /routed-foot/i.test(h))).toBe(true);
    expect(got.rows[0]![0]).toBe(222);
    expect(got.estimated).toBe(false);
  });
});

describe("a router that answers 200 with nothing usable", () => {
  const original = globalThis.fetch;
  afterEach(() => { globalThis.fetch = original; resetValhalla(); });

  it("falls through to the other router instead of answering with nulls", async () => {
    // The failure that started all this was a router SUCCEEDING uselessly, not
    // failing. An empty 200 used to produce a matrix of nulls, which leaves the
    // planner with no walking times and hands the rider a walk with no
    // explanation -- indistinguishable, from the outside, from "no bus".
    const hits: string[] = [];
    globalThis.fetch = (async (u: unknown) => {
      const url = String((u as { url?: string })?.url ?? u);
      hits.push(url);
      if (/valhalla/i.test(url)) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ durations: [[321]] }) };
    }) as never;
    const got = await walkMatrixMulti([{ lat: 41.826, lng: -71.4 }], [{ lat: 41.83, lng: -71.405 }]);
    expect(hits.some((h) => /routed-foot/i.test(h))).toBe(true);
    expect(got.rows[0]![0]).toBe(321);
    expect(got.estimated).toBe(false);
  });
});
