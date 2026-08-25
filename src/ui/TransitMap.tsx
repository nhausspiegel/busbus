/** The map layer: route lines, stops, live buses, and the rider's own dot. */
import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { StaticFeed, LatLng } from "../data/types";
import type { Bus } from "../data/vehicles";
import { basemapStyle } from "./mapStyle";
import { pointAlongShape, snapToShape, sliceShape } from "../routing/shape";
import { haversineMeters } from "../routing/walk";
import { stations } from "../routing/routeDetail";
import { laneProfiles, applyLanes, DEFAULT_OPTIONS, type LaneProfile, type Pt }
  from "../render/bundle";

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

/** Minimum clear space between routes sharing a street, in screen pixels. A
 *  floor, not a target: routes already further apart than this are left alone,
 *  so two genuinely parallel streets are never dragged together. */
const LANE_GAP_PX = 5;

/** Corner radius for every turn, in screen pixels. Constant at every zoom, the
 *  way the Underground and the NYC subway map draw a line. */
const CORNER_RADIUS_PX = 10;

/** Ground metres one screen pixel covers at this latitude and zoom. */
function metresPerPixel(lat: number, zoom: number): number {
  return (156_543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

// The bundler works in a flat metric plane, so route coordinates are projected
// into local metres about the campus and back. Over a few kilometres the error
// is far below a pixel, and it keeps the geometry out of degrees, where a
// "constant" offset would silently change size with latitude.
const M_PER_DEG_LAT = 111_320;
const mPerDegLng = M_PER_DEG_LAT * Math.cos((41.8265 * Math.PI) / 180);
const toPlane = (p: LatLng): Pt => ({ x: p.lng * mPerDegLng, y: p.lat * M_PER_DEG_LAT });
const fromPlane = (p: Pt): LatLng => ({ lng: p.x / mPerDegLng, lat: p.y / M_PER_DEG_LAT });

/** A LineString feature from lat/lng points. GeoJSON is [lng, lat]. */
const lineFeature = (
  c: LatLng[], properties: GeoJSON.GeoJsonProperties = {},
): GeoJSON.Feature => ({
  type: "Feature", properties,
  geometry: { type: "LineString", coordinates: c.map((p) => [p.lng, p.lat]) },
});

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
  const profilesRef = useRef<LaneProfile[]>([]);
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
  function stationFeatures(f: StaticFeed): {
    beads: GeoJSON.Feature[]; ticks: GeoJSON.Feature[];
  } {
    const beads: GeoJSON.Feature[] = [];
    const ticks: GeoJSON.Feature[] = [];
    for (const st of stations(f, activeRouteIds)) {
      const centre = { lat: st.lat, lng: st.lng };
      // ONE bead per line the station serves, each on THAT line's own lane.
      // Snapping the whole station onto the first route's geometry put the dot
      // on one line and left it floating beside every other line it serves --
      // the bundler fans them into separate lanes, so "the stop" was several
      // metres from most of its own routes.
      const on = st.routeIds.map((routeId) => {
        const line = drawnRef.current.get(routeId);
        return { routeId,
                 at: line && line.length > 1 ? snapToShape(centre, line) : centre };
      });
      for (const b of on) beads.push({
        type: "Feature" as const,
        properties: {
          name: st.name,
          // The tap target still needs a real stop, so every bead of a station
          // carries the same first member id -- the halves are genuinely
          // different boarding points, but they are one place to tap.
          id: st.stopIds[0]!,
          // Pipe-delimited so a MapLibre expression can test membership:
          // ["in", "|3302|", ["get", "routes"]]. Passing the ids in as a prop
          // instead meant the map could not emphasise anything the parent had
          // not thought to precompute.
          routes: `|${st.routeIds.join("|")}|`,
          interchange: st.routeIds.length > 1,
          // Always the colour of the line this bead sits on. A neutral dot for
          // an interchange is the Underground's convention, but Brown has 12
          // interchanges out of 23 stations, so it greyed out the majority of
          // the map and told the rider nothing about which lines call there.
          color: f.routes.get(b.routeId)?.color ?? "#6F625A",
        },
        geometry: { type: "Point" as const, coordinates: [b.at.lng, b.at.lat] },
      });

      if (on.length < 2) continue;
      // The Underground's interchange tick: one bar through every bead, so the
      // station visibly touches every line it serves instead of being a dot
      // near some of them. Ordered along the axis between the two furthest
      // beads, otherwise a three-line station zigzags.
      const pts = on.map((b) => b.at);
      let a = pts[0]!, z = pts[1]!, far = -1;
      for (const u of pts) for (const v of pts) {
        const d = haversineMeters(u, v);
        if (d > far) { far = d; a = u; z = v; }
      }
      // All the beads coincide -- below z13 the lane gap is zero -- so there is
      // no gap for a tick to span.
      if (far < 0.5) continue;
      const ax = z.lng - a.lng, ay = z.lat - a.lat;
      const along = [...pts].sort((u, v) =>
        ((u.lng - a.lng) * ax + (u.lat - a.lat) * ay) - ((v.lng - a.lng) * ax + (v.lat - a.lat) * ay));
      ticks.push({
        type: "Feature" as const,
        properties: { id: st.stopIds[0]!, routes: `|${st.routeIds.join("|")}|` },
        geometry: { type: "LineString" as const,
                    coordinates: along.map((q) => [q.lng, q.lat]) },
      });
    }
    return { beads, ticks };
  }

  /**
   * Draw each route, fanned apart only where it genuinely shares a street.
   *
   * The lane geometry comes from src/render/bundle.ts, which enforces a
   * MINIMUM separation rather than an exact one: a route running alone does
   * not move at all, and two routes already further apart than the minimum --
   * genuinely different parallel streets -- are left where they are. The
   * minimum is a pixel quantity, so it is converted to metres at the current
   * scale and the geometry is rebuilt when the zoom changes.
   *
   * MapLibre's own `line-offset` is deliberately NOT used. It places the
   * offset vertex on the miter, so a corner of interior angle t extends by
   * offset / sin(t/2) -- at Brown's sharpest corner, 1.9x -- and that miter is
   * the spike that made five earlier attempts at this unusable.
   */
  /**
   * The ridden portion of each route, taken from the line as DRAWN.
   *
   * It used to be sliced from `feed.routes.get(id).shape` -- the raw Passio
   * geometry -- while the route underneath was drawn from the bundler's
   * output, which deliberately moves a route wherever it shares a street. So
   * the itinerary's line and the route's own line were two different
   * geometries for the same road, stacked a few metres apart. Everything
   * positioned along a route reads the geometry that was drawn; this was the
   * last thing still reading the raw shape.
   */
  function rideFeatures(f: StaticFeed | null, o: Overlay | null): GeoJSON.Feature[] {
    if (!o) return [];
    return o.rides.flatMap((r) => {
      const drawn = drawnRef.current.get(r.routeId);
      const from = r.boardStopId ? f?.stops.get(r.boardStopId) : undefined;
      const to = r.alightStopId ? f?.stops.get(r.alightStopId) : undefined;
      const path = drawn && drawn.length > 1 && from && to
        ? sliceShape(drawn, from, to)
        : r.path;
      if (path.length < 2) return [];
      return [lineFeature(path, { color: r.color, routeId: r.routeId })];
    });
  }

  function drawRoutes(m: maplibregl.Map, zoom: number) {
    const profiles = profilesRef.current;
    if (profiles.length === 0) return;
    // Below z13 the whole network is a couple of hundred pixels wide and the
    // strokes are 2px; a lane cannot be read, and 5px of ground at that scale
    // is nearly 200m of displacement.
    // Both are PIXEL quantities converted to ground units at this scale, so a
    // gap and a corner look the same at every zoom. Baking either in as metres
    // is what pulled the routes off their streets in five earlier attempts.
    const mpp = metresPerPixel(CAMPUS.lat, zoom);
    const minGap = zoom < 13 ? 0 : LANE_GAP_PX * mpp;
    const radius = CORNER_RADIUS_PX * mpp;

    const drawn = new Map<string, LatLng[]>();
    for (const p of profiles)
      drawn.set(p.id, applyLanes(p, minGap, radius).map(fromPlane));
    drawnRef.current = drawn;
    // Same geometry, same moment: the stops are placed from `drawn` right here
    // rather than once at startup, so they cannot drift off the line.
    const stopSrc = m.getSource("stops") as maplibregl.GeoJSONSource | undefined;
    const tickSrc = m.getSource("station-ticks") as maplibregl.GeoJSONSource | undefined;
    if (stopSrc && feed) {
      const { beads, ticks } = stationFeatures(feed);
      stopSrc.setData({ type: "FeatureCollection", features: beads });
      tickSrc?.setData({ type: "FeatureCollection", features: ticks });
    }
    const rideSrc = m.getSource("itin-ride") as maplibregl.GeoJSONSource | undefined;
    if (rideSrc)
      rideSrc.setData({ type: "FeatureCollection",
                        features: rideFeatures(feed, overlayRef.current) });

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
    const lineWidth: maplibregl.ExpressionSpecification =
      ["interpolate", ["linear"], ["zoom"], 11, 2, 14, 6];
    const caseWidth: maplibregl.ExpressionSpecification =
      ["interpolate", ["linear"], ["zoom"], 11, 3.5, 14, 10];
    m.addLayer({
      id: "routes-case", type: "line", source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": darkRef.current ? "#15110F" : "#FFFFFF",
        "line-width": caseWidth, "line-opacity": 0.9,
        "line-opacity-transition": { duration: 220, delay: 0 },
      },
    });
    m.addLayer({
      id: "routes-line", type: "line", source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"], "line-width": lineWidth,
        // Switching from one route to another repainted both in a single
        // frame: the old one blinked out and the new one blinked in. These
        // carry the change over 220ms instead.
        "line-opacity-transition": { duration: 220, delay: 0 },
        "line-width-transition": { duration: 220, delay: 0 },
      },
    });
    // A 6px line is not a thumb target, and until now there was no hit layer
    // for the routes at all: a tap on a line matched nothing, fell through to
    // the map's own click handler and DESELECTED instead of selecting.
    m.addLayer({
      id: "routes-hit", type: "line", source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#000", "line-opacity": 0, "line-width": 24 },
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
    profilesRef.current = laneProfiles(
      active.map((r) => ({ id: r.id, points: r.shape.map(toPlane) })), DEFAULT_OPTIONS);
    colorRef.current = new Map(active.map((r) => [r.id, r.color]));

    try {
      drawRoutes(m, zoomRef.current);

      if (!m.getSource("stops")) {
        // One marker per PLACE, not per stop_id: Passio splits a stop into a
        // pair per direction, and joined on id those read as two single-route
        // dots where there is really one interchange. Coloured by the line it
        // serves, neutral and larger when it serves several -- the convention
        // the Underground and the NYC subway map both use.
        const { beads, ticks } = stationFeatures(feed);
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
          paint: {
            "line-opacity-transition": { duration: 220, delay: 0 },
            "line-color": darkRef.current ? "#0B0908" : "#241C17",
            "line-width": ["interpolate", ["linear"], ["zoom"], 13, 11, 16, 19],
          } });
        m.addLayer({ id: "station-tick", type: "line", source: "station-ticks",
          minzoom: 13,
          layout: { "line-cap": "round" },
          paint: {
            "line-opacity-transition": { duration: 220, delay: 0 },
            "line-color": darkRef.current ? "#F0E9E3" : "#FFFFFF",
            "line-width": ["interpolate", ["linear"], ["zoom"], 13, 9, 16, 16],
          } });
        // The lone-stop case of that same lozenge.
        m.addLayer({ id: "stops-base", type: "circle", source: "stops", minzoom: 13,
          filter: ["!", ["get", "interchange"]],
          paint: {
            "circle-opacity-transition": { duration: 220, delay: 0 },
            "circle-radius-transition": { duration: 220, delay: 0 },
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 4.5, 16, 8],
            "circle-color": darkRef.current ? "#F0E9E3" : "#FFFFFF",
            "circle-stroke-color": darkRef.current ? "#0B0908" : "#241C17",
            "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 13, 1, 16, 1.5],
          } });
        m.addLayer({ id: "stops", type: "circle", source: "stops", minzoom: 13,
          paint: {
            // Selecting a stop used to snap: radius and opacity jumped between
            // frames with nothing in between. MapLibre tweens a paint property
            // when it changes, including a data-driven one, so declaring the
            // transitions here is the whole animation.
            "circle-radius-transition": { duration: 220, delay: 0 },
            "circle-opacity-transition": { duration: 220, delay: 0 },
            "circle-stroke-opacity-transition": { duration: 220, delay: 0 },
            // An interchange reads one step larger, as it does on the
            // Underground map, so a transfer point is findable without reading
            // any labels.
            // The dot, identical in both cases: solid, in its line's colour,
            // sitting on the lozenge.
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 16, 4.5],
            "circle-color": ["get", "color"],
            "circle-stroke-color": darkRef.current ? "#F0E9E3" : "#FFFFFF",
            // Matched to the route line's own width at street zoom, so a stop
            // reads as a bead ON the line rather than a separate dot beside it.
            "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 13, 0.6, 16, 1.2],
          } });
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
    const jump = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const b of buses) {
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
        el.setAttribute("aria-label",
          `Bus ${b.label} on ${feed?.routes.get(b.routeId)?.name ?? "route"}` +
          (b.totalCap ? `, ${b.paxLoad} of ${b.totalCap} seats taken` : "") + ". See route.");
      }
    }
    for (const [id, mk] of busMarks.current)
      if (!buses.some((b) => b.id === id)) { mk.remove(); busMarks.current.delete(id); }

    // Runs before the next pass of this effect as well as on unmount, so it is
    // both "a newer fix supersedes the glide in flight" and "do not leave a
    // loop calling setLngLat on a marker the map has already removed".
    return () => {
      for (const h of busGlides.current.values()) cancelAnimationFrame(h);
      busGlides.current.clear();
    };
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

    const feature = lineFeature;
    const addSource = (id: string, features: GeoJSON.Feature[]) =>
      m.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features } });

    try {
      // A slice of the route's own shape, which is exactly what the route line
      // under it is drawn from, so the two coincide with nothing to reconcile.
      const rides = overlay.rides.filter((r) => r.path.length > 1);
      if (rides.length) {
        addSource("itin-ride", rideFeatures(feed, overlay));
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
  }, [dark, ready, feed]);

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
    const ridden = overlay?.rides.map((r) => r.routeId) ?? [];
    const tripLit: maplibregl.ExpressionSpecification | null = ridden.length
      ? ["in", ["get", "routeId"], ["literal", ridden]] : null;
    // A stop belongs to its routes, so selecting one keeps those at full
    // strength: the rider wants to see where it can take them.
    const stopRoutesLit = stopFocus
      ? (stationFeatures(feed).beads.find((f) => f.properties?.["id"] === stopFocus)
          ?.properties?.["routes"] as string | undefined) ?? ""
      : "";

    // Recessive, not invisible. At 0.15 an unselected stop was indistinguishable
    // from the basemap, so picking a route did not narrow the map so much as
    // erase most of it -- and a rider could no longer see the stop they were
    // about to want. Apple keeps the rest of the network legible underneath.
    const DIM = 0.38;
    try {
      if (m.getLayer("routes-line")) {
        m.setPaintProperty("routes-line", "line-opacity",
          routeFocus ? ["case", ["==", ["get", "routeId"], routeFocus], 1, DIM]
          : stopFocus ? ["case", ["in", ["concat", "|", ["get", "routeId"], "|"],
                                  stopRoutesLit], 1, DIM]
          // During a trip EVERY route fades, the ridden one included: the
          // segment the rider is actually on is drawn brightly on top by
          // itin-ride, and leaving the whole loop at full strength made the
          // two impossible to tell apart. The rest of the route stays visible,
          // just quiet, so the line can still be followed past the ride.
          : tripLit ? DIM
          : 1);
        m.setPaintProperty("routes-line", "line-width",
          routeFocus ? ["case", ["==", ["get", "routeId"], routeFocus], 8, 4] : 6);
        m.setPaintProperty("routes-case", "line-opacity",
          selection ? 0.3 : 0.9);
      }
      if (m.getLayer("stops")) {
        const mine: maplibregl.ExpressionSpecification = routeFocus
          ? ["in", `|${routeFocus}|`, ["get", "routes"]]
          : ["literal", true];
        // The tapped stop grows and stays solid; everything else recedes. That
        // is the whole answer to "which one did I just tap".
        // During a trip the ridden routes' stops stay legible; everything
        // else recedes. Intermediate stops are deliberately NOT hidden -- a
        // rider wants to see what they are passing.
        const onTrip: maplibregl.ExpressionSpecification | null = ridden.length
          ? ["any", ...ridden.map((r): maplibregl.ExpressionSpecification =>
              ["in", `|${r}|`, ["get", "routes"]])] : null;
        m.setPaintProperty("stops", "circle-opacity",
          stopFocus ? ["case", ["==", ["get", "id"], stopFocus], 1, DIM]
          : routeFocus ? ["case", mine, 1, DIM]
          : onTrip ? ["case", onTrip, 1, DIM] : 1);
        m.setPaintProperty("stops", "circle-stroke-opacity",
          stopFocus ? ["case", ["==", ["get", "id"], stopFocus], 1, DIM]
          : routeFocus ? ["case", mine, 1, DIM]
          : onTrip ? ["case", onTrip, 1, DIM] : 1);
        // No `interchange` branch here. The dot is the same size in both
        // cases -- what differs is the lozenge underneath it. This effect
        // re-set the radius on every selection change and was still carrying
        // the old branching, silently overriding the layer's own unified
        // sizing: measured at z14.2, an interchange dot came out at 3.5 and a
        // lone stop's at 2.5 while their white shapes matched at 14.2px.
        // Sized through `growRef`, which a tween walks from 0 to 1. Setting the
        // final radius here directly is what made selecting a stop snap.
        m.setPaintProperty("stops", "circle-radius",
          selectedRadius(stopFocus, growRef.current, rideEnds(overlay ?? null, stationRep)));
      }
      for (const id of ["stops-base"]) {
        if (!m.getLayer(id)) continue;
        m.setPaintProperty(id, "circle-opacity",
          stopFocus ? ["case", ["==", ["get", "id"], stopFocus], 1, DIM]
          : routeFocus ? ["case", ["in", `|${routeFocus}|`, ["get", "routes"]], 1, DIM] : 1);
        m.setPaintProperty(id, "circle-stroke-opacity",
          stopFocus ? ["case", ["==", ["get", "id"], stopFocus], 1, DIM]
          : routeFocus ? ["case", ["in", `|${routeFocus}|`, ["get", "routes"]], 1, DIM] : 1);
      }
      for (const id of ["station-tick", "station-tick-case"]) {
        if (!m.getLayer(id)) continue;
        m.setPaintProperty(id, "line-opacity",
          stopFocus ? ["case", ["==", ["get", "id"], stopFocus], 1, DIM]
          : routeFocus ? ["case", ["in", `|${routeFocus}|`, ["get", "routes"]], 1, DIM]
          : 1);
      }
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
      // Leave room for the search bar above and the sheet below.
      padding: { top: 90, bottom: Math.round(window.innerHeight * 0.5), left: 48, right: 48 },
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
    let start = 0;
    const step = (now: number) => {
      if (!start) start = now;
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
      padding: { top: 90, bottom: Math.round(window.innerHeight * 0.5), left: 48, right: 48 },
      maxZoom: 16.5, duration: 650,
    });
    // Deliberately keyed on the route id alone: refitting on every redraw
    // would yank the camera back each time the rider panned or zoomed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection?.kind === "route" ? selection.id : null, ready]);

  return <div ref={div} style={{ position: "absolute", inset: 0 }} />;
}
