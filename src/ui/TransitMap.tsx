/** The map layer: route lines, stops, live buses, and the rider's own dot. */
import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { StaticFeed, LatLng } from "../data/types";
import type { Bus } from "../data/vehicles";
import { basemapStyle } from "./mapStyle";
import { offsetColinearRoutes, type OffsetPiece } from "../routing/parallel";
import { snapToLane, metresPerPixel } from "../routing/snap";

// MapLibre's worker is a separate ES module that imports a sibling. Rollup
// cannot see it (the path is built from a runtime string) and ?url would copy
// it without that sibling -- either way the worker 404s, the style never
// initialises, and the map renders tiles over an empty layer stack with no
// error. scripts/copy-maplibre-worker.sh ships both files.
maplibregl.setWorkerUrl(`${import.meta.env.BASE_URL}maplibre/maplibre-gl-worker.mjs`);

export const CAMPUS: LatLng = { lat: 41.8265, lng: -71.4015 };

/** Overlay layers are torn down and rebuilt whenever the chosen trip changes. */
/** Hold this long to drop a pin. Matches the platform's own press delay. */
const LONG_PRESS_MS = 500;

/** Gap between coincident routes, in screen pixels. Pixels, not metres, so
 *  the bundle stays legible at every zoom. */
const LANE_PX = 5;

const OVERLAY_LAYERS = ["itin-walk", "itin-ride-case", "itin-ride-0", "itin-ride-1", "itin-ride-2"];

/** Watch the system colour scheme so the map can follow it. */
function usePrefersDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return dark;
}

export interface Overlay {
  /** Sidewalk-following walking legs. */
  walks: LatLng[][];
  /** Ridden portions of route shapes, with the route's own colour. */
  rides: { path: LatLng[]; color: string }[];
}

