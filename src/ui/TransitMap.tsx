/** The map layer: route lines, stops, live buses, and the rider's own dot. */
import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { StaticFeed, LatLng } from "../data/types";
import type { Bus } from "../data/vehicles";
import { basemapStyle } from "./mapStyle";
import { stationFeatures, rideFeatures, lineFeature } from "../render/network";
import { stopPaint, stopBasePaint, tickPaint, routeLinePaint,
         DIM, type MapState } from "../render/symbols";
import { pointAlongShape, snapToShape } from "../routing/shape";
import { stations } from "../routing/routeDetail";
import { laneRuns, laneApprox } from "../render/lanes";

// MapLibre's worker is a separate ES module that imports a sibling. Rollup
// cannot see it (the path is built from a runtime string) and ?url would copy
// it without that sibling -- either way the worker 404s, the style never
// initialises, and the map renders tiles over an empty layer stack with no
// error. scripts/copy-maplibre-worker.sh ships both files.
maplibregl.setWorkerUrl(`${import.meta.env.BASE_URL}maplibre/maplibre-gl-worker.mjs`);

export const CAMPUS: LatLng = { lat: 41.8265, lng: -71.4015 };

/** What the rider has picked out. One shape for both, so every layer's
 *  emphasis is derived from a single value rather than kept in step by hand. */
export type Selection =
  | { kind: "route"; id: string }
  | { kind: "stop"; id: string };

/** Overlay layers are torn down and rebuilt whenever the chosen trip changes. */
/** Hold this long to drop a pin. Matches the platform's own press delay. */
const LONG_PRESS_MS = 500;
/** How long the selected stop takes to grow. */
const SELECT_MS = 240;

/** Dot sizing with the selected stop `grow` of the way to its full size.
 *  One place, so the tween and the selection effect cannot disagree. */
function selectedRadius(
  id: string | null, grow: number, ends: string[] = [],
): maplibregl.ExpressionSpecification {
  const at = (base: number, big: number) => base + (big - base) * grow;
  // The boarding and alighting stops are drawn LARGER, not drawn again. An
  // earlier version added its own circles for them, in their own sizes and
  // stroke widths, so the ends of a ride were a different symbol from every
  // other stop sitting beside them on the same line. The stop on the map is
  // the indicator.
  const isEnd: maplibregl.ExpressionSpecification =
    ["in", ["get", "id"], ["literal", ends]];
  return ["interpolate", ["linear"], ["zoom"],
    13, ["case", ["==", ["get", "id"], id ?? ""], at(2.5, 4), isEnd, 4, 2.5],
    16, ["case", ["==", ["get", "id"], id ?? ""], at(4.5, 6.5), isEnd, 6.5, 4.5]];
}

/** The stops a rider gets on and off at, across every ride in the trip, named
 *  by the id the BEAD carries.
 *
 *  A ride names a raw stop_id, and Passio splits one place into a per-direction
 *  pair -- the bead keeps only the first member's id. Testing the raw id
 *  against the beads would silently miss every boarding point that happens to
 *  be the second half of its station, which is about half of them. */
function rideEnds(o: Overlay | null, rep: Map<string, string>): string[] {
  if (!o) return [];
  const out: string[] = [];
  for (const r of o.rides)
    for (const id of [r.boardStopId, r.alightStopId])
      if (id) out.push(rep.get(id) ?? id);
  return out;
}

/** How long a bus takes to reach a new fix.
 *
 *  Passio's vehicle feed only speaks every ten seconds (App's VEHICLE_POLL_MS),
 *  so setting the marker straight from it teleports the bus a block at a time.
 *  Apple Maps spreads the move across the whole interval instead, which is why
 *  its vehicles read as driving rather than blinking. Matching the interval
 *  means the dot is always somewhere between two fixes the feed actually gave
 *  -- it trails the newest one by up to an interval, which is the price of
 *  showing motion and what Apple pays too. */
const GLIDE_MS = 10_000;

/** Clear space between routes sharing a street, in screen pixels.
 *
 *  An exact gap now, not a floor. Routes are snapped to the road centreline, so
 *  two on one street have identical geometry and there is no traced separation
 *  left to inherit -- which is what used to make this grow with zoom, from
 *  3.7px at zoom 13 to 13.5px at zoom 18. MapLibre applies it via line-offset,
 *  in pixels, on the GPU. */
const LANE_GAP_PX = 5;

// CORNER_RADIUS_PX and LANE_HOLD_PX are gone. Rounding is `line-join: round`,
// done by the GPU at the true stroke width, so there is no fillet to clamp --
// the old radius was inert anyway, killed by the 10m resampling. The hold
// existed to damp lane flapping caused by guessing "same street" per vertex;
// with the road known, a lane changes only where a route joins or leaves.

