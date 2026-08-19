import { clock, minsUntil } from "./format";
import { routeStops } from "../routing/routeDetail";
import type { StaticFeed, DepartureBoard } from "../data/types";
import { occupancyLabel, type Bus } from "../data/vehicles";
import { fullness } from "../data/occupancy";

export function RouteDetail({
  feed, board, routeId, buses, now, onBack,
}: {
  feed: StaticFeed | null; board: DepartureBoard; routeId: string;
  buses: Bus[]; now: number; onBack: () => void;
}) {
  const route = feed?.routes.get(routeId);
  const stops = feed ? routeStops(feed, board, routeId, now) : [];
  const onRoute = buses.filter((b) => b.routeId === routeId);

  return (
    <div>
      <button onClick={onBack} style={{
        border: 0, background: "transparent", color: "var(--accent)", fontWeight: 600,
        fontSize: 14, cursor: "pointer", padding: "0 0 10px",
      }}>← Back</button>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span aria-hidden="true" style={{
          width: 6, height: 30, borderRadius: 3, background: route?.color ?? "var(--muted)" }} />
        <div>
          <h2 className="display" style={{ fontSize: 27, margin: 0 }}>{route?.name ?? routeId}</h2>
          <div className="eyebrow" style={{ marginTop: 2 }}>
            {stops.length} stops
            {onRoute.length > 0
              ? <> · <span className="pulse" /> {onRoute.length} running</>
              : " · none running"}
          </div>
        </div>
      </div>

      {onRoute.length > 0 && (
        <ul style={{ listStyle: "none", display: "flex", gap: 8, flexWrap: "wrap",
                     margin: "12px 0 0", padding: 0 }}>
          {onRoute.map((b) => (
            <li key={b.id} style={{
              display: "flex", alignItems: "center", gap: 7, fontSize: 13,
              background: "var(--paper)", border: "1px solid var(--hairline)",
              borderRadius: 999, padding: "4px 11px",
            }}>
              <span className="pulse" aria-hidden="true" />
              Bus {b.label}
              {(() => {
                // Exact counts when Passio gives them, the coarse GTFS-RT enum
                // otherwise. "3/20 · 15%" tells a rider whether to wait for
                // the next one; "FEW_SEATS_AVAILABLE" does not.
                const f = fullness(b.paxLoad, b.totalCap);
                if (f) return (
                  <span style={{ color: "var(--muted)" }}>
                    · {b.paxLoad}/{b.totalCap}{f.pct !== null ? ` · ${f.label}` : ""}
                  </span>
                );
                const coarse = occupancyLabel(b.occupancy);
                return coarse ? <span style={{ color: "var(--muted)" }}>· {coarse}</span> : null;
              })()}
            </li>
          ))}
        </ul>
      )}

      {onRoute.length === 0 && (
        <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--muted)" }}>
          No bus is reporting on this route, so the times below come from the timetable
          only. They are a plan rather than a promise.
        </p>
      )}

      <ol style={{ listStyle: "none", margin: "14px 0 0", padding: 0 }}>
        {stops.map(({ stop, next }, i) => (
          <li key={stop.id} style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
            {/* One continuous rail with a node per stop, so this reads as a
                route rather than a list. The rail must span the FULL row
                height -- padding on the row would break the line between
                stops and leave disconnected blobs. */}
            <span aria-hidden="true" style={{
              position: "relative", width: 14, flexShrink: 0, minHeight: 38,
            }}>
              <span style={{
                position: "absolute", left: 5, top: i === 0 ? "50%" : 0,
                bottom: i === stops.length - 1 ? "50%" : 0,
                width: 4, background: route?.color ?? "var(--muted)",
              }} />
              <span style={{
                position: "absolute", left: 0, top: "50%", marginTop: -7,
                width: 14, height: 14, borderRadius: 7, background: "var(--raised)",
                border: `3.5px solid ${route?.color ?? "var(--muted)"}`, boxSizing: "border-box",
              }} />
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 14, alignSelf: "center",
                           padding: "9px 0" }}>{stop.name}</span>
            {next ? (
              <span style={{ display: "flex", alignItems: "center", gap: 8, alignSelf: "center" }}>
                {next.live && <span className="pulse" aria-hidden="true" />}
                <span className={`when ${next.live ? "when--live" : "when--sched"}`}
                      style={{ fontSize: 22, minWidth: 40, textAlign: "right" }}>
                  {minsUntil(next.time, now) === 0 ? "now" : minsUntil(next.time, now)}
                </span>
                <span style={{ fontSize: 11, color: "var(--muted)", width: 46 }}>
                  {minsUntil(next.time, now) === 0 ? "" : `min · ${clock(next.time)}`}
                </span>
              </span>
            ) : (
              <span style={{ fontSize: 12, color: "var(--muted)", alignSelf: "center" }}>no service</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
