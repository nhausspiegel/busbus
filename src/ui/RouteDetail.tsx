import { clock, minsUntil } from "./format";
import { routeStops, stations, nextStopIndex, headwayMinutes } from "../routing/routeDetail";
import type { StaticFeed, DepartureBoard } from "../data/types";
import { occupancyLabel, type Bus } from "../data/vehicles";
import { fullness } from "../data/occupancy";
import { describeService, type ServiceHistory } from "../data/serviceHistory";

/** How many departure chips to show. Apple shows three; a fourth pushes the
 *  stop list off the first screen of the sheet. */
const CHIPS = 3;

export function RouteDetail({
  feed, board, routeId, buses, now, activeRouteIds, history = null, onBack,
}: {
  feed: StaticFeed | null; board: DepartureBoard; routeId: string;
  buses: Bus[]; now: number; activeRouteIds: Set<string>;
  /** What service has actually been seen, when the site has a record. */
  history?: ServiceHistory | null;
  onBack: () => void;
}) {
  const route = feed?.routes.get(routeId);
  const stops = feed ? routeStops(feed, board, routeId, now) : [];
  const onRoute = buses.filter((b) => b.routeId === routeId);

  // Departures from the top of the list -- the point the route is measured
  // from, and the same stop `routeStops` anchors its one-vehicle run on.
  const head = stops[0];
  // `d.live` is checked here and not left to the caller. This view prints a
  // minute and labels it Live, which is a claim; the component that makes a
  // claim is the one that has to be able to back it.
  const upcoming = head
    ? (board.get(head.stop.id) ?? [])
        .filter((d) => d.live && d.routeId === routeId && d.time >= now)
        .sort((a, b) => a.time - b.time)
    : [];
  const headway = headwayMinutes(upcoming.map((d) => d.time));

  // Which routes a rider can change to at each stop. Read off the STATION, not
  // the stop_id: Passio splits one place into a per-direction pair, so the
  // connection is usually recorded against the other half.
  const connections = new Map<string, string[]>();
  if (feed) for (const st of stations(feed, activeRouteIds))
    for (const id of st.stopIds) connections.set(id, st.routeIds);

  // Each bus placed in the list's own order, so it can be drawn between the
  // stop it has left and the one it is approaching.
  const shape = route?.shape ?? [];
  const busAt = new Map<number, Bus[]>();
  for (const b of onRoute) {
    const i = nextStopIndex(shape, stops.map((s) => s.stop), b);
    if (i === null) continue;
    busAt.set(i, [...(busAt.get(i) ?? []), b]);
  }
  // Everything before the first bus is behind it, and dimmed.
  const firstBus = busAt.size ? Math.min(...busAt.keys()) : null;

  const load = (b: Bus) => {
    // Exact counts when Passio gives them, the coarse GTFS-RT enum otherwise.
    // "3/20 · 15%" tells a rider whether to wait for the next one;
    // "FEW_SEATS_AVAILABLE" does not.
    const f = fullness(b.paxLoad, b.totalCap);
    if (f) return `${b.paxLoad}/${b.totalCap}${f.pct !== null ? ` · ${f.label}` : ""}`;
    return occupancyLabel(b.occupancy);
  };

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

      {upcoming.length > 0 && (
        <>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between",
                        margin: "16px 0 8px", gap: 12 }}>
            <span className="eyebrow">Upcoming departures</span>
            {headway !== null && (
              <span style={{ fontSize: 12, color: "var(--muted)" }}>Every {headway} min</span>
            )}
          </div>
          <ul style={{ listStyle: "none", display: "flex", gap: 8, flexWrap: "wrap",
                       margin: 0, padding: 0 }}>
            {upcoming.slice(0, CHIPS).map((d) => {
              const mins = minsUntil(d.time, now);
              return (
                <li key={`${d.tripId}-${d.time}`} style={{
                  display: "flex", alignItems: "center", gap: 6, fontSize: 13,
                  background: d.live ? "var(--accent-wash)" : "var(--paper)",
                  border: `1px solid ${d.live ? "var(--accent)" : "var(--hairline)"}`,
                  borderRadius: 999, padding: "5px 12px",
                }}>
                  <span className="pulse" aria-hidden="true" />
                  <span className="when when--live" style={{ fontSize: 15 }}>
                    {mins === 0 ? "now" : mins}
                  </span>
                  {mins !== 0 && <span>min</span>}
                  {/* Not "On-time": a live fix proves the bus is reporting,
                      not that it is running to schedule, and there is nothing
                      left to measure it against. */}
                  <span style={{ color: "var(--muted)" }}>· Live</span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {onRoute.length === 0 && (
        <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--muted)" }}>
          No bus is reporting on this route, so there are no departure times to
          show. The stops below are the route's real order; the timetable is not
          used for times because it claims every route runs daily all year.
          {/* What HAS been seen, when enough has been. This is the only thing
              here that speaks about other days, and it is a record rather
              than a forecast -- it says what happened, never what will. */}
          {history && describeService(history, routeId, new Date(now * 1000)) && (
            <> {describeService(history, routeId, new Date(now * 1000))}</>
          )}
        </p>
      )}

      <ol style={{ listStyle: "none", margin: "18px 0 0", padding: 0 }}>
        {stops.map(({ stop, next }, i) => {
          const here = busAt.get(i);
          const behind = firstBus !== null && i < firstBus;
          const also = (connections.get(stop.id) ?? []).filter((r) => r !== routeId);
          return (
            <li key={stop.id}>
              {/* The vehicle itself, drawn into the rail above the stop it is
                  heading for. Apple Maps does this, and it answers "has it
                  been past yet" without the rider comparing times. */}
              {here && (
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <span aria-hidden="true" style={{ position: "relative", width: 14, flexShrink: 0,
                                                    minHeight: 26 }}>
                    <span style={{ position: "absolute", left: 5, top: 0, bottom: 0, width: 4,
                                   background: route?.color ?? "var(--muted)" }} />
                    <span style={{
                      position: "absolute", left: -3, top: "50%", marginTop: -10,
                      width: 20, height: 20, borderRadius: 10, fontSize: 11,
                      display: "grid", placeItems: "center",
                      background: route?.color ?? "var(--muted)", color: "#fff",
                      border: "2px solid var(--raised)", boxSizing: "border-box",
                    }}>🚌</span>
                  </span>
                  <span style={{ fontSize: 12, color: "var(--muted)", padding: "3px 0" }}>
                    {here.map((b) => {
                      const l = load(b);
                      return `Bus ${b.label}${l ? ` · ${l}` : ""}`;
                    }).join("  ·  ")}
                  </span>
                </div>
              )}
              <div style={{ display: "flex", gap: 12, alignItems: "stretch",
                            opacity: behind ? 0.42 : 1 }}>
                {/* One continuous rail with a node per stop, so this reads as a
                    route rather than a list. The rail must span the FULL row
                    height -- padding on the row would break the line between
                    stops and leave disconnected blobs. */}
                <span aria-hidden="true" style={{
                  position: "relative", width: 14, flexShrink: 0, minHeight: 38,
                }}>
                  <span style={{
                    position: "absolute", left: 5, top: i === 0 && !here ? "50%" : 0,
                    bottom: i === stops.length - 1 ? "50%" : 0,
                    width: 4, background: route?.color ?? "var(--muted)",
                  }} />
                  <span style={{
                    position: "absolute", left: 0, top: "50%", marginTop: -7,
                    width: 14, height: 14, borderRadius: 7, background: "var(--raised)",
                    border: `3.5px solid ${route?.color ?? "var(--muted)"}`, boxSizing: "border-box",
                  }} />
                </span>
                <span style={{ flex: 1, minWidth: 0, alignSelf: "center", padding: "9px 0" }}>
                  <span style={{ fontSize: 14, display: "block", overflow: "hidden",
                                 textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stop.name}</span>
                  {/* Where a rider can change, coloured like the subway maps
                      this borrows from: the badge IS the other line. */}
                  {also.length > 0 && (
                    <span style={{ display: "flex", gap: 5, marginTop: 4, flexWrap: "wrap" }}>
                      {also.map((r) => (
                        <span key={r} title={feed?.routes.get(r)?.name ?? r} style={{
                          fontSize: 10, fontWeight: 700, letterSpacing: ".02em",
                          color: "#fff", background: feed?.routes.get(r)?.color ?? "var(--muted)",
                          borderRadius: 4, padding: "1px 5px",
                        }}>{feed?.routes.get(r)?.shortName || feed?.routes.get(r)?.name || r}</span>
                      ))}
                    </span>
                  )}
                </span>
                {next && next.live ? (
                  // The clock time, not a countdown: this is a list of when the
                  // bus is at each stop down the line, and fourteen counters all
                  // ticking at once is harder to read than fourteen times.
                  <span style={{ display: "flex", alignItems: "center", gap: 8, alignSelf: "center" }}>
                    <span className="pulse" aria-hidden="true" />
                    <span className="when when--live"
                          style={{ fontSize: 15, minWidth: 62, textAlign: "right" }}>
                      {clock(next.time)}
                    </span>
                  </span>
                ) : null /* Nothing is reporting for this stop. The banner above
                             says so once; repeating "no service" down twelve
                             rows states it as fact about the route, which is
                             the claim we cannot make. */}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
