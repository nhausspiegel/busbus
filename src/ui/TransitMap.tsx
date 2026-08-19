/** The map layer: route lines, stops, live buses, and the rider's own dot. */
import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { StaticFeed, LatLng } from "../data/types";
import type { Bus } from "../data/vehicles";

// MapLibre's worker is a separate ES module that imports a sibling. Rollup
// cannot see it (the path is built from a runtime string) and ?url would copy
// it without that sibling -- either way the worker 404s, the style never
// initialises, and the map renders tiles over an empty layer stack with no
// error. scripts/copy-maplibre-worker.sh ships both files.
maplibregl.setWorkerUrl(`${import.meta.env.BASE_URL}maplibre/maplibre-gl-worker.mjs`);

export const CAMPUS: LatLng = { lat: 41.8265, lng: -71.4015 };

const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.35 } }],
};

export function TransitMap({
  feed, buses, me, activeRouteIds, onMapReady,
}: {
  feed: StaticFeed | null;
  buses: Bus[];
  me: LatLng | null;
  activeRouteIds: Set<string>;
  onMapReady?: (m: maplibregl.Map) => void;
}) {
  const div = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const busMarks = useRef<Map<string, maplibregl.Marker>>(new Map());
  const meMark = useRef<maplibregl.Marker | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!div.current || map.current) return;
    setReady(false);   // this flag describes THIS map; never inherit a previous one's
    const m = new maplibregl.Map({
      container: div.current, style: STYLE,
      center: [CAMPUS.lng, CAMPUS.lat], zoom: 14.2, attributionControl: false,
    });
    // Bottom-left: the top-right corner belongs to the locate button, and the
    // bottom-right sits under the sheet at every detent.
    m.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
    m.on("load", () => { setReady(true); onMapReady?.(m); });
    // Without this MapLibre fails silently -- a dead worker just leaves a blank map.
    m.on("error", (ev) => console.error("MAPLIBRE:", ev.error?.message ?? ev));
    map.current = m;
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(div.current);
    return () => { ro.disconnect(); m.remove(); map.current = null; setReady(false); };
  }, [onMapReady]);

  // route lines + stops
  useEffect(() => {
    const m = map.current;
    // isStyleLoaded() is the authority: addSource/addLayer throw "Style is not
    // done loading" and that exception escapes the effect and unmounts the app.
    if (!m || !ready || !m.isStyleLoaded() || !feed) return;
    for (const r of feed.routes.values()) {
      if (!activeRouteIds.has(r.id) || r.shape.length < 2) continue;
      const id = `route-${r.id}`;
      if (m.getSource(id)) continue;
      m.addSource(id, { type: "geojson", data: {
        type: "Feature", properties: {},
        geometry: { type: "LineString", coordinates: r.shape.map((p) => [p.lng, p.lat]) } } });
      // Casing under the colour keeps five overlapping routes legible.
      m.addLayer({ id: `${id}-case`, type: "line", source: id,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#fff", "line-width": 7, "line-opacity": 0.9 } });
      m.addLayer({ id, type: "line", source: id,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": r.color, "line-width": 3.5 } });
    }
    if (!m.getSource("stops")) {
      m.addSource("stops", { type: "geojson", data: { type: "FeatureCollection",
        features: [...feed.stops.values()].map((s) => ({
          type: "Feature" as const, properties: { name: s.name },
          geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] } })) } });
      m.addLayer({ id: "stops", type: "circle", source: "stops", minzoom: 13,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 16, 5],
          "circle-color": "#fff", "circle-stroke-color": "#241C17", "circle-stroke-width": 1.5,
        } });
    }
  }, [feed, ready, activeRouteIds]);

  // live buses
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.isStyleLoaded()) return;
    for (const b of buses) {
      const color = feed?.routes.get(b.routeId)?.color ?? "#241C17";
      let mk = busMarks.current.get(b.id);
      if (!mk) {
        const el = document.createElement("div");
        el.className = "display";
        el.style.cssText =
          `width:24px;height:24px;border-radius:50%;background:${color};color:#fff;` +
          `border:2.5px solid #fff;box-shadow:0 1px 5px rgb(36 28 23 / 35%);` +
          `display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700`;
        el.textContent = b.label;
        el.title = `Bus ${b.label}`;
        mk = new maplibregl.Marker({ element: el }).setLngLat([b.lng, b.lat]).addTo(m);
        busMarks.current.set(b.id, mk);
      } else mk.setLngLat([b.lng, b.lat]);
    }
    for (const [id, mk] of busMarks.current)
      if (!buses.some((b) => b.id === id)) { mk.remove(); busMarks.current.delete(id); }
  }, [buses, feed, ready]);

  // the rider
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !me) return;
    if (!meMark.current) {
      const el = document.createElement("div");
      el.style.cssText =
        "width:16px;height:16px;border-radius:50%;background:var(--accent);" +
        "border:3px solid #fff;box-shadow:0 0 0 4px rgb(200 16 46 / 18%)";
      el.setAttribute("aria-label", "Your location");
      meMark.current = new maplibregl.Marker({ element: el });
    }
    meMark.current.setLngLat([me.lng, me.lat]).addTo(m);
  }, [me, ready]);

  return <div ref={div} style={{ position: "absolute", inset: 0 }} />;
}
