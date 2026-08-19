import { useCallback, useEffect, useMemo, useState } from "react";
import "./theme.css";
import { TransitMap, CAMPUS } from "./TransitMap";
import { Sheet, type Detent } from "./Sheet";
import { fetchStaticFeed } from "../data/gtfs";
import { fetchLiveDepartures } from "../data/realtime";
import { fetchVehicles, type Bus } from "../data/vehicles";
import { serviceDayStart, scheduledDepartures, buildBoard } from "../data/departures";
import { nearbyDepartures, type StopDepartures } from "../routing/nearby";
import type { StaticFeed, DepartureBoard, LatLng } from "../data/types";

/** Routes Passio lists as not archived. GTFS ships every route Brown ever
 *  configured, including two with no trips at all. */
const ACTIVE = new Set(["3302", "3469", "3470", "22427", "62487"]);
const VEHICLE_POLL_MS = 10_000;

const minsUntil = (t: number, now: number) => Math.max(0, Math.round((t - now) / 60));
const walkMins = (meters: number) => Math.max(1, Math.round(meters / 78)); // ~4.7 km/h

export default function App() {
  const [feed, setFeed] = useState<StaticFeed | null>(null);
  const [board, setBoard] = useState<DepartureBoard>(new Map());
  const [buses, setBuses] = useState<Bus[]>([]);
  const [me, setMe] = useState<LatLng | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [detent, setDetent] = useState<Detent>("peek");
  const [error, setError] = useState<string | null>(null);

  // static feed
  useEffect(() => {
    fetchStaticFeed().then(setFeed).catch(() =>
      setError("Couldn't load the shuttle timetable. Check your connection and reload."));
  }, []);

  // departures: live merged over the timetable
  useEffect(() => {
    if (!feed) return;
    let cancelled = false;
    const load = async () => {
      const live = await fetchLiveDepartures().catch(() => []);
      if (cancelled) return;
      setBoard(buildBoard(live, scheduledDepartures(feed, serviceDayStart(new Date()))));
    };
    load();
    const h = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(h); };
  }, [feed]);

  // live vehicles
  useEffect(() => {
    const tick = () => fetchVehicles().then(setBuses).catch(() => setBuses([]));
    tick();
    const h = setInterval(tick, VEHICLE_POLL_MS);
    return () => clearInterval(h);
  }, []);

  // ticking clock so countdowns stay honest without re-fetching
  useEffect(() => {
    const h = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(h);
  }, []);

  const locate = useCallback(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => setMe({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => setError("Location is off, so this is showing stops near campus instead."),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, []);
  useEffect(() => { locate(); }, [locate]);

  const origin = me ?? CAMPUS;
  const nearby = useMemo<StopDepartures[]>(
    () => (feed ? nearbyDepartures(feed, board, origin, now, 6) : []),
    [feed, board, origin, now]);

  const anyLive = buses.length > 0;

  return (
    <main style={{ position: "fixed", inset: 0, overflow: "hidden" }}>
      <TransitMap feed={feed} buses={buses} me={me} activeRouteIds={ACTIVE} />

      <button
        onClick={locate}
        aria-label="Center on my location"
        style={{
          position: "absolute", right: 12, top: `calc(12px + var(--safe-t))`,
          width: 42, height: 42, borderRadius: 21, border: "1px solid var(--hairline)",
          background: "var(--raised)", boxShadow: "0 1px 6px rgb(36 28 23 / 18%)",
          display: "grid", placeItems: "center", cursor: "pointer", zIndex: 3,
        }}
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true"
             stroke={me ? "var(--accent)" : "var(--muted)"} strokeWidth="2">
          <circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" fill="currentColor" />
          <path d="M12 1v3M12 20v3M1 12h3M20 12h3" strokeLinecap="round" />
        </svg>
      </button>

      <Sheet detent={detent} onDetentChange={setDetent}>
        <header style={{ marginBottom: 14 }}>
          <div className="eyebrow">
            {me ? "Near you" : "Near campus"}
            {anyLive
              ? <> · <span className="pulse" /> {buses.length} shuttle{buses.length === 1 ? "" : "s"} running</>
              : " · no shuttles reporting"}
          </div>
          <h1 className="display" style={{ fontSize: 30, margin: "4px 0 0" }}>
            Next departures
          </h1>
        </header>

        {error && (
          <p style={{
            background: "var(--warn-bg)", border: "1px solid var(--warn-line)", color: "var(--warn-ink)",
            borderRadius: 8, padding: "8px 10px", fontSize: 13, margin: "0 0 12px",
          }}>{error}</p>
        )}

        {!feed && !error && <p style={{ color: "var(--muted)" }}>Loading the timetable…</p>}

        {feed && nearby.length === 0 && (
          <div style={{ padding: "18px 0", color: "var(--muted)" }}>
            <p style={{ margin: 0, fontSize: 15, color: "var(--ink)" }}>
              No shuttles are scheduled from any stop near here right now.
            </p>
            <p style={{ margin: "6px 0 0", fontSize: 13 }}>
              Daytime routes run weekdays 7am–7pm. The Evening routes are suspended
              for the summer and return in the semester.
            </p>
          </div>
        )}

        {nearby.map(({ stop, meters, departures }) => (
          <article key={stop.id} style={{ borderTop: "1px solid var(--hairline)", padding: "13px 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
              <h2 style={{ font: "600 15px/1.25 Barlow, sans-serif", margin: 0 }}>{stop.name}</h2>
              <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>
                {walkMins(meters)} min walk
              </span>
            </div>

            <ul style={{ listStyle: "none", padding: 0, margin: "9px 0 0", display: "grid", gap: 8 }}>
              {departures.map((d) => {
                const route = feed?.routes.get(d.routeId);
                const mins = minsUntil(d.time, now);
                return (
                  <li key={`${d.tripId}-${d.time}`}
                      style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span aria-hidden="true" style={{
                      width: 4, height: 22, borderRadius: 2, flexShrink: 0,
                      background: route?.color ?? "var(--muted)",
                    }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14, overflow: "hidden",
                                   textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {route?.name ?? d.routeId}
                    </span>
                    {!d.live && (
                      <span style={{ fontSize: 11, color: "var(--muted)" }}>scheduled</span>
                    )}
                    {d.live && <span className="pulse" aria-hidden="true" />}
                    <span className={`when ${d.live ? "when--live" : "when--sched"}`}
                          style={{ fontSize: 26, minWidth: 46, textAlign: "right" }}>
                      {mins === 0 ? "now" : mins}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--muted)", width: 18 }}>
                      {mins === 0 ? "" : "min"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </article>
        ))}

        {feed && nearby.some((n) => n.departures.some((d) => !d.live)) && (
          <p style={{
            marginTop: 14, fontSize: 12, lineHeight: 1.5, color: "var(--muted)",
            borderTop: "1px solid var(--hairline)", paddingTop: 12,
          }}>
            Hollow times come from the printed timetable, not a bus. Brown's feed lists
            every route as running daily year-round, so a scheduled time is not proof
            a shuttle will arrive.
          </p>
        )}
      </Sheet>
    </main>
  );
}
