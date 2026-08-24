/** Ranked itinerary list and the detail view for one trip. */
import { useState, type ReactNode } from "react";
import { clock, minsUntil, durationMins } from "./format";
import { rideStops } from "../routing/rideStops";
import type { WalkStep } from "../routing/walk";
import type { Itinerary, RideLeg, StaticFeed } from "../data/types";

/** Turn-by-turn for the two walking legs, as Valhalla worded them. Empty until
 *  the /route calls the map already makes come back, or if they fail. */
export interface WalkDirections { toStop: WalkStep[]; fromStop: WalkStep[] }

/** A filled badge in the route's own colour, the way transit apps label lines.
 *  An outlined chip with a dot made every route look the same at a glance. */
function RouteChip({ feed, routeId }: { feed: StaticFeed | null; routeId: string }) {
  const r = feed?.routes.get(routeId);
  const color = r?.color ?? "#6F625A";
  const label = r?.shortName || r?.name || routeId;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", fontSize: 13, fontWeight: 600,
      background: color, color: "#fff", borderRadius: 7, padding: "3px 9px",
      whiteSpace: "nowrap", maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis",
      textShadow: "0 1px 1px rgb(0 0 0 / 25%)",
    }}>{label}</span>
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
  itineraries, feed, now, selected, onSelect,
}: {
  itineraries: Itinerary[]; feed: StaticFeed | null; now: number;
  /** The one currently drawn on the map. */
  selected?: Itinerary | null;
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
              aria-current={selected === it ? "true" : undefined}
              style={{ display: "block", width: "100%", textAlign: "left", border: 0,
                       background: selected === it ? "var(--paper)" : "transparent",
                       padding: "13px 10px", margin: "0 -10px", borderRadius: 10,
                       cursor: "pointer" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  {it.rides.length === 0
                    ? <WalkChip minutes={durationMins(it.totalWalkSeconds)} />
                    : it.rides.map((r, i) => <RouteChip key={i} feed={feed} routeId={r.routeId} />)}
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div className="eyebrow" style={{ fontSize: 10 }}>arrive</div>
                  <div className="when when--live"
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
  itinerary, feed, now, directions, onBack,
}: {
  itinerary: Itinerary; feed: StaticFeed | null; now: number;
  directions?: WalkDirections; onBack: () => void;
}) {
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
        {/* The walk-only trip is the same first leg as far as Valhalla is
            concerned -- one /route from where you are -- so it reads the same
            `toStop` directions. */}
        {itinerary.rides.length === 0 ? (
          <Step
            dot="walk"
            title={`Walk ${durationMins(itinerary.totalWalkSeconds)} min`}
            detail="straight to your destination"
            note={<>
              Faster than waiting for a shuttle
              <WalkDirectionsNote steps={directions?.toStop ?? []} />
            </>}
          />
        ) : (
        <Step
          dot="walk"
          title={`Walk ${durationMins(itinerary.walkToStop.seconds)} min`}
          detail={`to ${nameOf(itinerary.rides[0]?.boardStopId ?? "")}`}
          note={<WalkDirectionsNote steps={directions?.toStop ?? []} />}
        />
        )}
        {itinerary.rides.map((r, i) => (
          <Step
            key={i}
            dot="ride"
            color={feed?.routes.get(r.routeId)?.color}
            title={feed?.routes.get(r.routeId)?.name ?? r.routeId}
            detail={`${clock(r.departTime)} ${nameOf(r.boardStopId)} → ${clock(r.arriveTime)} ${nameOf(r.alightStopId)}`}
            note={<RideStopsNote feed={feed} ride={r} />}
          />
        ))}
        {itinerary.rides.length > 0 && (
          <Step
            dot="walk"
            title={`Walk ${durationMins(itinerary.walkFromStop.seconds)} min`}
            detail="to your destination"
            note={<WalkDirectionsNote steps={directions?.fromStop ?? []} />}
          />
        )}
      </ol>

    </div>
  );
}

/** The stops a ride passes through, named only when asked for.
 *
 *  A Brown shuttle announces nothing, so "7 stops" does not tell a rider which
 *  one is theirs. The list is long and this view is read standing at a stop on
 *  a phone, so it stays collapsed until tapped -- the default height is
 *  unchanged from the plain "7 stops · live" line it replaces.
 *
 *  The boarding and alighting stops are dropped: the step's own detail line
 *  right above already names both, with their times. */
