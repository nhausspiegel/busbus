/** Ranked itinerary list and the detail view for one trip. */
import { clock, minsUntil, durationMins } from "./format";
import type { Itinerary, StaticFeed } from "../data/types";

function RouteChip({ feed, routeId }: { feed: StaticFeed | null; routeId: string }) {
  const r = feed?.routes.get(routeId);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13,
      background: "var(--paper)", border: "1px solid var(--hairline)",
      borderRadius: 999, padding: "3px 9px 3px 6px", whiteSpace: "nowrap",
    }}>
      <span aria-hidden="true" style={{
        width: 9, height: 9, borderRadius: 2, background: r?.color ?? "var(--muted)" }} />
      {r?.shortName || r?.name || routeId}
    </span>
  );
}

function WalkChip({ minutes }: { minutes: number }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13,
      background: "var(--paper)", border: "1px solid var(--hairline)",
      borderRadius: 999, padding: "3px 10px 3px 7px", whiteSpace: "nowrap",
    }}>
      <svg width="11" height="13" viewBox="0 0 11 13" fill="none" aria-hidden="true"
           stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round">
        <circle cx="6.4" cy="2" r="1.6" fill="var(--ink)" stroke="none" />
        <path d="M6.6 4.6 4.8 7.2l2 1.9.7 3.1M4.8 7.2 2.6 9.1M6.8 6.1l2.3.9" />
      </svg>
      Walk {minutes} min
    </span>
  );
}

export function ItineraryList({
  itineraries, feed, now, onSelect,
}: {
  itineraries: Itinerary[]; feed: StaticFeed | null; now: number;
  onSelect: (i: Itinerary) => void;
}) {
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {itineraries.map((it, n) => {
        const leaveIn = minsUntil(it.departTime, now);
        return (
          <li key={n} style={{ borderTop: "1px solid var(--hairline)" }}>
            <button
              onClick={() => onSelect(it)}
              style={{ display: "block", width: "100%", textAlign: "left", border: 0,
                       background: "transparent", padding: "13px 0", cursor: "pointer" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  {it.rides.length === 0
                    ? <WalkChip minutes={durationMins(it.totalWalkSeconds)} />
                    : it.rides.map((r, i) => <RouteChip key={i} feed={feed} routeId={r.routeId} />)}
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div className="eyebrow" style={{ fontSize: 10 }}>arrive</div>
                  <div className={`when ${it.allLive ? "when--live" : "when--sched"}`}
                       style={{ fontSize: 27 }}>
                    {clock(it.arriveTime)}
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 7, fontSize: 13, color: "var(--muted)" }}>
                {it.rides.length === 0
                  ? "Leave now · no waiting"
                  : <>
                      {leaveIn === 0 ? "Leave now" : `Leave in ${leaveIn} min`}
                      {" · "}{durationMins(it.totalWalkSeconds)} min walking
                      {" · "}{it.transfers === 0 ? "direct" : `${it.transfers} transfer`}
                      {!it.allLive && " · scheduled"}
                    </>}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ItineraryDetail({
  itinerary, feed, now, onBack,
}: { itinerary: Itinerary; feed: StaticFeed | null; now: number; onBack: () => void }) {
  const nameOf = (id: string) => feed?.stops.get(id)?.name ?? id;
  const leaveIn = minsUntil(itinerary.departTime, now);

  return (
    <div>
      <button onClick={onBack} style={{
        border: 0, background: "transparent", color: "var(--accent)", fontWeight: 600,
        fontSize: 14, cursor: "pointer", padding: "0 0 10px",
      }}>← All options</button>

      <div className="eyebrow">
        {leaveIn === 0 ? "Leave now" : `Leave in ${leaveIn} min`}
      </div>
      <h2 className="display" style={{ fontSize: 30, margin: "3px 0 14px" }}>
        Arrive {clock(itinerary.arriveTime)}
      </h2>

      <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {itinerary.rides.length === 0 ? (
          <Step
            dot="walk"
            title={`Walk ${durationMins(itinerary.totalWalkSeconds)} min`}
            detail="straight to your destination"
            note="Faster than waiting for a shuttle"
          />
        ) : (
        <Step
          dot="walk"
          title={`Walk ${durationMins(itinerary.walkToStop.seconds)} min`}
          detail={`to ${nameOf(itinerary.rides[0]?.boardStopId ?? "")}`}
        />
        )}
        {itinerary.rides.map((r, i) => (
          <Step
            key={i}
            dot="ride"
            color={feed?.routes.get(r.routeId)?.color}
            title={feed?.routes.get(r.routeId)?.name ?? r.routeId}
            detail={`${clock(r.departTime)} ${nameOf(r.boardStopId)} → ${clock(r.arriveTime)} ${nameOf(r.alightStopId)}`}
            note={`${r.numStops} stop${r.numStops === 1 ? "" : "s"}${r.live ? " · live" : " · scheduled"}`}
          />
        ))}
        {itinerary.rides.length > 0 && (
          <Step
            dot="walk"
            title={`Walk ${durationMins(itinerary.walkFromStop.seconds)} min`}
            detail="to your destination"
          />
        )}
      </ol>

      {!itinerary.allLive && (
        <p style={{ marginTop: 14, fontSize: 12, lineHeight: 1.5, color: "var(--muted)",
                    borderTop: "1px solid var(--hairline)", paddingTop: 12 }}>
          These times come from the timetable, not from a bus reporting its position.
          Brown's feed lists every route as running daily year-round, so treat a
          scheduled time as a plan rather than a promise.
        </p>
      )}
    </div>
  );
}

function Step({
  dot, color, title, detail, note,
}: { dot: "walk" | "ride"; color?: string; title: string; detail: string; note?: string }) {
  return (
    <li style={{ display: "flex", gap: 12, padding: "10px 0", borderTop: "1px solid var(--hairline)" }}>
      <span aria-hidden="true" style={{
        width: 10, marginTop: 5, flexShrink: 0, alignSelf: "stretch",
        borderLeft: dot === "walk" ? "3px dotted var(--muted)" : `4px solid ${color ?? "var(--ink)"}`,
        borderRadius: 2,
      }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 13, color: "var(--muted)" }}>{detail}</div>
        {note && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{note}</div>}
      </div>
    </li>
  );
}
