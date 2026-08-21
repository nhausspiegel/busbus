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

beforeEach(() => {
  map = new FakeMap();
  markers.length = 0;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} } as never;
  window.matchMedia = (() => ({
    matches: false, addEventListener() {}, removeEventListener() {},
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

  it("puts each bus exactly where the feed reports it", () => {
    mount();
    map.fire("load");
    expect(markers[0]!.lngLat).toEqual([-71.4002, 41.8228]);
  });
});