function RideStopsNote({ feed, ride }: { feed: StaticFeed | null; ride: RideLeg }) {
  const [open, setOpen] = useState(false);
  const between = feed ? rideStops(feed, ride).filter((s) => !s.boarding && !s.alighting) : [];
  const count = `${ride.numStops} stop${ride.numStops === 1 ? "" : "s"}`;
  // Every ride reaching this view is built from a reporting vehicle; there is
  // no other kind of departure on the board any more.
  const liveness = " · live";

  // No feed yet, an unknown trip, or a ride straight to the next stop: nothing
  // to disclose, so do not offer a control that opens onto an empty list.
  if (between.length === 0) return <>{count}{liveness}</>;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          border: 0, background: "transparent", font: "inherit", fontWeight: 600,
          color: "var(--accent)", cursor: "pointer", display: "inline-flex",
          alignItems: "center", gap: 4,
          // Padding for a thumb, cancelled by margin so the row keeps its height.
          padding: "5px 6px", margin: "-5px -6px",
        }}
      >
        {count}
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" style={{
          transform: open ? "rotate(90deg)" : "none", transition: "transform .15s ease",
        }}>
          <path d="M2.5 1 5.5 4 2.5 7" fill="none" stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {liveness}
      {open && (
        <>
          {/* "3 stops" is the length of the ride, which is what Apple Maps
              means by it too. The list is what you pass ON the way, one fewer.
              Both are right; unlabelled, a reader counts the rows against the
              number and decides one of them is broken. */}
          <p style={{ margin: "6px 0 0", paddingTop: 6, fontSize: 11,
                      borderTop: "1px solid var(--hairline)" }}>
            Stops on the way
          </p>
          <ol style={{ listStyle: "none", margin: "4px 0 0", padding: 0 }}>
            {between.map((s, i) => (
              <li key={i} style={{ display: "flex", gap: 10, padding: "2px 0" }}>
                <span style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {clock(s.time)}
                </span>
                <span style={{ color: "var(--ink)" }}>{s.stop.name}</span>
              </li>
            ))}
          </ol>
          {/* Even on a live ride only the boarding time is reported by a bus;
              everything in between is that time plus a timetable offset. */}
          <p style={{ margin: "5px 0 0", fontSize: 11 }}>
            Times between stops come from the timetable.
          </p>
        </>
      )}
    </>
  );
}

/** Valhalla measures to the millimetre; a sidewalk does not.
 *  "Turn left onto Thayer Street · 119.8 m" reads like a survey, not a walk. */
function farAs(metres: number): string {
  if (metres >= 1000) return `${(metres / 1000).toFixed(1)} km`;
  // Tens only once the number is big enough for the last digit to be noise:
  // rounding a 5 m crosswalk to the nearest ten would erase it entirely.
  return `${metres >= 100 ? Math.round(metres / 10) * 10 : Math.round(metres)} m`;
}

/** The turns of one walking leg, named only when asked for.
 *
 *  Same disclosure as RideStopsNote and for the same reason: a Valhalla walk
 *  across campus is 19 maneuvers, and this view is read standing at a stop on
 *  a phone. Collapsed, the step's height is unchanged. */
function WalkDirectionsNote({ steps }: { steps: WalkStep[] }) {
  const [open, setOpen] = useState(false);

  // The map's /route call has not answered yet, or it failed. Nothing to
  // disclose, so do not offer a control that opens onto an empty list.
  if (steps.length === 0) return null;

  return (
    <div style={{ marginTop: 2 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          border: 0, background: "transparent", font: "inherit", fontWeight: 600,
          color: "var(--accent)", cursor: "pointer", display: "inline-flex",
          alignItems: "center", gap: 4,
          // Padding for a thumb, cancelled by margin so the row keeps its height.
          padding: "5px 6px", margin: "-5px -6px",
        }}
      >
        Directions
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" style={{
          transform: open ? "rotate(90deg)" : "none", transition: "transform .15s ease",
        }}>
          <path d="M2.5 1 5.5 4 2.5 7" fill="none" stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ol style={{ listStyle: "none", margin: "6px 0 0", padding: "6px 0 0",
                     borderTop: "1px solid var(--hairline)" }}>
          {steps.map((s, i) => (
            <li key={i} style={{ display: "flex", gap: 8, padding: "2px 0" }}>
              <span style={{ color: "var(--ink)" }}>{s.instruction}</span>
              {/* The arriving maneuver is zero-length: "· 0 m" is noise. */}
              {s.metres > 0 && (
                <span style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                  · {farAs(s.metres)}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Step({
  dot, color, title, detail, note,
}: { dot: "walk" | "ride"; color?: string; title: string; detail: string; note?: ReactNode }) {
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