/** Ground metres one screen pixel covers at this latitude and zoom.
 *
 *  The constant is the equator's circumference divided by the width of the
 *  world at zoom 0, IN THIS RENDERER. MapLibre uses 512px tiles, so that is
 *  40075016.686 / 512. The 256px-tile figure -- 156543.03392, which is what
 *  Google, Leaflet and most of the internet mean by "metres per pixel" -- was
 *  used here, and is exactly twice too large.
 *
 *  It matters because `laneApprox` exists to reproduce in METRES what the GPU
 *  does in PIXELS: every stop bead and every bus was displaced twice as far as
 *  the line it was snapped to. Measured before the fix, a bead sat a mean 2.2px
 *  and up to 8.3px off its own drawn line. Uniformly, at every zoom -- which is
 *  why it never looked like a zoom bug and survived a rewrite of the bundler.
 *
 *  Verified against the running map, not from memory: at zoom 13.1468, 100m of
 *  ground measured 15.55px, so a pixel is 6.4309m; this returns 6.4309. */
export function metresPerPixel(lat: number, zoom: number): number {
  return (78_271.51696 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}



/** Room to leave around something being framed.
 *
 *  The sheet is a bottom tray on a phone and a side panel on a wide screen, so
 *  reserving half the viewport height for it either way zoomed a desktop map
 *  out far more than it needed to -- half the window given over to a panel
 *  that is not there. */
function framePadding(): maplibregl.PaddingOptions {
  const wide = window.innerWidth >= 820;
  return wide
    ? { top: 80, bottom: 80, left: 452, right: 64 }
    : { top: 90, bottom: Math.round(window.innerHeight * 0.5), left: 48, right: 48 };
}

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
  /** Walking legs. `provisional` marks a leg that could not be routed; those
   *  are NOT drawn. A straight dotted line from A to B is a claim about a path
   *  nobody found, and it read as a ghost on the map. */
  walks: { path: LatLng[]; provisional: boolean }[];
  /** Ridden portions of route shapes, with the route's own colour. The route
   *  id lets the map lay the itinerary over the line as DRAWN -- offset into
   *  its lane -- instead of the raw centreline beside it. */
  rides: {
    path: LatLng[]; color: string; routeId: string;
    /** Where the rider boards and alights, so the map can mark the ends of
     *  the ride rather than leaving them to be guessed from the line. */
    boardStopId?: string; alightStopId?: string;
  }[];
}

