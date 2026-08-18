/** Bare debug map: see what the API actually returns.
 *
 *  NOT objective 3. No design, no polish -- this exists so the data is
 *  visible: route shapes, stops, live buses, and what the router picks.
 *  Click once for origin, twice for destination. */
import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./reset.css";
import { fetchStaticFeed } from "../data/gtfs";
import { findItineraries } from "../routing/trip";
import { GTFS_VEHICLES_URL, httpGetBytes } from "../data/passio";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { StaticFeed, LatLng, Itinerary } from "../data/types";

const ACTIVE = new Set(["3302", "3469", "3470", "22427", "62487"]);
const BROWN: [number, number] = [-71.4015, 41.8265];

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

interface Bus { id: string; label: string; routeId: string; lat: number; lng: number; bearing: number }

async function fetchVehicles(): Promise<Bus[]> {
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
    await httpGetBytes(GTFS_VEHICLES_URL));
  return feed.entity.flatMap((e) => {
    const v = e.vehicle;
    if (!v?.position) return [];
    return [{
      id: v.vehicle?.id ?? "", label: v.vehicle?.label ?? "?",
      routeId: v.trip?.routeId ?? "",
      lat: v.position.latitude, lng: v.position.longitude,
      bearing: v.position.bearing ?? 0,
    }];
  });
}

