/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type { LatLng, StaticFeed } from "../src/data/types";

/**
 * A MapLibre stand-in, so a test can see what the component actually draws.
 *
 * The bundling in src/render/bundle.ts moves route coordinates on purpose, so
 * these tests check the two things that must hold once it has: routes sharing
 * a street come out separated, and every bus sits on the line as DRAWN rather
 * than on the raw shape. Drawing one geometry while snapping to another is how
 * buses ended up beside their own routes for a long time, and it survived every
 * check that compared a marker against the shape instead of against the line
 * the rider can actually see.
 */
class FakeMap {
  handlers = new Map<string, ((e?: unknown) => void)[]>();
  sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>();
  layers = new Set<string>();

  // Layer-scoped handlers are kept apart from map-level ones, because
  // MapLibre only calls m.on("click", "some-layer", fn) when the click
  // actually lands on that layer. Lumping both under "click" made every layer
  // handler fire on every map click, which is the opposite of the dispatch
  // this component's long-press guard has to cope with.
  on(ev: string, a: unknown, b?: unknown) {
    const layer = typeof a === "string" ? a : null;
    const fn = (typeof a === "function" ? a : b) as (e?: unknown) => void;
    const key = layer ? `${ev}:${layer}` : ev;
    this.handlers.set(key, [...(this.handlers.get(key) ?? []), fn]);
  }
  once(ev: string, fn: (e?: unknown) => void) { this.on(ev, fn); }
  fire(ev: string, e?: unknown) {
    act(() => { for (const fn of this.handlers.get(ev) ?? []) fn(e); });
  }
  /** A click that landed on `layer`. MapLibre runs these before the
   *  map-level handler for the same click. */
  fireLayer(ev: string, layer: string, e?: unknown) {
    act(() => { for (const fn of this.handlers.get(`${ev}:${layer}`) ?? []) fn(e); });
  }

  isStyleLoaded() { return true; }
  getZoom() { return 14.2; }
  getSource(id: string) { return this.sources.get(id); }
  addSource(id: string, spec: { data: unknown }) {
    const entry = { data: spec.data, setData(d: unknown) { entry.data = d; } };
    this.sources.set(id, entry);
  }
  removeSource(id: string) { this.sources.delete(id); }
  getLayer(id: string) { return this.layers.has(id) ? { id } : undefined; }
  addLayer(spec: { id: string }) { this.layers.add(spec.id); }
  removeLayer(id: string) { this.layers.delete(id); }
  /** Recorded, not discarded. Paint is where this component says almost
   *  everything it says, and a mock that swallows it cannot catch a symbol
   *  drawn at the wrong size. */
  paint = new Map<string, unknown>();
  setPaintProperty(layer: string, prop: string, value: unknown) {
    this.paint.set(`${layer}.${prop}`, value);
  }
  setFilter() {}
  setStyle() {}
  addControl() {}
  queryRenderedFeatures() { return []; }
  getCanvas() { return { style: {} }; }
  fitBounds() {}
  resize() {}
  remove() {}
}

const markers: FakeMarker[] = [];
class FakeMarker {
  lngLat: [number, number] = [0, 0];
  constructor(public opts: { element: HTMLElement }) { markers.push(this); }
  setLngLat(v: [number, number]) { this.lngLat = v; return this; }
  getLngLat() { return { lng: this.lngLat[0], lat: this.lngLat[1] }; }
  addTo() { return this; }
  remove() { return this; }
  getElement() { return this.opts.element; }
}

let map: FakeMap;
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
/** Runs every frame queued so far, at time `now`. */
const tick = (now: number) => {
  const due = [...frames.values()];
  frames.clear();
  act(() => { for (const cb of due) cb(now); });
};
vi.mock("maplibre-gl", () => ({
  setWorkerUrl: () => {},
  Map: class { constructor() { return map as unknown as object; } },
  Marker: class { constructor(o: { element: HTMLElement }) { return new FakeMarker(o) as unknown as object; } },
  AttributionControl: class {},
  LngLatBounds: class { extend() {} },
}));
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));

const { TransitMap } = await import("../src/ui/TransitMap");

/** Two routes down the same street, traced in opposite directions -- the case
 *  the bundler exists for, and the one that used to send both to the same side. */
const line = (lat0: number, lng: number, n = 12): LatLng[] =>
  Array.from({ length: n }, (_, i) => ({ lat: lat0 + i * 0.0002, lng }));

