import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./theme.css";
import { TransitMap, CAMPUS, type Overlay } from "./TransitMap";
import { Sheet, type Detent } from "./Sheet";
import { SearchBar } from "./SearchBar";
import { ItineraryList, ItineraryDetail, type WalkDirections } from "./Itineraries";
import { NearbyBoard } from "./NearbyBoard";
import { RouteDetail } from "./RouteDetail";
import { WhenControl, type WhenMode } from "./WhenControl";
import { resolveMode } from "./mode";
import { StopCard } from "./StopCard";
import { AlertBanner } from "./AlertBanner";
import { fetchAlerts, type Alert } from "../data/alerts";
import { fetchStaticFeed } from "../data/gtfs";
import { fetchLiveDepartures } from "../data/realtime";
import { fetchVehicles, type Bus } from "../data/vehicles";
import { fetchOccupancy, mergeOccupancy } from "../data/occupancy";
import { buildBoard, groupLiveTrips } from "../data/departures";
import { nearbyDepartures } from "../routing/nearby";
import { walkRoute, walkLegs, stablePosition, type WalkStep } from "../routing/walk";
import { planBetween } from "../routing/trip";
import { sameItinerary } from "../routing/plan";
import { sliceShape } from "../routing/shape";
import type { Place } from "../data/geocode";
import type { StaticFeed, DepartureBoard, Departure, LatLng, Itinerary } from "../data/types";

/** Routes Passio lists as not archived. GTFS ships every route Brown ever
 *  configured, including two with no trips at all. */
/** Fallback only. The live answer comes from Passio's own exclusion list via
 *  feed.activeRouteIds; this is what to draw when that could not be fetched,
 *  since blanking the map is the worse failure. */
const ACTIVE = new Set(["3302", "3469", "3470", "22427", "62487"]);
const VEHICLE_POLL_MS = 10_000;
const BOARD_POLL_MS = 30_000;

