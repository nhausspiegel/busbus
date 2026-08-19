import { useCallback, useEffect, useMemo, useState } from "react";
import "./theme.css";
import { TransitMap, CAMPUS, type Overlay } from "./TransitMap";
import { Sheet, type Detent } from "./Sheet";
import { SearchBar } from "./SearchBar";
import { ItineraryList, ItineraryDetail } from "./Itineraries";
import { NearbyBoard } from "./NearbyBoard";
import { RouteDetail } from "./RouteDetail";
import { WhenControl } from "./WhenControl";
import { StopCard } from "./StopCard";
import { AlertBanner } from "./AlertBanner";
import { fetchAlerts, type Alert } from "../data/alerts";
import { fetchStaticFeed } from "../data/gtfs";
import { fetchLiveDepartures } from "../data/realtime";
import { fetchVehicles, type Bus } from "../data/vehicles";
import { serviceDayStart, scheduledDepartures, buildBoard } from "../data/departures";
import { nearbyDepartures } from "../routing/nearby";
import { routeStops } from "../routing/routeDetail";
import { walkGeometry } from "../routing/walk";
import { planBetween } from "../routing/trip";
import { sliceShape } from "../routing/shape";
import type { Place } from "../data/geocode";
import type { StaticFeed, DepartureBoard, LatLng, Itinerary } from "../data/types";

/** Routes Passio lists as not archived. GTFS ships every route Brown ever
 *  configured, including two with no trips at all. */
const ACTIVE = new Set(["3302", "3469", "3470", "22427", "62487"]);
const VEHICLE_POLL_MS = 10_000;
const BOARD_POLL_MS = 30_000;

type Mode = "nearby" | "results" | "detail" | "route" | "stop";

