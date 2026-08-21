/** The map layer: route lines, stops, live buses, and the rider's own dot. */
import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { StaticFeed, LatLng } from "../data/types";
import type { Bus } from "../data/vehicles";
import { basemapStyle } from "./mapStyle";
import { densify, laneProfiles, offsetPath, type LaneProfile } from "../routing/parallel";
import { snapToPath, metresPerPixel } from "../routing/snap";

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

/** Gap between coincident routes, in screen pixels. Wider than the casing so
 *  two parallel lines read as two lines rather than one thick one. Pixels, not
 *  metres, which is why the geometry is rebuilt when the zoom changes. */
const LANE_PX = 8;

/** Zoom change worth rebuilding the route geometry for. Small enough that a
 *  pinch never shows the lines sliding, large enough not to rebuild per frame. */
const ZOOM_STEP = 0.12;

const OVERLAY_SOURCES = ["itin-walk", "itin-ride"] as const;
const OVERLAY_LAYERS = ["itin-walk", "itin-ride-case", "itin-ride-line"] as const;

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
  /** Ridden portions of route shapes, with the route's own colour. The route
   *  id lets the map lay the itinerary over the line as DRAWN -- offset into
   *  its lane -- instead of the raw centreline beside it. */
  rides: { path: LatLng[]; color: string; routeId: string }[];
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
  /** Lane numbers per point, the expensive half. Rebuilt only when the set of
   *  drawn routes changes. */
  const profilesRef = useRef<LaneProfile[]>([]);
  /** The route lines as actually drawn at the current zoom, shared with the bus
   *  markers and the itinerary so both sit on the line the rider can see. */
  const drawnRef = useRef<Map<string, LatLng[]>>(new Map());
  const colorRef = useRef<Map<string, string>>(new Map());
  const [zoom, setZoom] = useState(14.2);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const dark = usePrefersDark();
  const darkRef = useRef(dark);
  darkRef.current = dark;

  /**
   * Lay down the route lines for the current scale.
   *
   * The lane offset is baked into the coordinates rather than applied with
   * MapLibre's `line-offset`, because that offset is one constant per feature
   * and a route needs to sit on its street where it runs alone and slide
   * gently into a lane where it does not. Lane spacing is in pixels, so this
   * has to re-run on every zoom step -- cheap, it is arithmetic over a few
   * thousand points that were laid out once.
   */
  function drawRoutes(m: maplibregl.Map, z: number) {
    const mpp = metresPerPixel(CAMPUS.lat, z);
    const drawn = new Map<string, LatLng[]>();
    for (const p of profilesRef.current) drawn.set(p.routeId, offsetPath(p, mpp, LANE_PX));
    drawnRef.current = drawn;

    const data: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [...drawn].map(([routeId, path]) => ({
        type: "Feature",
        properties: { routeId, color: colorRef.current.get(routeId) ?? "#888" },
        geometry: { type: "LineString", coordinates: path.map((q) => [q.lng, q.lat]) },
      })),
    };

    const src = m.getSource("routes") as maplibregl.GeoJSONSource | undefined;
    if (src) { src.setData(data); return; }
    m.addSource("routes", { type: "geojson", data });
    m.addLayer({
      id: "routes-case", type: "line", source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": darkRef.current ? "#15110F" : "#FFFFFF",
        "line-width": 7.5, "line-opacity": 0.9,
      },
    });
    m.addLayer({
      id: "routes-line", type: "line", source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": 4 },
    });
  }

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
    // Lane offsets are in pixels but live in the geometry, so both the lines
    // and the buses on them have to be rebuilt as the rider zooms. Following
    // the gesture rather than waiting for zoomend is what stops the whole
    // network visibly sliding sideways the moment a pinch ends.
    m.on("zoom", () => {
      const z = m.getZoom();
      setZoom((prev) => (Math.abs(z - prev) < ZOOM_STEP ? prev : z));
    });
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

    // Which routes share which stretches of street. The costly half of the
    // work, so it is kept out of the per-zoom redraw below. Route lines are
    // added before the stops layer so a stop is never buried under its line.
    const active = [...feed.routes.values()].filter(
      (r) => activeRouteIds.has(r.id) && r.shape.length >= 2);
    profilesRef.current = laneProfiles(active.map((r) => ({ id: r.id, shape: r.shape })));
    colorRef.current = new Map(active.map((r) => [r.id, r.color]));

    try {
      drawRoutes(m, zoomRef.current);

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

  // The lane offset is pixels expressed as coordinates, so a zoom change makes
  // the geometry stale. Rebuilding it is what keeps parallel lines the same
  // distance apart whether the rider is looking at a block or the whole city.
  //
  // Deliberately NOT gated on isStyleLoaded(). That returns false at the exact
  // moment the zoom event fires and only turns true a few hundred ms later, so
  // gating on it skipped every single zoom -- the lines and the buses on them
  // kept the offset they were built with until some unrelated data arrived and
  // re-ran the effect. Measured: buses ended up 45m off their own line. The
  // source already exists by here, and setData on an existing source is safe
  // whatever the style is doing.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.getSource("routes") || profilesRef.current.length === 0) return;
    try { drawRoutes(m, zoom); } catch { /* style churn; the next render redraws */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, ready]);

  // live buses. Markers are DOM elements the map merely positions, so this
  // needs no style at all -- and gating it on isStyleLoaded() left every bus
  // parked on the geometry of whatever zoom it last managed to run at.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    for (const b of buses) {
      const color = feed?.routes.get(b.routeId)?.color ?? "#241C17";
      // Onto the line as drawn, lane offset and all. GPS leaves buses tens of
      // metres off their own shape, so the reported position alone puts them
      // beside their route.
      const at = snapToPath({ lat: b.lat, lng: b.lng }, drawnRef.current.get(b.routeId) ?? []);
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
      for (const id of OVERLAY_LAYERS) if (m.getLayer(id)) m.removeLayer(id);
      for (const id of OVERLAY_SOURCES) if (m.getSource(id)) m.removeSource(id);
    } catch { return; }
    if (!overlay) return;

    const feature = (c: LatLng[], properties: GeoJSON.GeoJsonProperties = {}): GeoJSON.Feature => ({
      type: "Feature", properties,
      geometry: { type: "LineString", coordinates: c.map((p) => [p.lng, p.lat]) },
    });
    const addSource = (id: string, features: GeoJSON.Feature[]) =>
      m.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features } });

    try {
      // The itinerary is a slice of the route's raw shape, but the route line
      // is drawn offset into its lane. Pulling each point onto the drawn line
      // stops the highlight from running alongside the thing it highlights.
      const rides = overlay.rides
        .map((r) => {
          const drawn = drawnRef.current.get(r.routeId);
          // Densify BEFORE snapping. sliceShape hands back the route's own
          // vertices, which can be hundreds of metres apart; snapping those
          // alone puts the highlight on the line at each vertex and straight
          // across the bends in between.
          return { ...r, path: drawn && drawn.length > 1
            ? densify(r.path).map((q) => snapToPath(q, drawn)) : r.path };
        })
        .filter((r) => r.path.length > 1);
      if (rides.length) {
        addSource("itin-ride", rides.map((r) => feature(r.path, { color: r.color })));
        m.addLayer({ id: "itin-ride-case", type: "line", source: "itin-ride",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": darkRef.current ? "#15110F" : "#FFFFFF", "line-width": 11 } });
        m.addLayer({ id: "itin-ride-line", type: "line", source: "itin-ride",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": ["get", "color"], "line-width": 6 } });
      }
      const walks = overlay.walks.filter((w) => w.length > 1);
      if (walks.length) {
        addSource("itin-walk", walks.map((w) => feature(w)));
        m.addLayer({ id: "itin-walk", type: "line", source: "itin-walk",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": darkRef.current ? "#F0E9E3" : "#241C17",
                   "line-width": 4, "line-dasharray": [0.4, 1.8] } });
      }
    } catch { /* style churn; the next render redraws */ }

  }, [overlay, ready, feed, zoom]);

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
          ? ["case", ["==", ["get", "routeId"], focus], 6, 3]
          : 4);
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