export function TransitMap({
  feed, buses, me, destination, overlay, focus, selection, activeRouteIds,
  onMapClick, onDeselect, onRouteClick, onStopClick, onPlaceClick,
}: {
  feed: StaticFeed | null;
  buses: Bus[];
  me: LatLng | null;
  destination: LatLng | null;
  /** Tapping empty map backs out of whatever is selected -- a stop card, a
   *  route, a chosen trip, a destination -- the way Apple Maps deselects
   *  rather than dropping a second pin. The map does not track what is
   *  selected; it reports the tap and lets App decide what to drop. */
  onDeselect?: () => void;
  overlay: Overlay | null;
  /** Points the map should frame, e.g. the chosen trip end to end. */
  focus: LatLng[] | null;
  /** What the rider has picked out, if anything. One idea drives emphasis
   *  across every layer: a route page dims the rest of the network, a stop card
   *  grows its own marker and dims the others. */
  selection: Selection | null;
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
  /** Bus id -> the frame its glide is waiting on. */
  const busGlides = useRef<Map<string, number>>(new Map());
  const meMark = useRef<maplibregl.Marker | null>(null);
  const destMark = useRef<maplibregl.Marker | null>(null);
  const clickCb = useRef(onMapClick);
  clickCb.current = onMapClick;
  const routeCb = useRef(onRouteClick);
  routeCb.current = onRouteClick;
  const stopCb = useRef(onStopClick);
  stopCb.current = onStopClick;
  // Set the moment a long press fires, cleared by the click that ends it.
  // A ref rather than a local, because MapLibre dispatches layer handlers
  // (routes-hit, stops-hit) independently of the map-level one: guarding only
  // the map handler meant a long press dropped its pin AND the trailing click
  // selected whatever route or stop happened to be under the finger, leaving
  // the old page open on top of the new destination.
  const pressHandled = useRef(false);
  const clearCb = useRef(onDeselect);
  clearCb.current = onDeselect;
  const placeCb = useRef(onPlaceClick);
  placeCb.current = onPlaceClick;
  /** Bundle analysis, which does not depend on the scale. Rebuilt only when
   *  the set of drawn routes changes. */
  /** Route id -> its road centreline. Displacing it is MapLibre's job. */
  const shapesRef = useRef<Map<string, LatLng[]>>(new Map());
  const colorRef = useRef<Map<string, string>>(new Map());
  /** The routes as actually drawn at the current zoom, shared with the bus
   *  markers so a vehicle rides the line the rider can see. */
  const drawnRef = useRef<Map<string, LatLng[]>>(new Map());
  /** The current itinerary, so the per-zoom redraw can rebuild its ride line
   *  from the same geometry as everything else. */
  /** How far the selected stop has grown, 0 to 1. */
  const growRef = useRef(0);
  /** The stop being shrunk back, so it can be animated after deselection. */
  const lastFocus = useRef<string | null>(null);
  /** Which bead id stands for each member stop of a station. */
  const stationRep = useMemo(() => {
    const rep = new Map<string, string>();
    if (feed) for (const st of stations(feed, activeRouteIds))
      for (const id of st.stopIds) rep.set(id, st.stopIds[0]!);
    return rep;
  }, [feed, activeRouteIds]);
  /** Everything the look of the map depends on, gathered once. */
  const symbolState = (): MapState => ({
    dark: darkRef.current,
    stopFocus: selectionRef.current?.kind === "stop" ? selectionRef.current.id : null,
    routeFocus: selectionRef.current?.kind === "route" ? selectionRef.current.id : null,
    ridden: overlayRef.current?.rides.map((r) => r.routeId) ?? [],
    ends: rideEnds(overlayRef.current, stationRep),
    grow: growRef.current,
  });
  const selectionRef = useRef<Selection | null>(null);
  selectionRef.current = selection ?? null;
  const overlayRef = useRef<Overlay | null>(null);
  overlayRef.current = overlay ?? null;
  // A counter, not a boolean: setStyle falls back to a full reload when its
  // diff is not applicable, which drops every layer we added. Incrementing on
  // each styledata lets the drawing effects re-run and rebuild them.
  const [ready, setReady] = useState(0);
  const [zoom, setZoom] = useState(14.2);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const dark = usePrefersDark();
  const darkRef = useRef(dark);
  darkRef.current = dark;

  /**
   * One marker per PLACE, positioned on the line as DRAWN.
   *
   * Passio splits a stop into a pair per direction, so joined on stop_id those
   * read as two single-route dots where there is really one interchange.
   * `stations` merges them.
   *
   * Rebuilt whenever the routes are, because the bundler moves a route
   * wherever it shares a street and the geometry it produces depends on the
   * zoom -- a stop placed once and left alone drifts off the line as soon as
   * the rider zooms. Nothing positioned along a route may read `route.shape`.
   */
  /**
   * Draw each route, fanned apart where it genuinely shares a street.
   *
   * Routes arrive snapped to OSM road centrelines (scripts/snap-to-streets.ts),
   * so two on one street have IDENTICAL geometry and "same street" is an
   * equality on a segment rather than a guess from proximity. All this has to
   * decide is which lane, in src/render/lanes.ts.
   *
   * `line-offset` IS used now. An earlier comment here said it was deliberately
   * avoided because it puts the offset vertex on the miter and spikes at sharp
   * corners -- but that was written when the input was Passio's traced shape,
   * where the offset had to fight geometry it did not understand. Offsetting by
   * hand cost a miter limit, a bevel, fold trimming, a resampling step and a
   * lane hold, and STILL held the gap in metres so it grew from 3.7px at zoom
   * 13 to 13.5px at zoom 18. The GPU does it in pixels, correctly, for free.
   */
  function drawRoutes(m: maplibregl.Map, zoom: number) {
    const shapes = shapesRef.current;
    if (shapes.size === 0) return;
    // The geometry drawn is the ROAD CENTRELINE. MapLibre displaces it by
    // `line-offset`, in pixels, on the GPU -- so the gap is the same width at
    // every zoom by construction rather than by arithmetic, and corners are
    // joined properly instead of being offset by hand and repaired after.
    //
    // Only the snapping copy depends on scale: a stop has to sit on the line a
    // rider SEES, which is the centreline displaced.
    const mpp = metresPerPixel(CAMPUS.lat, zoom);
    drawnRef.current = laneApprox(shapes, LANE_GAP_PX, mpp);
    // Same geometry, same moment: the stops are placed from `drawn` right here
    // rather than once at startup, so they cannot drift off the line.
    const stopSrc = m.getSource("stops") as maplibregl.GeoJSONSource | undefined;
    const tickSrc = m.getSource("station-ticks") as maplibregl.GeoJSONSource | undefined;
    if (stopSrc && feed) {
      const { beads, ticks } = stationFeatures(feed, activeRouteIds, drawnRef.current);
      stopSrc.setData({ type: "FeatureCollection", features: beads });
      tickSrc?.setData({ type: "FeatureCollection", features: ticks });
    }
    const rideSrc = m.getSource("itin-ride") as maplibregl.GeoJSONSource | undefined;
    if (rideSrc)
      rideSrc.setData({ type: "FeatureCollection",
                        features: rideFeatures(feed, overlayRef.current, drawnRef.current) });

    // One feature per RUN of constant lane. A route changes lane only where
    // another joins or leaves it, so a run is a stretch carrying the same set
    // of routes; runs overlap by a node so they meet on screen.
    const data: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: laneRuns(shapes, LANE_GAP_PX).map((run) => ({
        type: "Feature",
        properties: {
          routeId: run.routeId,
          color: colorRef.current.get(run.routeId) ?? "#888",
          laneOffset: run.offsetPx,
        },
        geometry: { type: "LineString", coordinates: run.path.map((q) => [q.lng, q.lat]) },
      })),
    };

    const src = m.getSource("routes") as maplibregl.GeoJSONSource | undefined;
    if (src) { src.setData(data); return; }
    m.addSource("routes", { type: "geojson", data });
    // Corner rounding lives HERE, in screen space, not in the coordinates.
    // `line-join: round` rounds each joint by half the stroke width, in
    // PIXELS, identically at every zoom -- the same thing CSS and SVG call
    // stroke-linejoin. Rounding the geometry instead moves the route off its
    // street to fake the effect, and a radius in metres is ~22px of
    // corner-cutting at z18 and 1.6px at z14: wrong in both directions.
    //
    // So the radius is set by the stroke width, and this is why the line is as
    // thick as it is: Apple's transit lines are heavy for exactly this reason.
    // Fan coincident routes apart by a CONSTANT number of pixels.
    //
    // Constant is the whole point: a gap that changes with zoom is the same
    // mistake as sizing anything else in metres. An earlier version faded the
    // offset out by z16, reasoning that the ~7m by which Passio's shapes
    // already differ separates them on its own up close -- which is true, and
    // irrelevant, because it made the gap grow as you zoomed out. line-offset
    // is already in screen pixels, so the lane alone is the whole expression.
    // Constant from z13 up -- interpolate holds its last stop, so the gap does
    // not change as the rider zooms in. Below z13 it winds down to nothing.
    //
    // That lower taper is not decoration, it is the only way to avoid a spike.
    // MapLibre places an offset vertex on the MITER, so a corner of interior
    // angle t extends by offset / sin(t/2): Brown's sharpest corner is 60
    // degrees, which turns a 5px offset into a 10px whisker. The whisker is a
    // fixed pixel length whatever the zoom, so once the whole network is only
    // ~150px across at z11 it is 7% of the map and the routes read as a spiky
    // blob. Verified by setting the offset to 0 at runtime: the spikes vanish.
    //
    // Nothing is lost by tapering it: at city zoom the routes are a few pixels
    // apart regardless and a lane cannot be read anyway.
    // Thin the stroke when zoomed out, as any transit map does -- a 6px line
    // on a network 150px wide is 4% of it and reads as a blob.
    // The line's own width lives in routeLinePaint(), which is what this layer
    // is painted from; only the casing is set here. Declaring a `lineWidth`
    // beside it looked like it did something and did not -- the width change
    // it was meant to carry never reached the map.
    const caseWidth: maplibregl.ExpressionSpecification =
      ["interpolate", ["linear"], ["zoom"], 11, 3.5, 14, 6.5, 16, 10];
    m.addLayer({
      id: "routes-case", type: "line", source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": darkRef.current ? "#15110F" : "#FFFFFF",
        "line-width": caseWidth, "line-opacity": 0.9,
        "line-offset": ["get", "laneOffset"],
        "line-opacity-transition": { duration: 220, delay: 0 },
      },
    });
    m.addLayer({
      id: "routes-line", type: "line", source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: routeLinePaint(symbolState()),
    });
    // A 6px line is not a thumb target, and until now there was no hit layer
    // for the routes at all: a tap on a line matched nothing, fell through to
    // the map's own click handler and DESELECTED instead of selecting.
    m.addLayer({
      id: "routes-hit", type: "line", source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#000", "line-opacity": 0, "line-width": 24,
               "line-offset": ["get", "laneOffset"] },
    });
    m.on("click", "routes-hit", (e: maplibregl.MapLayerMouseEvent) => {
      if (pressHandled.current) return;      // this click ended a long press
      // A stop sitting on the line is the more specific target and wins.
      // MapLibre dispatches every matching layer handler independently, so
      // without this both fire and the route overwrites the stop.
      if (m.getLayer("stops-hit")
          && m.queryRenderedFeatures(e.point, { layers: ["stops-hit"] }).length) return;
      const id = e.features?.[0]?.properties?.["routeId"];
      if (id) routeCb.current?.(String(id));
    });
    m.on("mouseenter", "routes-hit", () => { m.getCanvas().style.cursor = "pointer"; });
    m.on("mouseleave", "routes-hit", () => { m.getCanvas().style.cursor = ""; });
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
    // The lane gap is a pixel quantity, so the geometry it produces depends on
    // the scale and has to be rebuilt as the rider zooms. Following the gesture
    // rather than waiting for zoomend keeps the lines from sliding the moment a
    // pinch ends; the threshold keeps it to a handful of rebuilds per level.
    m.on("zoom", () => {
      const z = m.getZoom();
      setZoom((prev) => (Math.abs(z - prev) < 0.15 ? prev : z));
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
    // Long press (or right click) drops a pin, as on Apple Maps.
    let pressTimer: ReturnType<typeof setTimeout> | undefined;
    let pressStart: { x: number; y: number } | null = null;
    // Releasing a long press produces a click too, and that click used to run
    // the deselect handler -- so letting go immediately threw away the pin the
    // press had just dropped, along with the directions planned for it. The
    // press marks the click that follows it as already spent.
    const cancelPress = () => { if (pressTimer) clearTimeout(pressTimer); pressTimer = undefined; };
    const beginPress = (at: { lat: number; lng: number }) => {
      pressTimer = setTimeout(() => {
        pressHandled.current = true;
        clickCb.current?.(at);
        pressTimer = undefined;
      }, LONG_PRESS_MS);
    };

    // Read the handler from a ref so changing it never tears down the map.
    m.on("click", (e) => {
      if (pressHandled.current) { pressHandled.current = false; return; }
      // Ask what was actually hit rather than relying on preventDefault:
      // MapLibre dispatches the layer handler and this one independently, so
      // a tap on a stop was opening the stop card AND dropping a pin.
      const hitLayers = ["stops-hit", "routes-hit", "poi-hit"].filter((l) => m.getLayer(l));
      if (hitLayers.length && m.queryRenderedFeatures(e.point, { layers: hitLayers }).length) return;
      // A plain tap never drops a pin -- that is a long press. It backs out of
      // whatever is selected, and App decides what that means; if nothing is
      // selected this does nothing.
      clearCb.current?.();
    });

    m.on("mousedown", (e) => {
      pressStart = { x: e.point.x, y: e.point.y };
      beginPress({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });
    m.on("touchstart", (e) => {
      if (e.points.length !== 1) return;      // pinch, not a press
      pressStart = { x: e.point.x, y: e.point.y };
      beginPress({ lat: e.lngLat.lat, lng: e.lngLat.lng });
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
      pressHandled.current = true;            // the click that follows is spent
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

    // Route lines are added before the stops layer so a stop is never buried
    // under the line it belongs to.
    const active = [...feed.routes.values()].filter(
      (r) => activeRouteIds.has(r.id) && r.shape.length >= 2);
    // Which routes share which stretches of street: the costly half, and it
    // does not depend on the zoom, so it is kept out of the per-zoom redraw.
    shapesRef.current = new Map(active.map((r) => [r.id, r.shape]));
    colorRef.current = new Map(active.map((r) => [r.id, r.color]));

    try {
      drawRoutes(m, zoomRef.current);

      if (!m.getSource("stops")) {
        // One marker per PLACE, not per stop_id: Passio splits a stop into a
        // pair per direction, and joined on id those read as two single-route
        // dots where there is really one interchange. Coloured by the line it
        // serves, neutral and larger when it serves several -- the convention
        // the Underground and the NYC subway map both use.
        const { beads, ticks } = stationFeatures(feed, activeRouteIds, drawnRef.current);
        m.addSource("stops", { type: "geojson",
          data: { type: "FeatureCollection", features: beads } });
        m.addSource("station-ticks", { type: "geojson",
          data: { type: "FeatureCollection", features: ticks } });
        // The interchange bar, drawn UNDER the beads so they sit on it like
        // beads on a wire. Two layers because a MapLibre line has no stroke:
        // the wider one is the outline, the narrower one the body -- the same
        // white-bar-with-a-dark-edge the Underground map uses.
        // The bar has to be WIDER than the beads, not narrower. A first attempt
        // drew it 11px across under beads 17px across spread over a 23px span:
        // it rendered, and not one pixel of it was ever visible. Sized to the
        // bead's own outer diameter (2 * radius + stroke) the body sits flush
        // with them and the case shows as an outline all the way round, which
        // is the enclosing capsule the Underground map draws.
        // The pill is LIGHT in both themes. The first two attempts painted its
        // body the map's own background colour, so in dark mode it was a
        // background-coloured shape with a 2px rim -- invisible by
        // construction, whatever its width. A station symbol has to contrast
        // with the map, not match it, which is why the Underground draws it
        // white on white paper with a heavy dark edge.
        // One symbol, two cases. A station is a light lozenge with a thin dark
        // edge carrying one solid dot per line it serves; a stop on a single
        // line is the same thing with the lozenge collapsed to a circle. They
        // were drifting apart -- a heavy black capsule for an interchange next
        // to a light hollow ring for a lone stop reads as two unrelated
        // symbols rather than two cases of one. Sizes below are shared with
        // the stops-base circle so the two constructions stay identical.
        m.addLayer({ id: "station-tick-case", type: "line", source: "station-ticks",
          minzoom: 13,
          layout: { "line-cap": "round" },
          paint: tickPaint(symbolState(), true) });
        m.addLayer({ id: "station-tick", type: "line", source: "station-ticks",
          minzoom: 13,
          layout: { "line-cap": "round" },
          paint: tickPaint(symbolState(), false) });
        // The lone-stop case of that same lozenge.
        // Lone stops only. An interchange takes its background from the bar
        // joining its beads, so giving each bead its own circle as well turned
        // every interchange into a cluster of overlapping circles.
        m.addLayer({ id: "stops-base", type: "circle", source: "stops", minzoom: 13,
          filter: ["!", ["get", "interchange"]],
          paint: stopBasePaint(symbolState()) });
        m.addLayer({ id: "stops", type: "circle", source: "stops", minzoom: 13,
          paint: stopPaint(symbolState()) });
        // A 5px dot is too small for a thumb; an invisible wider circle takes taps.
        m.addLayer({ id: "stops-hit", type: "circle", source: "stops", minzoom: 13,
          paint: { "circle-radius": 14, "circle-opacity": 0 } });
        m.on("click", "stops-hit", (e: maplibregl.MapLayerMouseEvent) => {
          if (pressHandled.current) return;  // this click ended a long press
          const f = e.features?.[0];
          const id = f?.properties?.["id"];
          if (id) stopCb.current?.(String(id));
        });
        m.on("mouseenter", "stops-hit", () => { m.getCanvas().style.cursor = "pointer"; });
        m.on("mouseleave", "stops-hit", () => { m.getCanvas().style.cursor = ""; });
      }
    } catch { /* style churn; the next render rebuilds */ }
  }, [feed, ready, activeRouteIds]);

  // The lane gap and the corner radius are pixel quantities, so the geometry
  // they produce is only right for the zoom it was built at. Rebuilding it here
  // is what keeps a gap and a corner the same size at every scale.
  //
  // Deliberately NOT gated on isStyleLoaded(): that returns false at the exact
  // moment the zoom event fires and only turns true a few hundred ms later, so
  // gating on it skipped every single zoom and left the lines -- and the buses
  // snapped to them -- holding whatever scale they last managed to run at.
  // Declared BEFORE the bus effect so drawnRef is fresh when the markers move.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !m.getSource("routes") || shapesRef.current.size === 0) return;
    try { drawRoutes(m, zoom); } catch { /* style churn; the next render redraws */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, ready]);

  // live buses. Markers are DOM elements the map merely positions, so this
  // needs no style at all -- and gating it on isStyleLoaded() left every bus
  // parked on the geometry of whatever zoom it last managed to run at.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const jump = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Only buses on routes this map actually draws.
    //
    // Passio reports vehicles on routes it does not publish a line for --
    // measured 2026-08-29, a Charter bus on route 6868, whose GTFS entry has
    // no shape at all, plus SEAS on 3528. Drawn anyway, that is a shuttle
    // marker floating on no line, snapped against an empty shape, which taps
    // through to a route page with nothing on it. A rider cannot board a
    // charter; showing it is a claim that they can.
    //
    // Filtered ONCE, because the sweep below removes any marker whose bus is
    // gone from this same list -- skipping them in the loop alone would leave
    // the marker behind forever.
    const shown = buses.filter((b) => activeRouteIds.has(b.routeId));
    for (const b of shown) {
      const color = feed?.routes.get(b.routeId)?.color ?? "#241C17";
      // Onto the line as DRAWN -- bundled into its lane and corner-rounded --
      // not the raw shape. Drawing one geometry and snapping to another is
      // exactly how buses ended up beside their own route before. Falls back
      // to the raw shape only before the first draw.
      const shape = drawnRef.current.get(b.routeId)
        ?? feed?.routes.get(b.routeId)?.shape ?? [];
      const at = snapToShape({ lat: b.lat, lng: b.lng }, shape);
      let mk = busMarks.current.get(b.id);
      if (!mk) {
        // A real button: role="button" on a div is announced but cannot be
        // reached or activated by keyboard or assistive tech.
        const el = document.createElement("button");
        el.type = "button";
        el.className = "display";
        // So a bus can be joined to its route when checking what got drawn.
        // Matching them by COLOUR instead is how a broken layout measured
        // clean three times running: several Brown routes share one.
        el.dataset["routeId"] = b.routeId;
        // 30x30 box, dot centred in it, so MapLibre's centre anchor lands the
        // dot on the coordinate.
        //
        // position MUST stay absolute. Assigning cssText replaces the whole
        // inline style, and an inline `position: relative` overrides
        // `.maplibregl-marker { position: absolute }` -- which takes every
        // marker out of the layer MapLibre positions and drops it into normal
        // document flow, where the markers lay out side by side. Measured on
        // the live map: the first bus sat on its route and each next one was
        // painted a further 30px right of its coordinate, one marker width
        // apart. It reads exactly like "the buses are off their routes", and it
        // survived because the marker's transform still held the RIGHT
        // coordinate -- only the painted pixel was wrong. Absolute is a
        // positioning context for the arrow just as relative was.
        el.style.cssText =
          "position:absolute;width:30px;height:30px;padding:0;border:0;background:none;cursor:pointer";
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
          // border-box, or the 2.5px border grows the 22px dot to 27px and its
          // centre lands at 17.5 in a box whose centre is 15 -- every bus drawn
          // 2.5px down and right of where the feed put it.
          `position:absolute;left:4px;top:4px;width:22px;height:22px;box-sizing:border-box;` +
          `border-radius:50%;` +
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
        // Glide, rather than teleport. The coordinate is what moves: MapLibre
        // rewrites the element's transform on every map move, so a CSS
        // transition on that transform would also smear the bus across the
        // screen whenever the rider pans or zooms.
        //
        // From where the dot is NOW, not from the last fix -- interrupting a
        // glide mid-way and restarting from the old fix would jerk it
        // backwards. pointAlongShape walks the route's polyline between the
        // two, so a bus rounding a corner goes round it.
        const here = mk.getLngLat();
        const from = { lat: here.lat, lng: here.lng };
        const marker = mk;
        if (jump || (from.lat === at.lat && from.lng === at.lng)) {
          marker.setLngLat([at.lng, at.lat]);
        } else {
          let began: number | null = null;
          const frame = (now: number) => {
            began ??= now;
            const t = Math.min(1, (now - began) / GLIDE_MS);
            const p = pointAlongShape(shape, from, at, t);
            marker.setLngLat([p.lng, p.lat]);
            if (t < 1) busGlides.current.set(b.id, requestAnimationFrame(frame));
            else busGlides.current.delete(b.id);
          };
          busGlides.current.set(b.id, requestAnimationFrame(frame));
        }
        const el = mk.getElement();
        const arrow = el.firstElementChild as HTMLElement | null;
        if (arrow) arrow.style.transform = `rotate(${b.bearing}deg)`;
        // Re-apply the COLOUR, not just the position. This effect does not wait
        // for `feed` -- deliberately, so a bus is never held back by the static
        // zip -- so vehicles that arrive first are built with the fallback ink.
        // Setting the colour only at creation left them grey for the rest of
        // the session, and realtime beats the zip almost every load. It went
        // unseen all weekend only because no bus was running to be grey.
        const dot = el.children[1] as HTMLElement | undefined;
        if (dot && dot.style.background !== color) dot.style.background = color;
        const head = arrow?.querySelector("path");
        if (head && head.getAttribute("fill") !== color) head.setAttribute("fill", color);
        el.setAttribute("aria-label",
          `Bus ${b.label} on ${feed?.routes.get(b.routeId)?.name ?? "route"}` +
          (b.totalCap ? `, ${b.paxLoad} of ${b.totalCap} seats taken` : "") + ". See route.");
      }
    }
    for (const [id, mk] of busMarks.current)
      if (!shown.some((b) => b.id === id)) { mk.remove(); busMarks.current.delete(id); }

    // Runs before the next pass of this effect as well as on unmount, so it is
    // both "a newer fix supersedes the glide in flight" and "do not leave a
    // loop calling setLngLat on a marker the map has already removed".
    return () => {
      for (const h of busGlides.current.values()) cancelAnimationFrame(h);
      busGlides.current.clear();
    };
  }, [buses, feed, ready, zoom, activeRouteIds]);

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

    const feature = lineFeature;
    const addSource = (id: string, features: GeoJSON.Feature[]) =>
      m.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features } });

    try {
      // A slice of the route's own shape, which is exactly what the route line
      // under it is drawn from, so the two coincide with nothing to reconcile.
      const rides = overlay.rides.filter((r) => r.path.length > 1);
      if (rides.length) {
        addSource("itin-ride", rideFeatures(feed, overlay, drawnRef.current));
        m.addLayer({ id: "itin-ride-case", type: "line", source: "itin-ride",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": darkRef.current ? "#15110F" : "#FFFFFF", "line-width": 11 } });
        m.addLayer({ id: "itin-ride-line", type: "line", source: "itin-ride",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": ["get", "color"], "line-width": 6 } });
      }
      // Routed legs only. A leg that could not be routed is drawn as NOTHING,
      // not as a straight line through the buildings: a dotted line from A to
      // B is a claim about a path that was never found, and with two routers
      // and a cache the honest gap is rare and brief. Same rule as the
      // timetable times -- prefer drawing nothing to drawing a guess.
      const walks = overlay.walks.filter((w) => !w.provisional && w.path.length > 1);
      if (walks.length) {
        addSource("itin-walk", walks.map((w) => feature(w.path)));
        m.addLayer({ id: "itin-walk", type: "line", source: "itin-walk",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": darkRef.current ? "#F0E9E3" : "#241C17",
                   "line-width": 4, "line-dasharray": [0.4, 1.8] } });
      }
      if (m.getLayer("itin-walk")) m.setPaintProperty("itin-walk", "line-color", dark ? "#F0E9E3" : "#241C17");
    } catch { /* style churn */ }
    // `overlay` belongs here. This effect BUILDS the itinerary's sources out
    // of it, and without it in the deps the sources were only ever rebuilt
    // when the theme flipped or the feed reloaded -- so the walking legs, which
    // arrive a moment after the trip is chosen, had nothing to put them on the
    // map. The ride line survived only because a separate effect pushes ride
    // geometry through overlayRef; the walk had no such second path, which is
    // exactly why the dotted line was the part that went missing.
  }, [dark, ready, feed, overlay]);

  // One owner of emphasis, for every layer at once.
  //
  // There used to be a route-only version of this and nothing at all for
  // stops, so selecting a stop changed nothing on the map and a rider had no
  // idea what they had tapped. Routes, stops and vehicles all read the same
  // `selection`, so they can never disagree about what is picked out.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !feed) return;
    const routeFocus = selection?.kind === "route" ? selection.id : null;
    const stopFocus = selection?.kind === "stop" ? selection.id : null;
    // A chosen trip narrows the map the same way selecting a route does. It
    // did not before, so the itinerary's own line was drawn over a full-
    // strength network and the rider had to pick their ride out of five
    // equally bright lines -- most of why this view read as messy.
    // A stop belongs to its routes, so selecting one keeps those at full
    // strength: the rider wants to see where it can take them.
    const stopRoutesLit = stopFocus
      ? (stationFeatures(feed, activeRouteIds, drawnRef.current).beads.find((f) => f.properties?.["id"] === stopFocus)
          ?.properties?.["routes"] as string | undefined) ?? ""
      : "";

    // Recessive, not invisible. At 0.15 an unselected stop was indistinguishable
    // from the basemap, so picking a route did not narrow the map so much as
    // erase most of it -- and a rider could no longer see the stop they were
    // about to want. Apple keeps the rest of the network legible underneath.
    // Re-applied from the SAME functions the layers were created with, so a
    // symbol cannot have one look when it is drawn and another when it is
    // emphasised. That divergence is exactly how an interchange dot ended up
    // at 3.5 against a lone stop's 2.5 while the shapes under them agreed.
    const st = symbolState();
    const apply = (layer: string, paint: Record<string, unknown>) => {
      if (!m.getLayer(layer)) return;
      for (const [prop, value] of Object.entries(paint))
        // Transitions are declared once when the layer is made; re-setting one
        // mid-tween restarts it.
        if (!prop.endsWith("-transition"))
          // MapLibre's paint-property union cannot be satisfied from a plain
          // record; the symbol module is what keeps these honest.
          (m.setPaintProperty as (l: string, p: string, v: unknown) => void)(layer, prop, value);
    };
    try {
      apply("routes-line", routeLinePaint(st));
      if (m.getLayer("routes-case"))
        m.setPaintProperty("routes-case", "line-opacity", selection ? 0.3 : 0.9);
      apply("stops", stopPaint(st));
      apply("stops-base", stopBasePaint(st));
      apply("station-tick", tickPaint(st, false));
      apply("station-tick-case", tickPaint(st, true));
    } catch { /* style churn; the next render re-applies */ }

    // Vehicles are DOM markers, so they fade in CSS rather than in paint.
    for (const [id, mk] of busMarks.current) {
      const bus = buses.find((b) => b.id === id);
      const lit = !selection
        || (routeFocus ? bus?.routeId === routeFocus
                       : stopRoutesLit.includes(`|${bus?.routeId}|`));
      const el = mk.getElement();
      // Same 220ms as the paint transitions, or the vehicles snap while the
      // lines under them fade.
      el.style.transition = "opacity .22s ease";
      el.style.opacity = lit ? "1" : String(DIM);
    }
  }, [selection, buses, overlay, ready, feed]);

  // Frame the chosen trip. Without this the rider has to hunt for their own
  // itinerary on the map, which defeats the point of drawing it.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !focus || focus.length === 0) return;
    const b = new maplibregl.LngLatBounds();
    for (const p of focus) b.extend([p.lng, p.lat]);
    m.fitBounds(b, {
      padding: framePadding(),
      maxZoom: 16.5, duration: 650,
    });
  }, [focus, ready]);

  // Grow the selected dot into place rather than jumping to it.
  //
  // Not a paint transition and not a DOM marker. MapLibre's transitions were
  // measurable on a line layer but never visibly moved these circles, and the
  // marker attempt fought MapLibre for the element's `transform` -- the same
  // failure that once laid the bus markers out in document flow. A tween that
  // writes the radius every frame is a thing that can be watched happening.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const target = selection?.kind === "stop" ? selection.id : null;
    // Nothing selected and nothing to shrink back: do not ask for frames at
    // all. An animation loop that runs when there is nothing to animate is
    // just a battery drain with a timer attached.
    if (!target && !lastFocus.current) return;
    let raf = 0;
    // -1, not 0, and tested with `< 0`. A frame timestamp of 0 is falsy, so
    // `if (!start)` re-took the start time on every frame until one happened to
    // be non-zero -- the tween then measured from the SECOND frame and could
    // stall entirely. Browsers pass large timestamps so this never bit in
    // production, which is exactly why it survived: only a test that drives the
    // clock itself can see it.
    let start = -1;
    const step = (now: number) => {
      if (start < 0) start = now;
      const k = Math.min(1, (now - start) / SELECT_MS);
      // Ease out: quick off the mark, settling rather than stopping dead.
      growRef.current = target ? 1 - (1 - k) ** 3 : (1 - k) ** 3;
      try {
        if (m.getLayer("stops"))
          m.setPaintProperty("stops", "circle-radius",
            selectedRadius(target ?? lastFocus.current, growRef.current,
                           rideEnds(overlayRef.current, stationRep)));
      } catch { /* style churn; the next selection re-applies */ }
      if (k < 1) raf = requestAnimationFrame(step);
      else if (!target) lastFocus.current = null;
    };
    raf = requestAnimationFrame(step);
    if (target) lastFocus.current = target;
    return () => cancelAnimationFrame(raf);
  }, [selection, ready]);

  // Frame a selected route the same way. Picking a route used to leave the
  // camera wherever it was, so most of the line sat behind the sheet and the
  // rider had to drag the map to see what they had just selected -- the
  // itinerary view has framed its own result for ages and the two should not
  // behave differently. Skipped while an itinerary is showing, since that has
  // already framed something more specific.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || focus) return;
    if (selection?.kind !== "route") return;
    const path = drawnRef.current.get(selection.id);
    if (!path || path.length < 2) return;
    const b = new maplibregl.LngLatBounds();
    for (const p of path) b.extend([p.lng, p.lat]);
    m.fitBounds(b, {
      padding: framePadding(),
      maxZoom: 16.5, duration: 650,
    });
    // Deliberately keyed on the route id alone: refitting on every redraw
    // would yank the camera back each time the rider panned or zoomed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection?.kind === "route" ? selection.id : null, ready]);

  return <div ref={div} style={{ position: "absolute", inset: 0 }} />;
}
