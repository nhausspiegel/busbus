/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type { LatLng, StaticFeed } from "../src/data/types";

/**
 * A MapLibre stand-in with one job: let a test drive the map's own events and
 * see what the component does about them.
 *
 * The bug it exists for: `isStyleLoaded()` is FALSE at the instant a zoom event
 * fires and only turns true a few hundred milliseconds later. Effects gated on
 * it therefore skipped every zoom, so the route geometry and the bus markers
 * kept whatever offset they were built with and only caught up when unrelated
 * data happened to arrive. On screen that is buses sitting beside their routes.
 */
class FakeMap {
  handlers = new Map<string, ((e?: unknown) => void)[]>();
  sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>();
  layers = new Set<string>();
  zoom = 14.2;
  /** The condition that caused the bug: mid-zoom, the style reports not loaded. */
  styleLoaded = true;

  on(ev: string, a: unknown, b?: unknown) {
    const fn = (typeof a === "function" ? a : b) as (e?: unknown) => void;
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
  }
  once(ev: string, fn: (e?: unknown) => void) { this.on(ev, fn); }
  fire(ev: string, e?: unknown) {
    act(() => { for (const fn of this.handlers.get(ev) ?? []) fn(e); });
  }

  isStyleLoaded() { return this.styleLoaded; }
  getZoom() { return this.zoom; }
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

  /** Drive a zoom the way MapLibre does: event first, style loaded after. */
  zoomTo(z: number) {
    this.zoom = z;
    this.styleLoaded = false;
    this.fire("zoom");
    this.styleLoaded = true;
  }
}

const markers: FakeMarker[] = [];
class FakeMarker {
  lngLat: [number, number] = [0, 0];
  constructor(public opts: { element: HTMLElement }) { markers.push(this); }
  setLngLat(v: [number, number]) { this.lngLat = v; return this; }
  addTo() { return this; }
  remove() { return this; }
  getElement() { return this.opts.element; }
}

let map: FakeMap;
vi.mock("maplibre-gl", () => ({
  setWorkerUrl: () => {},
  Map: class { constructor() { return map as unknown as object; } },
  Marker: class { constructor(o: { element: HTMLElement }) { return new FakeMarker(o) as unknown as object; } },
  AttributionControl: class {},
  LngLatBounds: class { extend() {} },
}));
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));

const { TransitMap } = await import("../src/ui/TransitMap");

/** Two routes down the same street, so both get a lane and both must move.
 *  It bends: a straight line hides corner-cutting in anything drawn along it. */
const line = (lat0: number, lng: number, n = 30): LatLng[] =>
  Array.from({ length: n }, (_, i) => ({
    lat: lat0 + i * 0.0002,
    lng: lng + 0.0008 * Math.sin((2 * Math.PI * i) / (n - 1)),
  }));

const feed = {
  routes: new Map([
    ["A", { id: "A", name: "A", color: "#ff0000", shape: line(41.82, -71.4) }],
    ["B", { id: "B", name: "B", color: "#00ff00", shape: [...line(41.82, -71.4)].reverse() }],
  ]),
  stops: new Map(),
  trips: new Map(),
} as unknown as StaticFeed;

const buses = [{
  id: "bus1", routeId: "A", lat: 41.8228, lng: -71.4002,
  label: "1", bearing: 0, paxLoad: 0, totalCap: 0,
}] as never;

const routeCoords = () => {
  const src = map.getSource("routes") as { data: GeoJSON.FeatureCollection } | undefined;
  const f = src?.data.features.find((q) => q.properties?.["routeId"] === "A");
  return (f?.geometry as GeoJSON.LineString).coordinates;
};

const metresApart = (a: number[], b: number[]) =>
  Math.hypot((b[1]! - a[1]!) * 111_320, (b[0]! - a[0]!) * 111_320 * Math.cos(41.82 * Math.PI / 180));

beforeEach(() => {
  map = new FakeMap();
  markers.length = 0;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} } as never;
  window.matchMedia = (() => ({
    matches: false, addEventListener() {}, removeEventListener() {},
  })) as never;
});
afterEach(cleanup);

describe("TransitMap route geometry", () => {
  const mount = () => render(
    <TransitMap feed={feed} buses={buses} me={null} destination={null} overlay={null}
      focus={null} highlightRouteId={null} activeRouteIds={new Set(["A", "B"])} />);

  it("rebuilds the lane offset when the rider zooms", () => {
    // The offset is pixels expressed as coordinates, so it is only correct for
    // the zoom it was built at. z12 puts the lanes an order of magnitude
    // further apart on the ground than z18 does.
    mount();
    map.fire("load");
    const near = routeCoords();
    map.zoomTo(12);
    const far = routeCoords();
    expect(metresApart(near[10]!, far[10]!)).toBeGreaterThan(20);
  });

  it("rebuilds it even though the style reports not loaded mid-zoom", () => {
    // isStyleLoaded() is false exactly when the zoom event fires and turns true
    // a few hundred ms later. Gating the redraw on it skipped every zoom, and
    // nothing re-ran until unrelated data arrived.
    mount();
    map.fire("load");
    const before = routeCoords();
    map.zoom = 17;
    map.styleLoaded = false;
    map.fire("zoom");                       // style still loading, as in the wild
    expect(metresApart(before[10]!, routeCoords()[10]!)).toBeGreaterThan(1);
  });

  it("lays the chosen itinerary along the route line, not across its corners", () => {
    // The itinerary is a slice of the route's raw shape, which can be a handful
    // of vertices hundreds of metres apart. Snapping those few points onto the
    // drawn line leaves the straight segments between them cutting across every
    // bend: measured on the live map, up to 9.3px off the line it highlights.
    const shape = feed.routes.get("A")!.shape;
    const sparse = [shape[2]!, shape[12]!, shape[22]!];      // as sliceShape emits
    render(
      <TransitMap feed={feed} buses={buses} me={null} destination={null}
        overlay={{ walks: [], rides: [{ routeId: "A", color: "#ff0000", path: sparse }] }}
        focus={null} highlightRouteId={null} activeRouteIds={new Set(["A", "B"])} />);
    map.fire("load");

    const ride = (map.getSource("itin-ride") as { data: GeoJSON.FeatureCollection })
      .data.features[0]!.geometry as GeoJSON.LineString;
    const line = routeCoords();
    const nearest = (q: number[]) => Math.min(...line.map((r) => metresApart(q, r)));
    // Sample ALONG the segments. Checking only the vertices proves nothing --
    // those are snapped by construction; it is the straight runs between them
    // that leave the line.
    let worst = 0;
    const c = ride.coordinates;
    for (let i = 1; i < c.length; i++)
      for (let t = 0; t <= 1; t += 0.05)
        worst = Math.max(worst, nearest([
          c[i - 1]![0]! + (c[i]![0]! - c[i - 1]![0]!) * t,
          c[i - 1]![1]! + (c[i]![1]! - c[i - 1]![1]!) * t]));
    expect(worst).toBeLessThan(5);
  });

  it("moves the buses onto the line as redrawn", () => {
    // A bus snapped to the z14 geometry is metres off the line drawn at z18.
    mount();
    map.fire("load");
    const at14 = markers[0]!.lngLat;
    map.zoomTo(18);
    const at18 = markers[0]!.lngLat;
    expect(metresApart([at14[0], at14[1]], [at18[0], at18[1]])).toBeGreaterThan(1);
  });
});