const feed = {
  routes: new Map([
    ["A", { id: "A", name: "A", color: "#ff0000", shape: line(41.82, -71.4) }],
    ["B", { id: "B", name: "B", color: "#00ff00", shape: [...line(41.82, -71.4)].reverse() }],
  ]),
  stops: new Map(),
  trips: new Map(),
} as unknown as StaticFeed;

/** Deliberately off the shape, the way a real GPS fix is. */
const buses = [{
  id: "bus1", routeId: "A", lat: 41.8228, lng: -71.4002,
  label: "1", bearing: 0, paxLoad: 0, totalCap: 0,
}] as never;

let reduceMotion = false;

beforeEach(() => {
  map = new FakeMap();
  markers.length = 0;
  frames.clear();
  nextFrame = 1;
  reduceMotion = false;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frames.set(nextFrame, cb); return nextFrame++;
  }) as never;
  globalThis.cancelAnimationFrame = ((h: number) => { frames.delete(h); }) as never;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} } as never;
  window.matchMedia = ((q: string) => ({
    matches: q.includes("reduced-motion") ? reduceMotion : false,
    addEventListener() {}, removeEventListener() {},
  })) as never;
});
afterEach(cleanup);

describe("TransitMap", () => {
  const mount = () => render(
    <TransitMap feed={feed} buses={buses} me={null} destination={null} overlay={null}
      focus={null} selection={null} activeRouteIds={new Set(["A", "B"])} />);

  /** Metres from a point to a drawn route feature. */
  const toDrawn = (routeId: string, lng: number, lat: number) => {
    const f = (map.getSource("routes") as { data: GeoJSON.FeatureCollection })
      .data.features.find((q) => q.properties?.["routeId"] === routeId);
    const line = (f!.geometry as GeoJSON.LineString).coordinates;
    let nearest = Infinity;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!, b = line[i]!;
      const k = 111_320, kx = k * Math.cos(a[1]! * Math.PI / 180);
      const dx = (b[0]! - a[0]!) * kx, dy = (b[1]! - a[1]!) * k;
      const px = (lng - a[0]!) * kx, py = (lat - a[1]!) * k;
      const len = dx * dx + dy * dy;
      const t = len === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len));
      nearest = Math.min(nearest, Math.hypot(px - dx * t, py - dy * t));
    }
    return nearest;
  };

  it("separates two routes that share a street", () => {
    // A and B are the same street traced twice, in opposite directions. Drawn
    // straight from Passio's coordinates they land on top of each other and
    // read as one line; src/render/bundle.ts pushes them apart by a minimum
    // gap measured in screen pixels.
    mount();
    map.fire("load");
    const b = (map.getSource("routes") as { data: GeoJSON.FeatureCollection })
      .data.features.find((q) => q.properties?.["routeId"] === "B");
    const mid = (b!.geometry as GeoJSON.LineString).coordinates[6]!;
    expect(toDrawn("A", mid[0]!, mid[1]!)).toBeGreaterThan(1);
  });

  it("puts each bus on the line drawn for its own route", () => {
    // The feed puts this bus off its shape, as a real GPS fix does, and the
    // drawn line is not the raw shape -- it has been bundled into a lane and
    // its corners rounded. The bus must sit on what was DRAWN. Snapping to one
    // geometry while drawing another is exactly how buses ended up beside
    // their own route.
    mount();
    map.fire("load");
    const [lng, lat] = markers[0]!.lngLat;
    expect(toDrawn("A", lng, lat)).toBeLessThan(0.5);
    // ...and genuinely moved, so this cannot pass by the bus already being there.
    expect(Math.abs(lat - 41.8228) + Math.abs(lng - -71.4002)).toBeGreaterThan(1e-6);
  });

  it("deselects when the map is tapped, so Back is not the only way out", () => {
    // Selecting a route and then having to find a small Back button to leave it
    // is the wrong way round: Apple Maps drops the selection when you tap the
    // map. A tap that lands on a stop or a place must still select that,
    // which is what the hit test above this guards.
    const onDeselect = vi.fn();
    render(
      <TransitMap feed={feed} buses={buses} me={null} destination={null} overlay={null}
        focus={null} selection={{ kind: "route", id: "A" }} activeRouteIds={new Set(["A", "B"])}
        onDeselect={onDeselect} />);
    map.fire("load");
    map.fire("click", { point: { x: 10, y: 10 }, lngLat: { lat: 41.82, lng: -71.4 } });
    expect(onDeselect).toHaveBeenCalled();
  });

  it("does not deselect on the click that ends a long press", () => {
    // A long press drops a pin; releasing it produces a click as well, and
    // that click used to run the deselect handler -- so letting go threw away
    // the pin the press had just dropped, and the directions planned for it.
    vi.useFakeTimers();
    try {
      const onMapClick = vi.fn();
      const onDeselect = vi.fn();
      render(
        <TransitMap feed={feed} buses={buses} me={null} destination={null} overlay={null}
          focus={null} selection={null} activeRouteIds={new Set(["A", "B"])}
          onMapClick={onMapClick} onDeselect={onDeselect} />);
      map.fire("load");

      const at = { point: { x: 10, y: 10 }, lngLat: { lat: 41.82, lng: -71.4 } };
      map.fire("mousedown", at);
      act(() => { vi.advanceTimersByTime(600); });     // past LONG_PRESS_MS
      expect(onMapClick).toHaveBeenCalledTimes(1);     // the pin was dropped
      map.fire("mouseup", at);
      map.fire("click", at);
      expect(onDeselect).not.toHaveBeenCalled();       // and survives the release

      // A plain tap afterwards must still deselect.
      map.fire("click", at);
      expect(onDeselect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not select a route with the click that ends a long press", () => {
    // MapLibre dispatches layer handlers independently of the map-level one,
    // so guarding only the map handler was not enough: a long press over a
    // route line dropped its pin AND the trailing click selected the route
    // under the finger, leaving the old route page open on top of the new
    // destination. Measured in the browser -- the sheet showed "To Dropped
    // pin" and the Evening CCW Route page at the same time.
    vi.useFakeTimers();
    try {
      const onMapClick = vi.fn();
      const onRouteClick = vi.fn();
      render(
        <TransitMap feed={feed} buses={buses} me={null} destination={null} overlay={null}
          focus={null} selection={null} activeRouteIds={new Set(["A", "B"])}
          onMapClick={onMapClick} onRouteClick={onRouteClick} />);
      map.fire("load");

      const at = { point: { x: 10, y: 10 }, lngLat: { lat: 41.82, lng: -71.4 } };
      map.fire("mousedown", at);
      act(() => { vi.advanceTimersByTime(600); });
      expect(onMapClick).toHaveBeenCalledTimes(1);
      map.fire("mouseup", at);
      // The layer handler runs before the map-level one, on the same click.
      map.fireLayer("click", "routes-hit", { ...at, features: [{ properties: { routeId: "A" } }] });
      map.fire("click", at);
      expect(onRouteClick).not.toHaveBeenCalled();

      // A plain tap on the line afterwards must still select it.
      map.fireLayer("click", "routes-hit", { ...at, features: [{ properties: { routeId: "A" } }] });
      expect(onRouteClick).toHaveBeenCalledWith("A");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the bus marker absolutely positioned, as MapLibre needs", () => {
    // MapLibre positions markers with a transform inside a positioned layer;
    // `.maplibregl-marker` is `position: absolute` for that reason. Setting the
    // element's cssText wholesale replaces that, and an inline
    // `position: relative` beats the stylesheet -- which drops every marker
    // into normal document flow, where they lay out side by side. Measured on
    // the live map: bus 1 was correct, bus 2 painted 30px right of its
    // coordinate, bus 3 60px, bus 4 90px, one marker width each. The dot needs
    // to be a positioning context for the heading arrow, and `absolute` is one
    // just as well as `relative` is.
    mount();
    map.fire("load");
    expect(markers[0]!.opts.element.style.position).toBe("absolute");
  });
});

/** Passio speaks once every ten seconds, so a marker set straight from the feed
 *  teleports the length of a block. These cover the glide that replaces that. */
describe("TransitMap live bus movement", () => {
  const at = (lat: number) => [{
    id: "bus1", routeId: "A", lat, lng: -71.4002,
    label: "1", bearing: 0, paxLoad: 0, totalCap: 0,
  }] as never;

  /** Mid-shape, so the next fix has line left to run along. */
  const start = 41.8210, next = 41.8216;

  const mountAt = (lat: number) => render(
    <TransitMap feed={feed} buses={at(lat)} me={null} destination={null} overlay={null}
      focus={null} selection={null} activeRouteIds={new Set(["A", "B"])} />);
  const rerenderAt = (r: ReturnType<typeof render>, lat: number) => r.rerender(
    <TransitMap feed={feed} buses={at(lat)} me={null} destination={null} overlay={null}
      focus={null} selection={null} activeRouteIds={new Set(["A", "B"])} />);

  it("glides to a new fix over the update interval instead of jumping", () => {
    const r = mountAt(start);
    map.fire("load");
    const mk = markers[0]!;
    expect(mk.lngLat[1]).toBeCloseTo(start, 6);

    act(() => rerenderAt(r, next));
    // Nothing has been painted yet: the marker must still be where it was.
    expect(mk.lngLat[1]).toBeCloseTo(start, 6);

    tick(0);                                    // first frame starts the clock
    expect(mk.lngLat[1]).toBeCloseTo(start, 6);
    tick(5_000);                                // halfway through the interval
    expect(mk.lngLat[1]).toBeCloseTo((start + next) / 2, 5);
    tick(10_000);                               // arrived
    expect(mk.lngLat[1]).toBeCloseTo(next, 6);
    expect(frames.size).toBe(0);                // and stopped asking for frames
  });

  it("jumps when the rider has asked for reduced motion", () => {
    reduceMotion = true;
    const r = mountAt(start);
    map.fire("load");
    act(() => rerenderAt(r, next));
    expect(markers[0]!.lngLat[1]).toBeCloseTo(next, 6);
    expect(frames.size).toBe(0);
  });

  it("drops a glide when a newer fix arrives, rather than running two at once", () => {
    const r = mountAt(start);
    map.fire("load");
    act(() => rerenderAt(r, next));
    tick(0);
    tick(5_000);
    act(() => rerenderAt(r, 41.8220));
    expect(frames.size).toBe(1);
  });

  it("stops asking for frames once the map is gone", () => {
    // A leaked loop keeps calling setLngLat on a marker the map has removed.
    const r = mountAt(start);
    map.fire("load");
    act(() => rerenderAt(r, next));
    expect(frames.size).toBe(1);
    act(() => r.unmount());
    expect(frames.size).toBe(0);
  });
});

describe("TransitMap walking overlay", () => {
  it("draws nothing for a leg it could not route", () => {
    // A straight dotted line between two points is a claim about a path that
    // was never found. Reported as "dotted ghost straight lines"; the same
    // rule as the timetable times -- prefer nothing to a guess.
    render(
      <TransitMap feed={feed} buses={buses} me={null} destination={null}
        focus={null} selection={null} activeRouteIds={new Set(["A", "B"])}
        overlay={{
          rides: [],
          walks: [
            { path: [{ lat: 41.82, lng: -71.40 }, { lat: 41.83, lng: -71.41 }], provisional: true },
            { path: [{ lat: 41.82, lng: -71.40 }, { lat: 41.821, lng: -71.401 },
                     { lat: 41.83, lng: -71.41 }], provisional: false },
          ],
        }} />);
    map.fire("load");
    const src = map.sources.get("itin-walk") as { data: { features: unknown[] } } | undefined;
    expect(src).toBeTruthy();
    expect(src!.data.features).toHaveLength(1);      // the routed leg only
    expect(map.layers.has("itin-walk-guess")).toBe(false);
  });

  it("adds no walk source at all when nothing routed", () => {
    render(
      <TransitMap feed={feed} buses={buses} me={null} destination={null}
        focus={null} selection={null} activeRouteIds={new Set(["A", "B"])}
        overlay={{ rides: [], walks: [
          { path: [{ lat: 41.82, lng: -71.40 }, { lat: 41.83, lng: -71.41 }], provisional: true },
        ] }} />);
    map.fire("load");
    expect(map.sources.get("itin-walk")).toBeUndefined();
  });
});

describe("the ends of a ride", () => {
  it("enlarges the real stops instead of drawing its own markers", () => {
    // An earlier version added bespoke circles for the boarding and alighting
    // stops, in their own radii and stroke widths, so the ends of a ride were
    // a different symbol from every other stop beside them on the same line.
    // The stop already on the map is the indicator.
    render(
      <TransitMap feed={feed} buses={buses} me={null} destination={null}
        focus={null} selection={null} activeRouteIds={new Set(["A", "B"])}
        overlay={{
          walks: [],
          rides: [{
            routeId: "A", color: "#111",
            path: [{ lat: 41.82, lng: -71.40 }, { lat: 41.83, lng: -71.41 }],
            boardStopId: "s1", alightStopId: "s2",
          }],
        }} />);
    map.fire("load");

    expect(map.layers.has("itin-end")).toBe(false);
    expect(map.layers.has("itin-end-dot")).toBe(false);
    expect(map.sources.get("itin-ends")).toBeUndefined();

    // The stop layer's own radius expression is what marks them.
    const radius = JSON.stringify(map.paint.get("stops.circle-radius") ?? "");
    expect(radius).toContain("s1");
    expect(radius).toContain("s2");
  });
});
