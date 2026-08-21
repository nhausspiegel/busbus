/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type { LatLng, StaticFeed } from "../src/data/types";

/**
 * A MapLibre stand-in, so a test can see what the component actually draws.
 *
 * These two tests exist to stop one specific thing coming back. There used to
 * be machinery that fanned coincident routes into parallel lanes by rewriting
 * their coordinates, and that projected each bus onto the rewritten line. Every
 * revision of it put the lines further off their streets, because it assumed
 * the published shape sits on the street centreline -- Brown's do not, the two
 * Evening loops are already about 7m apart, one per side of the road. The lines
 * and the buses now use the coordinates Passio publishes, full stop.
 */
class FakeMap {
  handlers = new Map<string, ((e?: unknown) => void)[]>();
  sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>();
  layers = new Set<string>();

  on(ev: string, a: unknown, b?: unknown) {
    const fn = (typeof a === "function" ? a : b) as (e?: unknown) => void;
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
  }
  once(ev: string, fn: (e?: unknown) => void) { this.on(ev, fn); }
  fire(ev: string, e?: unknown) {
    act(() => { for (const fn of this.handlers.get(ev) ?? []) fn(e); });
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
  setPaintProperty() {}
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

/** Two routes down the same street. This is the case the offsetting existed
 *  for, so it is the case that must still come out unmodified. */
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
      focus={null} highlightRouteId={null} activeRouteIds={new Set(["A", "B"])} />);

  it("draws every route on the shape Passio published, coordinate for coordinate", () => {
    mount();
    map.fire("load");
    const features = (map.getSource("routes") as { data: GeoJSON.FeatureCollection })
      .data.features;
    for (const id of ["A", "B"]) {
      const f = features.find((q) => q.properties?.["routeId"] === id);
      expect((f!.geometry as GeoJSON.LineString).coordinates)
        .toEqual(feed.routes.get(id)!.shape.map((p) => [p.lng, p.lat]));
    }
  });

  it("puts each bus on the line drawn for its own route", () => {
    // The feed puts this bus off its shape, as a real GPS fix does. It has to
    // land ON the polyline -- and on the polyline as DRAWN, which is the raw
    // shape, so this holds at every zoom without the map's scale entering into
    // it anywhere.
    mount();
    map.fire("load");
    const [lng, lat] = markers[0]!.lngLat;
    const shape = feed.routes.get("A")!.shape;
    let nearest = Infinity;
    for (let i = 1; i < shape.length; i++) {
      const a = shape[i - 1]!, b = shape[i]!;
      const k = 111_320, kx = k * Math.cos(a.lat * Math.PI / 180);
      const dx = (b.lng - a.lng) * kx, dy = (b.lat - a.lat) * k;
      const px = (lng - a.lng) * kx, py = (lat - a.lat) * k;
      const len = dx * dx + dy * dy;
      const t = len === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len));
      nearest = Math.min(nearest, Math.hypot(px - dx * t, py - dy * t));
    }
    expect(nearest).toBeLessThan(0.5);
    // ...and genuinely moved, so this cannot pass by the bus already being there.
    expect(Math.abs(lat - 41.8228) + Math.abs(lng - -71.4002)).toBeGreaterThan(1e-6);
  });

  it("gives every route its own lane, centred on zero", () => {
    // Two routes down one street collapse into one line when zoomed out, where
    // the ~7m their shapes already differ by is under a pixel. The lane is
    // spent by line-offset, in PIXELS, and faded out by z16 where the shapes
    // separate on their own -- so no coordinate moves and a route running
    // alone at street zoom sits exactly on its street.
    mount();
    map.fire("load");
    const lanes = (map.getSource("routes") as { data: GeoJSON.FeatureCollection })
      .data.features.map((f) => f.properties?.["lane"] as number);
    expect(new Set(lanes).size).toBe(lanes.length);          // all distinct
    expect(lanes.reduce((a, b) => a + b, 0)).toBeCloseTo(0);  // centred
  });

  it("deselects when the map is tapped, so Back is not the only way out", () => {
    // Selecting a route and then having to find a small Back button to leave it
    // is the wrong way round: Apple Maps drops the selection when you tap the
    // map. A tap that lands on a stop or a place must still select that,
    // which is what the hit test above this guards.
    const onDeselect = vi.fn();
    render(
      <TransitMap feed={feed} buses={buses} me={null} destination={null} overlay={null}
        focus={null} highlightRouteId="A" activeRouteIds={new Set(["A", "B"])}
        onDeselect={onDeselect} />);
    map.fire("load");
    map.fire("click", { point: { x: 10, y: 10 }, lngLat: { lat: 41.82, lng: -71.4 } });
    expect(onDeselect).toHaveBeenCalled();
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
      focus={null} highlightRouteId={null} activeRouteIds={new Set(["A", "B"])} />);
  const rerenderAt = (r: ReturnType<typeof render>, lat: number) => r.rerender(
    <TransitMap feed={feed} buses={at(lat)} me={null} destination={null} overlay={null}
      focus={null} highlightRouteId={null} activeRouteIds={new Set(["A", "B"])} />);

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
