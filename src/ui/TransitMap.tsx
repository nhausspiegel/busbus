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

/** Overlay layers are torn down and rebuilt whenever the chosen trip changes. */
const OVERLAY_LAYERS = ["itin-walk", "itin-ride-case", "itin-ride-0", "itin-ride-1", "itin-ride-2"];

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

export interface Overlay {
  /** Sidewalk-following walking legs. */
  walks: LatLng[][];
  /** Ridden portions of route shapes, with the route's own colour. */
  rides: { path: LatLng[]; color: string }[];
}

export function TransitMap({
  feed, buses, me, destination, overlay, focus, activeRouteIds, onMapClick,
}: {
  feed: StaticFeed | null;
  buses: Bus[];
  me: LatLng | null;
  destination: LatLng | null;
  overlay: Overlay | null;
  /** Points the map should frame, e.g. the chosen trip end to end. */
  focus: LatLng[] | null;
  activeRouteIds: Set<string>;
  onMapClick?: (p: LatLng) => void;
}) {
  const div = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const busMarks = useRef<Map<string, maplibregl.Marker>>(new Map());
  const meMark = useRef<maplibregl.Marker | null>(null);
  const destMark = useRef<maplibregl.Marker | null>(null);
  const clickCb = useRef(onMapClick);
  clickCb.current = onMapClick;
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
    m.on("load", () => setReady(true));
    // Read the handler from a ref so changing it never tears down the map.
    m.on("click", (e) => clickCb.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
    // Without this MapLibre fails silently -- a dead worker just leaves a blank map.
    m.on("error", (ev) => console.error("MAPLIBRE:", ev.error?.message ?? ev));
    map.current = m;
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(div.current);
    return () => { ro.disconnect(); m.remove(); map.current = null; setReady(false); };
  }, []);

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

  // destination pin
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    if (!destination) { destMark.current?.remove(); destMark.current = null; return; }
    if (!destMark.current) {
      const el = document.createElement("div");
      el.innerHTML =
        '<svg width="26" height="34" viewBox="0 0 26 34" aria-label="Destination">' +
        '<path d="M13 33C13 33 24 20.5 24 13A11 11 0 1 0 2 13c0 7.5 11 20 11 20Z" ' +
        'fill="#241C17" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>' +
        '<circle cx="13" cy="13" r="4" fill="#fff"/></svg>';
      el.style.cssText = "filter:drop-shadow(0 2px 3px rgb(36 28 23 / 35%));line-height:0";
      destMark.current = new maplibregl.Marker({ element: el, anchor: "bottom" });
    }
    destMark.current.setLngLat([destination.lng, destination.lat]).addTo(m);
  }, [destination, ready]);

  // the chosen itinerary, drawn over everything else
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.isStyleLoaded()) return;

    // MapLibre throws if the style is mid-reload, and an exception escaping an
    // effect unmounts the whole app -- a blank screen instead of a map.
    try {
      for (const id of OVERLAY_LAYERS) {
        if (m.getLayer(id)) m.removeLayer(id);
        if (m.getSource(id)) m.removeSource(id);
      }
    } catch { return; }
    if (!overlay) return;

    const line = (id: string, coords: LatLng[][], paint: maplibregl.LineLayerSpecification["paint"]) => {
      if (coords.every((c) => c.length < 2)) return;
      m.addSource(id, { type: "geojson", data: {
        type: "FeatureCollection",
        features: coords.filter((c) => c.length > 1).map((c) => ({
          type: "Feature" as const, properties: {},
          geometry: { type: "LineString" as const, coordinates: c.map((p) => [p.lng, p.lat]) } })) } });
      m.addLayer({ id, type: "line", source: id,
        layout: { "line-cap": "round", "line-join": "round" }, paint });
    };

    // Dim the network so the chosen trip reads as the answer, not one line of five.
    for (const r of feed?.routes.values() ?? [])
      if (m.getLayer(`route-${r.id}`)) m.setPaintProperty(`route-${r.id}`, "line-opacity", 0.25);

    try {
      line("itin-ride-case", overlay.rides.map((r) => r.path),
        { "line-color": "#fff", "line-width": 11 });
      overlay.rides.forEach((r, i) => line(`itin-ride-${i}`, [r.path],
        { "line-color": r.color, "line-width": 6 }));
      line("itin-walk", overlay.walks,
        { "line-color": "#241C17", "line-width": 4, "line-dasharray": [0.4, 1.8] });
    } catch { /* style churn; the next render redraws */ }

    return () => {
      for (const r of feed?.routes.values() ?? [])
        if (m.getLayer(`route-${r.id}`)) m.setPaintProperty(`route-${r.id}`, "line-opacity", 0.75);
    };
  }, [overlay, ready, feed]);

  // Frame the chosen trip. Without this the rider has to hunt for their own
  // itinerary on the map, which defeats the point of drawing it.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !focus || focus.length === 0) return;
    const b = new maplibregl.LngLatBounds();
    for (const p of focus) b.extend([p.lng, p.lat]);
    m.fitBounds(b, {
      // Leave room for the search bar above and the sheet below.
      padding: { top: 90, bottom: Math.round(window.innerHeight * 0.5), left: 48, right: 48 },
      maxZoom: 16.5, duration: 650,
    });
  }, [focus, ready]);

  return <div ref={div} style={{ position: "absolute", inset: 0 }} />;
}