export default function App() {
  const [feed, setFeed] = useState<StaticFeed | null>(null);
  const [board, setBoard] = useState<DepartureBoard>(new Map());
  const [buses, setBuses] = useState<Bus[]>([]);
  const [me, setMe] = useState<LatLng | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [detent, setDetent] = useState<Detent>("peek");
  const [notice, setNotice] = useState<string | null>(null);

  const [dest, setDest] = useState<{ at: LatLng; label: string } | null>(null);
  const [itineraries, setItineraries] = useState<Itinerary[] | null>(null);
  const [chosen, setChosen] = useState<Itinerary | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [planning, setPlanning] = useState(false);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [stopId, setStopId] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  /** null means "leave now"; a Date plans for later today. */
  const [leaveAt, setLeaveAt] = useState<Date | null>(null);

  const mode: Mode =
    stopId ? "stop" : routeId ? "route" : chosen ? "detail" : dest ? "results" : "nearby";
  const origin = me ?? CAMPUS;

  useEffect(() => {
    fetchStaticFeed().then(setFeed).catch(() =>
      setNotice("Couldn't load the shuttle timetable. Check your connection and reload."));
  }, []);

  useEffect(() => {
    if (!feed) return;
    let cancelled = false;
    const load = async () => {
      const live = await fetchLiveDepartures().catch(() => []);
      if (!cancelled) setBoard(buildBoard(live, scheduledDepartures(feed, serviceDayStart(leaveAt ?? new Date()))));
    };
    load();
    const h = setInterval(load, BOARD_POLL_MS);
    return () => { cancelled = true; clearInterval(h); };
  }, [feed, leaveAt]);

  useEffect(() => {
    const tick = () => fetchVehicles().then(setBuses).catch(() => setBuses([]));
    tick();
    const h = setInterval(tick, VEHICLE_POLL_MS);
    return () => clearInterval(h);
  }, []);

  // Service alerts change rarely; once a minute is plenty and stays polite.
  useEffect(() => {
    const tick = () => fetchAlerts(Math.floor(Date.now() / 1000)).then(setAlerts).catch(() => {});
    tick();
    const h = setInterval(tick, 60_000);
    return () => clearInterval(h);
  }, []);

  useEffect(() => {
    const h = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(h);
  }, []);

  const locate = useCallback(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => { setMe({ lat: p.coords.latitude, lng: p.coords.longitude }); setNotice(null); },
      () => setNotice("Location is off, so this is showing stops near campus instead."),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, []);
  useEffect(() => { locate(); }, [locate]);

  /** The clock the whole screen reasons from: real now, or the planned time. */
  const planNow = leaveAt ? Math.floor(leaveAt.getTime() / 1000) : now;

  const nearby = useMemo(
    () => (feed ? nearbyDepartures(feed, board, origin, planNow, 6) : []),
    [feed, board, origin, planNow]);

  // Plan whenever the destination changes. Walking times come from Valhalla,
  // one matrix call per end rather than one call per candidate stop.
  useEffect(() => {
    if (!feed || !dest) { setItineraries(null); return; }
    let cancelled = false;
    setPlanning(true);
    (async () => {
      try {
        const found = await planBetween(feed, board, origin, dest.at, leaveAt ?? new Date());
        if (!cancelled) setItineraries(found);
      } catch {
        if (!cancelled) {
          setItineraries([]);
          setNotice("Couldn't work out walking times just now. Try again in a moment.");
        }
      } finally {
        if (!cancelled) setPlanning(false);
      }
    })();
    return () => { cancelled = true; };
  }, [feed, dest, board, origin, leaveAt]);

  // Draw the chosen trip: real sidewalk geometry for the walks, and only the
  // ridden slice of each route shape.
  useEffect(() => {
    if (!chosen || !feed) { setOverlay(null); return; }
    let cancelled = false;
    const rides = chosen.rides.flatMap((r) => {
      const shape = feed.routes.get(r.routeId)?.shape ?? [];
      const from = feed.stops.get(r.boardStopId);
      const to = feed.stops.get(r.alightStopId);
      if (!from || !to || shape.length < 2) return [];
      return [{ path: sliceShape(shape, from, to), color: feed.routes.get(r.routeId)?.color ?? "#241C17" }];
    });
    // Straight lines first so the trip appears instantly, then upgrade to real
    // sidewalk paths when Valhalla answers.
    // A walk-only trip is a single leg from where you are to where you're going.
    const walkOnly = chosen.rides.length === 0;
    const boardStop = walkOnly ? null : feed.stops.get(chosen.rides[0]?.boardStopId ?? "");
    const alightStop = walkOnly ? null : feed.stops.get(chosen.rides[chosen.rides.length - 1]?.alightStopId ?? "");
    const straight: LatLng[][] = [];
    if (walkOnly && dest) straight.push([origin, dest.at]);
    if (boardStop) straight.push([origin, boardStop]);
    if (alightStop && dest) straight.push([alightStop, dest.at]);
    setOverlay({ walks: straight, rides });

    (async () => {
      try {
        const legs = await Promise.all([
          walkOnly && dest ? walkGeometry(origin, dest.at)
            : boardStop ? walkGeometry(origin, boardStop) : Promise.resolve([]),
          alightStop && dest ? walkGeometry(alightStop, dest.at) : Promise.resolve([]),
        ]);
        const real = legs.filter((l) => l.length > 1);
        if (!cancelled && real.length) setOverlay({ walks: real, rides });
      } catch { /* straight lines are a fine fallback */ }
    })();
    return () => { cancelled = true; };
  }, [chosen, feed, origin, dest]);

  // Everything the chosen trip touches, so the map can frame it.
  const focus = useMemo<LatLng[] | null>(() => {
    if (!overlay) return null;
    const pts = [...overlay.walks.flat(), ...overlay.rides.flatMap((r) => r.path)];
    return pts.length ? pts : null;
  }, [overlay]);

  // Stops on the route being viewed, so the map can draw them as stations.
  const routeStopIds = useMemo(() => {
    if (!feed || !routeId) return undefined;
    return routeStops(feed, board, routeId, planNow).map((r) => r.stop.id);
  }, [feed, board, routeId, planNow]);

  const pickDestination = (at: LatLng, label: string) => {
    setDest({ at, label });
    setChosen(null);
    setDetent("half");
  };

  return (
    <main style={{ position: "fixed", inset: 0, overflow: "hidden" }}>
      <TransitMap
        feed={feed} buses={buses} me={me}
        destination={dest?.at ?? null} overlay={overlay} focus={focus}
        highlightRouteId={routeId} routeStopIds={routeStopIds} activeRouteIds={ACTIVE}
        onRouteClick={(r) => { setRouteId(r); setStopId(null); setDetent("half"); }}
        onStopClick={(id) => { setStopId(id); setRouteId(null); setDetent("half"); }}
        onMapClick={(p) => pickDestination(p, "Dropped pin")}
      />

      <button onClick={locate} aria-label="Center on my location" style={{
        position: "absolute", right: 12, top: "calc(12px + var(--safe-t))",
        width: 42, height: 42, borderRadius: 21, border: "1px solid var(--hairline)",
        background: "var(--raised)", boxShadow: "0 1px 6px rgb(36 28 23 / 18%)",
        display: "grid", placeItems: "center", cursor: "pointer", zIndex: 3,
      }}>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true"
             stroke={me ? "var(--accent)" : "var(--muted)"} strokeWidth="2">
          <circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" fill="currentColor" />
          <path d="M12 1v3M12 20v3M1 12h3M20 12h3" strokeLinecap="round" />
        </svg>
      </button>

      <Sheet
        detent={detent}
        onDetentChange={setDetent}
        header={
          <SearchBar
            destination={dest ? { label: dest.label } : null}
            onPick={(p: Place) => pickDestination(p.at, p.name)}
            onClear={() => { setDest(null); setChosen(null); setStopId(null); setDetent("peek"); }}
          />
        }
      >
        <AlertBanner alerts={alerts} feed={feed} />

        {/* Keyed on mode so switching views animates in rather than jump-cutting. */}
        <div key={mode} className="enter">

        {mode === "nearby" && (
          <>
            <WhenControl at={leaveAt} onChange={setLeaveAt} />
            <NearbyBoard feed={feed} nearby={nearby} buses={buses} now={planNow}
                         loading={!feed} me={!!me} onRouteClick={setRouteId}
                         onLocate={locate} />
          </>
        )}

        {mode === "stop" && feed?.stops.get(stopId!) && (
          <StopCard
            stop={feed.stops.get(stopId!)!} feed={feed} board={board} now={planNow}
            onBack={() => setStopId(null)}
            onRouteClick={(r) => { setStopId(null); setRouteId(r); }}
            onSetDestination={() => {
              const st = feed.stops.get(stopId!)!;
              setStopId(null);
              pickDestination({ lat: st.lat, lng: st.lng }, st.name);
            }}
          />
        )}

        {mode === "route" && (
          <RouteDetail feed={feed} board={board} routeId={routeId!} buses={buses}
                       now={planNow} onBack={() => setRouteId(null)} />
        )}

        {mode === "results" && (
          <>
            <div className="eyebrow">To {dest!.label}</div>
            <h1 className="display" style={{ fontSize: 28, margin: "4px 0 12px" }}>
              {planning ? "Finding shuttles…"
                : itineraries?.length ? "Soonest arrival first" : "No shuttle route"}
            </h1>
            {!planning && itineraries?.length === 0 && (
              <p style={{ color: "var(--muted)", fontSize: 14, margin: 0 }}>
                No shuttle connects here, and it is too far to walk. Daytime routes run
                weekdays 7am–7pm; the Evening routes are suspended for the summer.
              </p>
            )}
            {itineraries && itineraries.length > 0 && (
              <ItineraryList itineraries={itineraries} feed={feed} now={planNow}
                             onSelect={(i) => { setChosen(i); setDetent("half"); }} />
            )}
          </>
        )}

        {mode === "detail" && chosen && (
          <ItineraryDetail itinerary={chosen} feed={feed} now={planNow} onBack={() => setChosen(null)} />
        )}
        </div>
      </Sheet>
    </main>
  );
}