const clock = (t: number) =>
  new Date(t * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const mins = (s: number) => `${Math.round(s / 60)}m`;

export default function DebugMap() {
  const mapDiv = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const pins = useRef<maplibregl.Marker[]>([]);
  const busMarkers = useRef<Map<string, maplibregl.Marker>>(new Map());

  const [feed, setFeed] = useState<StaticFeed | null>(null);
  const [buses, setBuses] = useState<Bus[]>([]);
  const [pts, setPts] = useState<LatLng[]>([]);
  const [its, setIts] = useState<Itinerary[] | null>(null);
  const [status, setStatus] = useState("loading GTFS…");

  // map init
  useEffect(() => {
    if (!mapDiv.current || map.current) return;
    const m = new maplibregl.Map({ container: mapDiv.current, style: OSM_STYLE, center: BROWN, zoom: 14 });
    m.addControl(new maplibregl.NavigationControl(), "top-right");
    m.on("click", (e: maplibregl.MapMouseEvent) => setPts((p) => (p.length >= 2 ? [] : [...p, { lat: e.lngLat.lat, lng: e.lngLat.lng }])));
    map.current = m;

    // MapLibre measures its container once at construction. If layout has not
    // settled yet it locks in a wrong size and renders into a corner, so watch
    // the container and tell it to re-measure.
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(mapDiv.current);
    return () => { ro.disconnect(); m.remove(); map.current = null; };
  }, []);

  // load static feed, draw routes + stops
  useEffect(() => {
    fetchStaticFeed().then((f) => {
      setFeed(f);
      const m = map.current;
      if (!m) return;
      const draw = () => {
        for (const r of f.routes.values()) {
          if (!ACTIVE.has(r.id) || r.shape.length < 2) continue;
          const id = `route-${r.id}`;
          if (m.getSource(id)) continue;
          m.addSource(id, {
            type: "geojson",
            data: { type: "Feature", properties: {},
              geometry: { type: "LineString", coordinates: r.shape.map((p) => [p.lng, p.lat]) } },
          });
          m.addLayer({ id, type: "line", source: id,
            paint: { "line-color": r.color, "line-width": 4, "line-opacity": 0.75 } });
        }
        const feats = [...f.stops.values()].map((s) => ({
          type: "Feature" as const, properties: { name: s.name },
          geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
        }));
        if (!m.getSource("stops")) {
          m.addSource("stops", { type: "geojson", data: { type: "FeatureCollection", features: feats } });
          m.addLayer({ id: "stops", type: "circle", source: "stops",
            paint: { "circle-radius": 4, "circle-color": "#fff", "circle-stroke-color": "#333", "circle-stroke-width": 2 } });
          m.on("click", "stops", (e: maplibregl.MapLayerMouseEvent) => {
            const p = e.features?.[0];
            if (p) new maplibregl.Popup().setLngLat(e.lngLat).setText(String(p.properties?.["name"])).addTo(m);
          });
        }
        setStatus(`${[...f.routes.values()].filter((r) => ACTIVE.has(r.id)).length} routes, ${f.stops.size} stops`);
      };
      m.isStyleLoaded() ? draw() : m.on("load", draw);
    }).catch((e) => setStatus(`GTFS failed: ${e.message}`));
  }, []);

  // live buses, polled
  useEffect(() => {
    const tick = () => fetchVehicles().then(setBuses).catch(() => {});
    tick();
    const h = setInterval(tick, 10_000);
    return () => clearInterval(h);
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const b of buses) {
      const color = feed?.routes.get(b.routeId)?.color ?? "#e2002d";
      let mk = busMarkers.current.get(b.id);
      if (!mk) {
        const el = document.createElement("div");
        el.style.cssText = `width:26px;height:26px;border-radius:50%;background:${color};` +
          `border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);color:#fff;` +
          `font:700 10px system-ui;display:flex;align-items:center;justify-content:center`;
        el.textContent = b.label;
        mk = new maplibregl.Marker({ element: el }).setLngLat([b.lng, b.lat]).addTo(m);
        busMarkers.current.set(b.id, mk);
      } else mk.setLngLat([b.lng, b.lat]);
    }
    for (const [id, mk] of busMarkers.current)
      if (!buses.some((b) => b.id === id)) { mk.remove(); busMarkers.current.delete(id); }
  }, [buses, feed]);

  // origin/destination pins + routing
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    pins.current.forEach((p) => p.remove());
    pins.current = pts.map((p, i) =>
      new maplibregl.Marker({ color: i === 0 ? "#1a7f37" : "#cf222e" }).setLngLat([p.lng, p.lat]).addTo(m));

    if (m.getLayer("itin")) { m.removeLayer("itin"); m.removeSource("itin"); }
    if (pts.length < 2) { setIts(null); return; }

    setStatus("routing…");
    findItineraries(pts[0]!, pts[1]!)
      .then((r) => {
        setIts(r);
        setStatus(r.length ? `${r.length} itinerary option(s)` : "no itineraries — nothing connects these points now");
        const best = r[0];
        if (!best) return;
        const coords: [number, number][] = [];
        for (const ride of best.rides) {
          const trip = feed?.trips.get(ride.tripId);
          const shape = feed?.routes.get(ride.routeId)?.shape ?? [];
          if (trip && shape.length) coords.push(...shape.map((p) => [p.lng, p.lat] as [number, number]));
        }
        if (coords.length < 2) return;
        m.addSource("itin", { type: "geojson",
          data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } } });
        m.addLayer({ id: "itin", type: "line", source: "itin",
          paint: { "line-color": "#000", "line-width": 8, "line-opacity": 0.35 } });
      })
      .catch((e) => setStatus(`routing failed: ${e.message}`));
  }, [pts, feed]);

  return (
    <div style={{ position: "fixed", inset: 0, font: "13px/1.45 system-ui, sans-serif" }}>
      <div ref={mapDiv} style={{ position: "absolute", inset: 0 }} />
      <div style={{
        position: "absolute", top: 10, left: 10, width: 330, maxHeight: "88vh", overflowY: "auto",
        background: "rgba(255,255,255,.96)", borderRadius: 10, padding: "12px 14px",
        boxShadow: "0 2px 12px rgba(0,0,0,.25)", zIndex: 1,
      }}>
        <strong>busbus debug</strong>
        <div style={{ color: "#555", margin: "4px 0 8px" }}>{status}</div>
        <div style={{ color: "#555", marginBottom: 8 }}>
          {pts.length === 0 && "Click the map to set ORIGIN."}
          {pts.length === 1 && "Click again to set DESTINATION."}
          {pts.length === 2 && "Click once more to reset."}
        </div>
        <div style={{ marginBottom: 8 }}>{buses.length} bus(es) live</div>

        {its?.map((it, n) => (
          <div key={n} style={{ borderTop: "1px solid #ddd", paddingTop: 8, marginTop: 8 }}>
            <div><strong>arrive {clock(it.arriveTime)}</strong> · leave by {clock(it.departTime)}</div>
            <div style={{ color: "#555" }}>{mins(it.totalWalkSeconds)} walking · {it.transfers} transfer(s)</div>
            {it.rides.map((r, i) => (
              <div key={i} style={{ marginTop: 4 }}>
                <span style={{
                  display: "inline-block", width: 10, height: 10, borderRadius: 3, marginRight: 6,
                  background: feed?.routes.get(r.routeId)?.color ?? "#888",
                }} />
                {feed?.routes.get(r.routeId)?.name ?? r.routeId} {r.live ? "· live" : "· scheduled"}
                <div style={{ color: "#555", marginLeft: 16 }}>
                  {clock(r.departTime)} {feed?.stops.get(r.boardStopId)?.name}<br />
                  {clock(r.arriveTime)} {feed?.stops.get(r.alightStopId)?.name}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