export function TransitMap({
  feed, buses, me, destination, overlay, focus, highlightRouteId, routeStopIds, activeRouteIds,
  onMapClick, onClearDestination, onRouteClick, onStopClick, onPlaceClick,
}: {
  feed: StaticFeed | null;
  buses: Bus[];
  me: LatLng | null;
  destination: LatLng | null;
  /** Tapping empty map with a destination set clears it, the way Apple Maps
   *  deselects rather than dropping a second pin. */
  onClearDestination?: () => void;
  overlay: Overlay | null;
  /** Points the map should frame, e.g. the chosen trip end to end. */
  focus: LatLng[] | null;
  /** When set, this route is drawn at full strength and the rest recede. */
  highlightRouteId: string | null;
  /** Stop ids on the highlighted route, drawn as stations along the line. */
  routeStopIds?: string[];
  activeRouteIds: Set<string>;
  onMapClick?: (p: LatLng) => void;
  onRouteClick?: (routeId: string) => void;
  onStopClick?: (stopId: string) => void;
  /** A named place tapped on the map -- a destination with a name attached,
   *  rather than an anonymous dropped pin. */
  onPlaceClick?: (place: { name: string; at: LatLng }) => void;
}) {
  const div = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const busMarks = useRef<Map<string, maplibregl.Marker>>(new Map());
  const meMark = useRef<maplibregl.Marker | null>(null);
  const destMark = useRef<maplibregl.Marker | null>(null);
  const clickCb = useRef(onMapClick);
  clickCb.current = onMapClick;
  const routeCb = useRef(onRouteClick);
  routeCb.current = onRouteClick;
  const stopCb = useRef(onStopClick);
  stopCb.current = onStopClick;
  const clearCb = useRef(onClearDestination);
  clearCb.current = onClearDestination;
  const placeCb = useRef(onPlaceClick);
  placeCb.current = onPlaceClick;
  const hasDest = useRef(false);
  hasDest.current = destination !== null;
  // A counter, not a boolean: setStyle falls back to a full reload when its
  // diff is not applicable, which drops every layer we added. Incrementing on
  // each styledata lets the drawing effects re-run and rebuild them.
  const [ready, setReady] = useState(0);
  /** The lane-split route geometry, shared with the bus markers so vehicles
   *  ride exactly the line that is drawn rather than the unoffset centreline. */
  const piecesRef = useRef<OffsetPiece[]>([]);
  const [zoom, setZoom] = useState(14.2);
  const dark = usePrefersDark();
  const darkRef = useRef(dark);
  darkRef.current = dark;

  useEffect(() => {
    if (!div.current || map.current) return;
    setReady(0);   // this counter describes THIS map; never inherit a previous one's
    const m = new maplibregl.Map({
      container: div.current, style: basemapStyle(darkRef.current),
      center: [CAMPUS.lng, CAMPUS.lat], zoom: 14.2, attributionControl: false,
      // Apple Maps lets you turn the map; on a campus grid it genuinely helps
      // orient which way Thayer runs.
      pitchWithRotate: false, dragRotate: true,
    });
    // Bottom-left: the top-right corner belongs to the locate button, and the
    // bottom-right sits under the sheet at every detent.
    // Top-left: the sheet covers the entire bottom edge at every detent, so
    // attribution placed there is invisible -- and OpenStreetMap and
    // OpenFreeMap both require it to be visible. Search moved into the sheet,
    // which freed this corner.
    m.addControl(new maplibregl.AttributionControl({ compact: true }), "top-left");
    // Lane offsets are in pixels, so the geographic position a bus must sit at
    // changes with zoom.
    m.on("zoomend", () => setZoom(m.getZoom()));
    m.on("load", () => {
      setReady((n) => n + 1);
      // Tapping a named place selects it. Registered once here rather than in
      // the drawing effect because these layers come from the basemap style,
      // not from us.
      m.on("click", "poi-hit", (e: maplibregl.MapLayerMouseEvent) => {
        const f = e.features?.[0];
        const name = f?.properties?.["name"];
        if (!name) return;
        const g = f!.geometry;
        const at = g.type === "Point"
          ? { lng: g.coordinates[0] as number, lat: g.coordinates[1] as number }
          : { lat: e.lngLat.lat, lng: e.lngLat.lng };
        placeCb.current?.({ name: String(name), at });
      });
      m.on("mouseenter", "poi-hit", () => { m.getCanvas().style.cursor = "pointer"; });
      m.on("mouseleave", "poi-hit", () => { m.getCanvas().style.cursor = ""; });
    });
    // Read the handler from a ref so changing it never tears down the map.
    m.on("click", (e) => {
      // Ask what was actually hit rather than relying on preventDefault:
      // MapLibre dispatches the layer handler and this one independently, so
      // a tap on a stop was opening the stop card AND dropping a pin.
      const hitLayers = ["stops-hit", "poi-hit"].filter((l) => m.getLayer(l));
      if (hitLayers.length && m.queryRenderedFeatures(e.point, { layers: hitLayers }).length) return;
      // A plain tap never drops a pin. With a destination set it deselects;
      // otherwise it does nothing. Dropping a pin is a long press.
      if (hasDest.current) clearCb.current?.();
    });

    // Long press (or right click) drops a pin, as on Apple Maps.
    let pressTimer: ReturnType<typeof setTimeout> | undefined;
    let pressStart: { x: number; y: number } | null = null;
    const cancelPress = () => { if (pressTimer) clearTimeout(pressTimer); pressTimer = undefined; };
    m.on("mousedown", (e) => {
      pressStart = { x: e.point.x, y: e.point.y };
      pressTimer = setTimeout(() => {
        clickCb.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
        pressTimer = undefined;
      }, LONG_PRESS_MS);
    });
    m.on("touchstart", (e) => {
      if (e.points.length !== 1) return;      // pinch, not a press
      pressStart = { x: e.point.x, y: e.point.y };
      pressTimer = setTimeout(() => {
        clickCb.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
        pressTimer = undefined;
      }, LONG_PRESS_MS);
    });
    // Any real movement means a pan, not a press.
    const maybeCancel = (p: { x: number; y: number }) => {
      if (!pressStart) return;
      if (Math.hypot(p.x - pressStart.x, p.y - pressStart.y) > 8) cancelPress();
    };
    m.on("mousemove", (e) => maybeCancel(e.point));
    m.on("touchmove", (e) => maybeCancel(e.point));
    for (const ev of ["mouseup", "touchend", "touchcancel", "dragstart", "zoomstart"] as const)
      m.on(ev, cancelPress);
    m.on("contextmenu", (e) => {
      cancelPress();
      clickCb.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });
    // Without this MapLibre fails silently -- a dead worker just leaves a blank map.
    m.on("error", (ev) => console.error("MAPLIBRE:", ev.error?.message ?? ev));
    // Deliberate: a live map handle is the only practical way to measure what
    // is actually rendered in a deployed build. Eyeballing screenshots has
    // twice led to declaring a map bug fixed when it was not.
    (globalThis as unknown as { __map: maplibregl.Map }).__map = m;
    map.current = m;
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(div.current);
    return () => {
      ro.disconnect();
      // Markers hold a reference to the removed map; leaving them populated
      // makes every bus silently invisible after a StrictMode double-mount.
      for (const mk of busMarks.current.values()) mk.remove();
      busMarks.current.clear();
      meMark.current?.remove(); meMark.current = null;
      destMark.current?.remove(); destMark.current = null;
      m.remove(); map.current = null; setReady(0);
    };
  }, []);

  // route lines + stops
  useEffect(() => {
    // isStyleLoaded() is the authority: addSource/addLayer throw "Style is not
    // done loading" and that exception escapes the effect and unmounts the app.
    const m = map.current;
    if (!m || !ready || !m.isStyleLoaded() || !feed) return;

    // One source for every route, split into lanes so coincident routes draw
    // side by side instead of hiding each other. Drawn before the stops layer
    // so a stop is never buried under the line it belongs to.
    const active = [...feed.routes.values()].filter(
      (r) => activeRouteIds.has(r.id) && r.shape.length >= 2);
    const pieces = offsetColinearRoutes(active.map((r) => ({ id: r.id, shape: r.shape })));
    piecesRef.current = pieces;
    const colorOf = new Map(active.map((r) => [r.id, r.color]));

    const data: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: pieces.map((p) => ({
        type: "Feature",
        properties: { routeId: p.routeId, lane: p.lane, color: colorOf.get(p.routeId) ?? "#888" },
        geometry: { type: "LineString", coordinates: p.path.map((q) => [q.lng, q.lat]) },
      })),
    };

    try {
      const src = m.getSource("routes") as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data);
      } else {
        m.addSource("routes", { type: "geojson", data });
        // line-offset is in PIXELS, so lanes stay evenly spaced at every zoom,
        // the way a subway map keeps its lines apart when you zoom out.
        const offset: maplibregl.ExpressionSpecification =
          ["*", ["get", "lane"], LANE_PX];
        m.addLayer({
          id: "routes-case", type: "line", source: "routes",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": darkRef.current ? "#15110F" : "#FFFFFF",
            "line-width": 7, "line-opacity": 0.9, "line-offset": offset,
          },
        });
        m.addLayer({
          id: "routes-line", type: "line", source: "routes",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["get", "color"],
            "line-width": 3.5, "line-offset": offset,
          },
        });
      }

      if (!m.getSource("stops")) {
        m.addSource("stops", { type: "geojson", data: { type: "FeatureCollection",
          features: [...feed.stops.values()].map((s) => ({
            type: "Feature" as const, properties: { name: s.name, id: s.id },
            geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] } })) } });
        // Stops on the route being viewed, drawn larger and in the route colour.
        m.addLayer({ id: "stops-active", type: "circle", source: "stops",
          filter: ["in", ["get", "id"], ["literal", []]],
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 4, 16, 7],
            "circle-color": "#FFFFFF", "circle-stroke-width": 3.5,
            "circle-stroke-color": "#6F625A",
          } });
        m.addLayer({ id: "stops", type: "circle", source: "stops", minzoom: 13,
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 16, 5],
            "circle-color": darkRef.current ? "#15110F" : "#FFFFFF",
            "circle-stroke-color": darkRef.current ? "#C6BAB1" : "#241C17",
            "circle-stroke-width": 1.5,
          } });
        // A 5px dot is too small for a thumb; an invisible wider circle takes taps.
        m.addLayer({ id: "stops-hit", type: "circle", source: "stops", minzoom: 13,
          paint: { "circle-radius": 14, "circle-opacity": 0 } });
        m.on("click", "stops-hit", (e: maplibregl.MapLayerMouseEvent) => {
          const f = e.features?.[0];
          const id = f?.properties?.["id"];
          if (id) stopCb.current?.(String(id));
        });
        m.on("mouseenter", "stops-hit", () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", "stops-hit", () => { m.getCanvas().style.cursor = ""; });
      }
    } catch { /* style churn; the next render rebuilds */ }
  }, [feed, ready, activeRouteIds]);

  // live buses
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.isStyleLoaded()) return;
    const mpp = metresPerPixel(CAMPUS.lat, zoom);
    for (const b of buses) {
      const color = feed?.routes.get(b.routeId)?.color ?? "#241C17";
      // Snap onto the route and shift into its lane: GPS leaves buses tens of
      // metres off their own shape, and the drawn line is itself offset.
      const at = snapToLane({ lat: b.lat, lng: b.lng }, b.routeId, piecesRef.current, mpp, LANE_PX);
      let mk = busMarks.current.get(b.id);
      if (!mk) {
        // A real button: role="button" on a div is announced but cannot be
        // reached or activated by keyboard or assistive tech.
        const el = document.createElement("button");
        el.type = "button";
        el.className = "display";
        // 30x30 box whose lower 22px is the dot; anchoring the box centre put
        // the dot ~4px north of the bus's real position, which at street zoom
        // reads as "the bus is not on its route".
        el.style.cssText =
          "position:relative;width:30px;height:30px;padding:0;border:0;background:none;cursor:pointer";
        // A heading arrow answers "is it coming towards me or leaving", which
        // a plain dot cannot. Bearing is in the feed and was going unused.
        const arrow = document.createElement("div");
        arrow.style.cssText =
          `position:absolute;inset:0;transform:rotate(${b.bearing}deg);transition:transform .4s ease`;
        arrow.innerHTML =
          `<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">` +
          `<path d="M15 0.5 L19 6 L11 6 Z" fill="${color}"/></svg>`;
        const dot = document.createElement("div");
        dot.style.cssText =
          `position:absolute;left:4px;top:4px;width:22px;height:22px;border-radius:50%;` +
          `background:${color};color:#fff;` +
          `border:2.5px solid ${darkRef.current ? "#15110F" : "#FFFFFF"};` +
          `box-shadow:0 1px 5px rgb(0 0 0 / 45%);` +
          `display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700`;
        dot.textContent = b.label;
        el.append(arrow, dot);
        el.title = `Bus ${b.label}`;
        el.setAttribute("aria-label",
          `Bus ${b.label} on ${feed?.routes.get(b.routeId)?.name ?? "route"}` +
          (b.totalCap ? `, ${b.paxLoad} of ${b.totalCap} seats taken` : "") + ". See route.");
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();          // do not also drop a destination pin
          routeCb.current?.(b.routeId);
        });
        // No offset: the dot is already centred in the 30x30 box (left 4 +
        // radius 11 = 15 = box centre), so the default centre anchor puts it
        // exactly on the coordinate. The offset I added "to centre the dot"
        // pushed every bus 4px off its line.
        mk = new maplibregl.Marker({ element: el })
          .setLngLat([at.lng, at.lat]).addTo(m);
        busMarks.current.set(b.id, mk);
      } else {
        mk.setLngLat([at.lng, at.lat]);
        const el = mk.getElement();
        const arrow = el.firstElementChild as HTMLElement | null;
        if (arrow) arrow.style.transform = `rotate(${b.bearing}deg)`;
        el.setAttribute("aria-label",
          `Bus ${b.label} on ${feed?.routes.get(b.routeId)?.name ?? "route"}` +
          (b.totalCap ? `, ${b.paxLoad} of ${b.totalCap} seats taken` : "") + ". See route.");
      }
    }
    for (const [id, mk] of busMarks.current)
      if (!buses.some((b) => b.id === id)) { mk.remove(); busMarks.current.delete(id); }
  }, [buses, feed, ready, zoom]);

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


    try {
      line("itin-ride-case", overlay.rides.map((r) => r.path),
        { "line-color": darkRef.current ? "#15110F" : "#FFFFFF", "line-width": 11 });
      overlay.rides.forEach((r, i) => line(`itin-ride-${i}`, [r.path],
        { "line-color": r.color, "line-width": 6 }));
      line("itin-walk", overlay.walks,
        { "line-color": darkRef.current ? "#F0E9E3" : "#241C17",
          "line-width": 4, "line-dasharray": [0.4, 1.8] });
    } catch { /* style churn; the next render redraws */ }

  }, [overlay, ready, feed]);

  // Swap the basemap when the system theme flips. setStyle wipes our layers,
  // so mark the map not-ready and let the drawing effects rebuild on load.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    m.setStyle(basemapStyle(dark));
    m.once("styledata", () => setReady((n) => n + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark]);

  // Re-tint route casings and stop dots after a theme swap.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.isStyleLoaded() || !feed) return;
    const ground = dark ? "#15110F" : "#FFFFFF";
    try {
      if (m.getLayer("routes-case")) m.setPaintProperty("routes-case", "line-color", ground);
      if (m.getLayer("stops")) {
        m.setPaintProperty("stops", "circle-color", ground);
        m.setPaintProperty("stops", "circle-stroke-color", dark ? "#C6BAB1" : "#241C17");
      }
      if (m.getLayer("itin-ride-case")) m.setPaintProperty("itin-ride-case", "line-color", ground);
      if (m.getLayer("itin-walk")) m.setPaintProperty("itin-walk", "line-color", dark ? "#F0E9E3" : "#241C17");
    } catch { /* style churn */ }
  }, [dark, ready, feed]);

  // Emphasise one route and let the others recede, so a route page reads as
  // being about that route rather than about the whole network.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.isStyleLoaded() || !feed) return;
    try {
      // Single owner of route emphasis, expressed per feature so one layer
      // can dim the network while keeping the focused route at full strength.
      const focus = highlightRouteId;
      if (m.getLayer("routes-line")) {
        m.setPaintProperty("routes-line", "line-opacity", focus
          ? ["case", ["==", ["get", "routeId"], focus], 0.9, 0.16]
          : 0.85);
        m.setPaintProperty("routes-line", "line-width", focus
          ? ["case", ["==", ["get", "routeId"], focus], 5.5, 3]
          : 3.5);
        m.setPaintProperty("routes-case", "line-opacity", focus ? 0.35 : 0.9);
      }
      if (m.getLayer("stops-active")) {
        const ids = highlightRouteId ? (routeStopIds ?? []) : [];
        m.setFilter("stops-active", ["in", ["get", "id"], ["literal", ids]]);
        m.setPaintProperty("stops-active", "circle-stroke-color",
          (highlightRouteId && feed.routes.get(highlightRouteId)?.color) || "#6F625A");
      }
    } catch { /* style churn */ }
  }, [highlightRouteId, routeStopIds, overlay, ready, feed]);

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
