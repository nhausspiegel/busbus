import { clock, minsUntil } from "./format";
import { stopBoard } from "../routing/stopBoard";
import type { StaticFeed, DepartureBoard, Stop } from "../data/types";

/** What can I catch from this stop. */
export function StopCard({
  stop, feed, board, now, onBack, onRouteClick, onSetDestination,
}: {
  stop: Stop; feed: StaticFeed | null; board: DepartureBoard; now: number;
  onBack: () => void;
  onRouteClick: (routeId: string) => void;
  onSetDestination: () => void;
}) {
  const departures = stopBoard(board, stop.id, now);

  return (
    <div>
      <button onClick={onBack} style={{
        border: 0, background: "transparent", color: "var(--accent)", fontWeight: 600,
        fontSize: 14, cursor: "pointer", padding: "0 0 10px",
      }}>← Back</button>

      <h2 className="display" style={{ fontSize: 27, margin: "0 0 4px" }}>{stop.name}</h2>
      <div className="eyebrow">{departures.length ? "Upcoming departures" : "No upcoming departures"}</div>

      <button onClick={onSetDestination} style={{
        marginTop: 12, border: "1px solid var(--accent)", background: "var(--accent-wash)",
        color: "var(--accent)", borderRadius: 10, padding: "9px 14px",
        fontSize: 14, fontWeight: 600, cursor: "pointer",
      }}>Get directions here</button>

      {departures.length === 0 && (
        <p style={{ marginTop: 12, fontSize: 13, color: "var(--muted)" }}>
          Nothing is scheduled from this stop right now. Try the “leave at” control
          to see when service resumes.
        </p>
      )}

      <ul style={{ listStyle: "none", margin: "14px 0 0", padding: 0, display: "grid", gap: 10 }}>
        {departures.map((d) => {
          const route = feed?.routes.get(d.routeId);
          const mins = minsUntil(d.time, now);
          return (
            <li key={`${d.tripId}-${d.time}`}>
              <button onClick={() => onRouteClick(d.routeId)}
                aria-label={`${route?.name ?? d.routeId}, ${
                  mins === 0 ? "departing now" : `in ${mins} minutes`
                }, ${d.live ? "live" : "scheduled"}. See route.`}
                style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
                         border: 0, background: "transparent", padding: 0, cursor: "pointer",
                         textAlign: "left" }}>
                <span aria-hidden="true" style={{
                  width: 4, height: 24, borderRadius: 2, flexShrink: 0,
                  background: route?.color ?? "var(--muted)" }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 14, overflow: "hidden",
                               textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {route?.name ?? d.routeId}
                </span>
                {d.live
                  ? <span className="pulse" aria-hidden="true" />
                  : <span style={{ fontSize: 11, color: "var(--muted)" }}>scheduled</span>}
                <span className={`when ${d.live ? "when--live" : "when--sched"}`}
                      style={{ fontSize: 24, minWidth: 44, textAlign: "right" }}>
                  {mins === 0 ? "now" : mins}
                </span>
                <span style={{ fontSize: 11, color: "var(--muted)", width: 48 }}>
                  {mins === 0 ? "" : `min · ${clock(d.time)}`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
