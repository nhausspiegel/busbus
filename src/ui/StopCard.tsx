import { clock, minsUntil } from "./format";
import { bestObserved, type ServiceHistory } from "../data/serviceHistory";
import { stopRoutes } from "../routing/routeDetail";
import { stopBoard } from "../routing/stopBoard";
import type { StaticFeed, DepartureBoard, Stop } from "../data/types";

/** What can I catch from this stop. */
export function StopCard({
  stop, feed, board, now, history = null, onBack, onRouteClick, onSetDestination,
}: {
  stop: Stop; feed: StaticFeed | null; board: DepartureBoard; now: number;
  /** What service has actually been seen here, when the site has a record. */
  history?: ServiceHistory | null;
  onBack: () => void;
  onRouteClick: (routeId: string) => void;
  onSetDestination: () => void;
}) {
  const departures = stopBoard(board, stop.id, now);
  const watched = history
    ? bestObserved(history, feed ? (stopRoutes(feed).get(stop.id) ?? []) : [], new Date(now * 1000))
    : null;

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
          No shuttle is reporting from this stop right now. Brown's timetable
          claims every route runs daily all year, so it cannot tell you whether
          one is actually coming — only a bus reporting its own position can.
          {/* The record CAN speak about other days, and this is where a rider
              asks: standing at the stop, deciding whether to wait. Reported for
              the best-served route here, since that is the one their wait
              depends on -- and still only what was seen, never a promise. */}
          {watched && (
            <>{" "}
              {feed?.routes.get(watched.routeId)?.name ?? "A shuttle"} has been seen
              here around this time on {watched.seen} of the {watched.days} days
              watched so far.
            </>
          )}
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
                }. See route.`}
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
                <span className="pulse" aria-hidden="true" />
                <span className="when when--live"
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
