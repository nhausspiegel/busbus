import { minsUntil, walkMins } from "./format";
import type { StopDepartures } from "../routing/nearby";
import type { StaticFeed } from "../data/types";
import type { Bus } from "../data/vehicles";

export function NearbyBoard({
  feed, nearby, buses, now, loading, me, onRouteClick,
}: {
  feed: StaticFeed | null; nearby: StopDepartures[]; buses: Bus[];
  now: number; loading: boolean; me: boolean;
  onRouteClick: (routeId: string) => void;
}) {
  const anyLive = buses.length > 0;
  const anyScheduled = nearby.some((n) => n.departures.some((d) => !d.live));

  return (
    <>
      <header style={{ marginBottom: 14 }}>
        <div className="eyebrow">
          {me ? "Near you" : "Near campus"}
          {anyLive
            ? <> · <span className="pulse" /> {buses.length} shuttle{buses.length === 1 ? "" : "s"} running</>
            : " · no shuttles reporting"}
        </div>
        <h1 className="display" style={{ fontSize: 30, margin: "4px 0 0" }}>Next departures</h1>
      </header>

      {loading && <p style={{ color: "var(--muted)" }}>Loading the timetable…</p>}

      {!loading && nearby.length === 0 && (
        <div style={{ padding: "18px 0" }}>
          <p style={{ margin: 0, fontSize: 15 }}>
            No shuttles are scheduled from any stop near here right now.
          </p>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--muted)" }}>
            Daytime routes run weekdays 7am–7pm. The Evening routes are suspended for
            the summer and return in the semester.
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
                <li key={`${d.tripId}-${d.time}`}>
                  <button onClick={() => onRouteClick(d.routeId)}
                    aria-label={`See the ${route?.name ?? d.routeId} route`}
                    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
                             border: 0, background: "transparent", padding: 0, cursor: "pointer",
                             textAlign: "left" }}>
                  <span aria-hidden="true" style={{
                    width: 4, height: 22, borderRadius: 2, flexShrink: 0,
                    background: route?.color ?? "var(--muted)" }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 14, overflow: "hidden",
                                 textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {route?.name ?? d.routeId}
                  </span>
                  {!d.live && <span style={{ fontSize: 11, color: "var(--muted)" }}>scheduled</span>}
                  {d.live && <span className="pulse" aria-hidden="true" />}
                  <span className={`when ${d.live ? "when--live" : "when--sched"}`}
                        style={{ fontSize: 26, minWidth: 46, textAlign: "right" }}>
                    {mins === 0 ? "now" : mins}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--muted)", width: 18 }}>
                    {mins === 0 ? "" : "min"}
                  </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </article>
      ))}

      {anyScheduled && (
        <p style={{ marginTop: 14, fontSize: 12, lineHeight: 1.5, color: "var(--muted)",
                    borderTop: "1px solid var(--hairline)", paddingTop: 12 }}>
          Hollow times come from the printed timetable, not a bus. Brown's feed lists every
          route as running daily year-round, so a scheduled time is not proof a shuttle
          will arrive.
        </p>
      )}
    </>
  );
}