export default function App() {
  const [feed, setFeed] = useState<StaticFeed | null>(null);
  const [board, setBoard] = useState<DepartureBoard>(new Map());
  const [liveTrips, setLiveTrips] = useState<Map<string, Departure[]>>(new Map());
  // The board and live trips are replaced by fresh Maps every poll. Reading
  // them from refs keeps them out of the planning effect's deps: with them in,
  // the trip was re-planned every 30 seconds with no user action, hitting
  // Valhalla each time -- and a throttled response (no CORS headers) landed in
  // the catch and told a rider staring at a valid list "No shuttle route".
  /** What the plan effect needs to read without being restarted by it. */
  const itinerariesRef = useRef<Itinerary[] | null>(null);
  const chosenRef = useRef<Itinerary | null>(null);
  /** Which plan is the current one. The `cancelled` flag alone cannot clear
   *  the spinner: a superseded run returns early and never reaches its own
   *  `finally`, so under a steady cadence of re-plans the sheet said
   *  "Finding shuttles..." forever. The newest run always clears it. */
  const planGen = useRef(0);
  const boardRef = useRef(board);
  const liveTripsRef = useRef(liveTrips);
  boardRef.current = board;
  liveTripsRef.current = liveTrips;
  const [buses, setBuses] = useState<Bus[]>([]);
  const [me, setMe] = useState<LatLng | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [detent, setDetent] = useState<Detent>("peek");
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [dest, setDest] = useState<{ at: LatLng; label: string } | null>(null);
  const [itineraries, setItineraries] = useState<Itinerary[] | null>(null);
  const [chosen, setChosen] = useState<Itinerary | null>(null);
  /** The itinerary drawn on the map: whichever the rider opened, or the best
   *  one while they are still looking at the list. */
  const [preview, setPreview] = useState<Itinerary | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  /** Turn-by-turn for the two walking legs of `overlay`, from the same
   *  Valhalla /route calls that drew them. */
  const [directions, setDirections] = useState<WalkDirections>({ toStop: [], fromStop: [] });
  const [planning, setPlanning] = useState(false);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [stopId, setStopId] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  /** null means "leave now"; a Date plans for later today. */
  const [leaveAt, setLeaveAt] = useState<Date | null>(null);
  /** Whether that time is a departure or a deadline. */
  const [whenMode, setWhenMode] = useState<WhenMode>("leave");

  itinerariesRef.current = itineraries;
  chosenRef.current = chosen;

  const mode = resolveMode({ stopId, routeId, chosen: chosen !== null, dest: dest !== null });
  // Kept stable by VALUE, not identity. Geolocation hands back a fresh object
  // every report, even when the rider has not moved a metre, and `origin` is a
  // dependency of the planning effect. A new object restarts the plan, and a
  // restarted plan cancels the previous one -- whose `finally` then skips
  // setPlanning(false), because it is guarded on not being cancelled. Under a
  // steady trickle of position updates the spinner never clears, so the sheet
  // reads "Finding shuttles..." forever with the answers sitting underneath
  // it. That is why shuttle routes looked like they were never calculated.
  //
  // Snapped to ten metres as well. The memo above stops a fresh OBJECT from
  // restarting the plan; it does nothing about the low digits of a fix moving
  // on their own, which change the walk-matrix cache key and so send a real
  // request to a volunteer router. Snapping is what makes re-planning on every
  // board poll free.
  const snapped = me ? stablePosition(me) : CAMPUS;
  const origin = useMemo(
    () => snapped,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapped.lat, snapped.lng]);

  useEffect(() => {
    fetchStaticFeed()
      .then((f) => { setFeed(f); setNotice(null); })
      .catch(() => setNotice("Couldn't load the shuttle timetable. Check your connection."));
  }, [refreshKey]);

  useEffect(() => {
    if (!feed) return;
    let cancelled = false;
    const load = async () => {
      const live = await fetchLiveDepartures().catch(() => []);
      if (cancelled) return;
      // LIVE ONLY. The timetable is not a weaker claim here, it is a false
      // one: calendar.txt marks every route running daily through 2027, so a
      // scheduled departure asserts a bus that on most days does not exist.
      // Measured on a Sunday night in August: zero vehicles reporting, and the
      // app was still offering "10:06 PM" for four routes. Passio's `outdated`
      // flag cannot rescue it either -- it lies about seasonal suspension.
      //
      // No source can support a claim about a future minute. A vehicle
      // reporting its own position is the only thing that can, so it is the
      // only thing shown. The timetable keeps the one job it is honest at:
      // which stops a route serves, in what order. That comes from feed.trips
      // and never touches this board.
      setBoard(buildBoard(live, []));
      setLiveTrips(groupLiveTrips(live));
    };
    load();
    const h = setInterval(load, BOARD_POLL_MS);
    return () => { cancelled = true; clearInterval(h); };
  }, [feed, leaveAt, refreshKey]);

  useEffect(() => {
    // Keep the last known buses when a poll fails. Clearing them told riders
    // "no shuttles reporting" and "times below come from the timetable only"
    // because one request dropped -- overstating what the data says, in the
    // opposite direction from the mistake this project is built to avoid.
    // GTFS-RT carries only a coarse occupancy enum; Passio's own feed has the
    // real counts (1/11, 3/20). Fetch both and merge -- if the private feed is
    // unreachable the enum still stands.
    const tick = async () => {
      try {
        const [live, counts] = await Promise.all([
          fetchVehicles(),
          fetchOccupancy().catch(() => new Map()),
        ]);
        setBuses(mergeOccupancy(live, counts));
      } catch { /* keep the last known buses */ }
    };
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

  // Background timers are throttled and, on iOS Safari, suspended outright.
  // Unlocking your phone at the stop otherwise shows a countdown from up to
  // half a minute ago, still pulsing as though it were live.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setNow(Math.floor(Date.now() / 1000));
      fetchVehicles().then(setBuses).catch(() => {});
      setRefreshKey((k) => k + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
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
  // In arrive-by mode the chosen time is a deadline, not a departure, so the
  // clock the screen reasons from stays the real one.
  const planNow = leaveAt && whenMode === "leave" ? Math.floor(leaveAt.getTime() / 1000) : now;

  const nearby = useMemo(
    () => (feed ? nearbyDepartures(feed, board, origin, planNow, 6) : []),
    [feed, board, origin, planNow]);

  // Plan whenever the destination changes -- and again on every board poll,
  // because an itinerary built from live departures is only true for as long
  // as those departures are. Left to the destination alone it froze at the
  // moment the rider picked one and kept offering a bus that had gone.
  //
  // Walking times come from Valhalla, one matrix call per end rather than one
  // per candidate stop, and the origin is snapped to ten metres, so the repeat
  // plan is a cache hit and sends nothing. That is the whole reason the board
  // can be a dependency: it was one before, hit Valhalla every thirty seconds,
  // and a throttled response told riders "No shuttle route".
  useEffect(() => {
    if (!feed || !dest) { setItineraries(null); return; }
    let cancelled = false;
    const gen = ++planGen.current;
    // The spinner is for having nothing to show, not for having something a
    // few seconds old. Blanking a good list every poll is worse than the
    // staleness it announces.
    if (itinerariesRef.current === null) setPlanning(true);
    (async () => {
      try {
        const departAfter = whenMode === "leave" ? leaveAt ?? new Date() : new Date();
        const deadline = whenMode === "arrive" ? leaveAt ?? undefined : undefined;
        const found = await planBetween(
          feed, boardRef.current, origin, dest.at, departAfter, liveTripsRef.current, deadline);
        if (cancelled) return;
        setItineraries(found);

        const picked = chosenRef.current;
        if (!picked) {
          // Draw the best option straight away. Apple Maps shows the first
          // result on the map without waiting to be asked, and an empty map
          // beside a list of times makes the rider do the work twice.
          setPreview(found[0] ?? null);
        } else {
          // The rider opened one. Every itinerary here is a new object, so the
          // selection has to be carried across by what the journey IS -- its
          // trips and stops -- or a refresh would throw their choice away and
          // slam the map back to the first result every thirty seconds.
          const again = found.find((i) => sameItinerary(i, picked));
          // If it is gone, leave it alone rather than dropping them out of the
          // trip: a bus they have already boarded stops being plannable the
          // moment it pulls away, and that is not a reason to close the view.
          if (again) { setChosen(again); setPreview(again); }
        }
      } catch {
        // Only the FIRST plan may report failure. A refresh that fails leaves
        // the rider with what they already had, which is still true; replacing
        // it with an error because one poll was throttled is the exact bug
        // that made the board a ref in the first place.
        if (!cancelled && itinerariesRef.current === null) {
          setItineraries([]);
          setNotice("Couldn't work out walking times just now. Try again in a moment.");
        }
      } finally {
        if (planGen.current === gen) setPlanning(false);
      }
    })();
    return () => { cancelled = true; };
  }, [feed, dest, origin, leaveAt, whenMode, board]);

  // Draw the chosen trip: real sidewalk geometry for the walks, and only the
  // ridden slice of each route shape.
  useEffect(() => {
    const shown = chosen ?? preview;
    if (!shown || !feed) { setOverlay(null); setDirections({ toStop: [], fromStop: [] }); return; }
    let cancelled = false;
    const rides = shown.rides.flatMap((r) => {
      const shape = feed.routes.get(r.routeId)?.shape ?? [];
      const from = feed.stops.get(r.boardStopId);
      const to = feed.stops.get(r.alightStopId);
      if (!from || !to || shape.length < 2) return [];
      return [{ routeId: r.routeId, path: sliceShape(shape, from, to),
                color: feed.routes.get(r.routeId)?.color ?? "#241C17",
                boardStopId: r.boardStopId, alightStopId: r.alightStopId }];
    });
    // Straight lines first so the trip appears instantly, then upgrade to real
    // sidewalk paths when Valhalla answers.
    // A walk-only trip is a single leg from where you are to where you're going.
    const walkOnly = shown.rides.length === 0;
    const boardStop = walkOnly ? null : feed.stops.get(shown.rides[0]?.boardStopId ?? "");
    const alightStop = walkOnly ? null : feed.stops.get(shown.rides[shown.rides.length - 1]?.alightStopId ?? "");
    // Each walking leg is resolved on its own. Sharing one verdict between
    // them meant a single failure left BOTH drawn as straight lines, and a
    // filter on "did any path come back non-empty" meant that when neither did
    // -- the rider already standing at the boarding stop, or a stop id that
    // does not resolve -- setOverlay was never called again at all and the
    // straight guess stayed on screen permanently. That was the bug behind
    // "sometimes it just stays a straight line".
    const legs: { from: LatLng; to: LatLng }[] = [];
    if (walkOnly && dest) legs.push({ from: origin, to: dest.at });
    else if (boardStop) legs.push({ from: origin, to: boardStop });
    if (!walkOnly && alightStop && dest) legs.push({ from: alightStop, to: dest.at });

    // No provisional line at all. Valhalla answers in about 130ms, so drawing
    // a straight line through the buildings first only produces a flash of
    // something false; the ride is drawn straight away and the walk appears
    // when it is real. A straight line is used ONLY when a leg genuinely
    // cannot be routed, and is marked as a guess when it is.
    setOverlay({ walks: [], rides });
    // Cleared with the straight lines, not when the answer arrives: otherwise
    // the previous trip's turns sit under the new trip's walk step for as long
    // as Valhalla takes, which is a confident way to be wrong.
    setDirections({ toStop: [], fromStop: [] });

    (async () => {
      // No retry here any more. walkRoute() now caches, de-duplicates and backs
      // off inside the request layer, so an immediate second attempt could only
      // hit the cooldown it just triggered -- retrying into a throttle is what
      // kept Valhalla refusing us in the first place. The legs also go one at a
      // time rather than through Promise.all: two parallel requests per pin
      // drop is precisely the burst a volunteer server rations.
      const settled: PromiseSettledResult<{ path: LatLng[]; steps: WalkStep[] }>[] = [];
      for (const l of legs) {
        try {
          settled.push({ status: "fulfilled", value: await walkRoute(l.from, l.to) });
        } catch (reason) {
          settled.push({ status: "rejected", reason });
        }
        if (cancelled) return;
      }
      if (cancelled) return;

      const walks = walkLegs(legs, settled.map((r) =>
        r.status === "fulfilled" ? r.value.path : null));
      setOverlay({ walks, rides });
      const steps = (i: number) => {
        const r = settled[i];
        return r?.status === "fulfilled" ? r.value.steps : [];
      };
      setDirections(walkOnly
        ? { toStop: steps(0), fromStop: [] }
        : { toStop: steps(0), fromStop: steps(1) });
    })();
    return () => { cancelled = true; };
  }, [chosen, preview, feed, origin, dest]);

  // Everything the chosen trip touches, so the map can frame it.
  const focus = useMemo<LatLng[] | null>(() => {
    if (!overlay) return null;
    const pts = [...overlay.walks.flatMap((w) => w.path),
                 ...overlay.rides.flatMap((r) => r.path)];
    return pts.length ? pts : null;
  }, [overlay]);


  /** `mode` is derived by precedence stop > route > chosen > dest, so setting a
   *  destination while a stop card or route page is open left the old view on
   *  screen with the itineraries reachable only via Back. Every entry point
   *  into a mode clears the ones above it. */
  const pickDestination = (at: LatLng, label: string) => {
    setStopId(null);
    setRouteId(null);
    setChosen(null);
    setPreview(null);
    setDest({ at, label });
    setDetent("half");
  };

  return (
    <main style={{ position: "fixed", inset: 0, overflow: "hidden" }}>
      <TransitMap
        feed={feed} buses={buses} me={me}
        destination={dest?.at ?? null} overlay={overlay} focus={focus}
        selection={stopId ? { kind: "stop", id: stopId }
          : routeId ? { kind: "route", id: routeId } : null}
        activeRouteIds={feed?.activeRouteIds ?? ACTIVE}
        onRouteClick={(r) => { setRouteId(r); setStopId(null); setDetent("half"); }}
        onStopClick={(id) => { setStopId(id); setRouteId(null); setDetent("half"); }}
        onMapClick={(p) => pickDestination(p, "Dropped pin")}
        onPlaceClick={(p) => pickDestination(p.at, p.name)}
        onDeselect={() => {
          // Back out one level, in the same precedence resolveMode uses, so a
          // tap on the map undoes exactly what the Back button would. Dropping
          // everything at once would throw away a destination the rider only
          // wanted to look away from.
          if (stopId) { setStopId(null); return; }
          if (routeId) { setRouteId(null); return; }
          if (chosen) { setChosen(null); setPreview(null); return; }
          if (dest) {
            setDest(null); setChosen(null); setPreview(null); setItineraries(null);
            setDetent("peek");
          }
        }}
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
            onClear={() => {
            setDest(null); setChosen(null); setStopId(null); setRouteId(null); setPreview(null);
            setDetent("peek");
          }}
          />
        }
      >
        <AlertBanner alerts={alerts} feed={feed} />

        {/* Was set in four places and rendered in none, so a failed feed load
            shimmered a skeleton forever with no explanation and no retry. */}
        {notice && (
          <div role="status" style={{
            background: "var(--warn-bg)", border: "1px solid var(--warn-line)",
            color: "var(--warn-ink)", borderRadius: 10, padding: "9px 11px",
            marginBottom: 12, fontSize: 13, display: "flex", gap: 10, alignItems: "center",
          }}>
            <span style={{ flex: 1 }}>{notice}</span>
            <button onClick={() => { setNotice(null); setRefreshKey((k) => k + 1); }}
              style={{ border: 0, background: "transparent", color: "inherit",
                       fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>
              Retry
            </button>
          </div>
        )}

        {/* Keyed on mode so switching views animates in rather than jump-cutting. */}
        <div key={mode} className="enter">

        {/* planNow drives the countdowns on every screen, but the control that
            sets it only lives on the nearby board -- so results and route pages
            silently showed frozen times against a clock that was not now. */}
        {leaveAt && mode !== "nearby" && (
          <button onClick={() => setLeaveAt(null)} style={{
            display: "flex", alignItems: "center", gap: 8, width: "100%",
            border: "1px solid var(--hairline)", background: "var(--paper)",
            borderRadius: 9, padding: "7px 10px", marginBottom: 12,
            fontSize: 13, cursor: "pointer", textAlign: "left", color: "var(--ink)",
          }}>
            <span style={{ flex: 1 }}>
              {whenMode === "arrive" ? "Arriving by " : "Times shown for "}
              {leaveAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
              {leaveAt.toDateString() !== new Date().toDateString() ? " tomorrow" : ""}
            </span>
            <span style={{ color: "var(--accent)", fontWeight: 600 }}>Now</span>
          </button>
        )}

        {mode === "nearby" && (
          <>
            <WhenControl at={leaveAt} mode={whenMode}
                         onChange={setLeaveAt} onModeChange={setWhenMode} />
            {/* The nearby board is hidden, not deleted -- the user found it
                useless but may want it back. NearbyBoard.tsx and its tests are
                untouched; restore it by putting this element back:
                <NearbyBoard feed={feed} nearby={nearby} buses={buses}
                             now={planNow} loading={!feed} me={!!me}
                             onRouteClick={setRouteId} onLocate={locate} /> */}
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
                       activeRouteIds={feed?.activeRouteIds ?? ACTIVE}
                       now={planNow} onBack={() => setRouteId(null)} />
        )}

        {mode === "results" && (
          <>
            <div className="eyebrow">To {dest!.label}</div>
            <h1 className="display" style={{ fontSize: 28, margin: "4px 0 12px" }}>
              {planning ? "Finding shuttles…"
                : itineraries?.length ? "Soonest arrival first" : "No shuttle route"}
            </h1>
            {/* The old copy here named service hours -- "weekdays 7am-7pm",
                "suspended for the summer". Nothing in reach can support that:
                calendar.txt is one row running every route daily through 2027,
                there is no calendar_dates.txt, and the `outdated` flag lies
                about suspension. It is the timetable claim this project
                refuses, written as prose, and it asserts a bus is NOT running,
                which is no safer than asserting one is. Say only what the
                board can show. */}
            {!planning && itineraries?.length === 0 && (
              <p style={{ color: "var(--muted)", fontSize: 14, margin: 0 }}>
                {board.size === 0
                  ? "No shuttle anywhere is reporting a position right now, so there is nothing to plan a ride with."
                  : "No reporting shuttle gets you there, and it is too far to walk."}
              </p>
            )}
            {itineraries && itineraries.length > 0 && (
              <ItineraryList itineraries={itineraries} feed={feed} now={planNow}
                             selected={preview}
                             onSelect={(i) => { setChosen(i); setPreview(i); setDetent("half"); }} />
            )}
            {/* Asking for a later time and being handed a walk reads as "no
                shuttle serves this", which is a claim about the future the
                board cannot make. It is built from buses reporting now, and a
                bus that will run at eight tomorrow is not reporting yet. Say
                that, rather than letting the silence speak for it. */}
            {!planning && leaveAt && itineraries?.length
              && itineraries.every((i) => i.rides.length === 0) && (
              <p style={{ color: "var(--muted)", fontSize: 13, margin: "12px 0 0" }}>
                Only buses reporting right now can be planned with, so no shuttle can be
                shown for {whenMode === "arrive" ? "a deadline" : "a departure"} that far
                ahead — walking is all this can be sure of.
              </p>
            )}
          </>
        )}

        {mode === "detail" && chosen && (
          <ItineraryDetail itinerary={chosen} feed={feed} now={planNow} directions={directions}
                           onBack={() => setChosen(null)} />
        )}
        </div>
      </Sheet>
    </main>
  );
}
