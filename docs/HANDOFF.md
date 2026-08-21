# busbus — session handoff

Read this first. It exists so work can resume after the conversation is
compacted, without re-deriving anything.

**Live:** https://nhausspiegel.github.io/busbus/ (GitHub Pages, deploys on push
to `main`) · debug view at `?debug=1`
**Repo:** github.com/nhausspiegel/busbus (public)

---

## 1. The single most important thing

**Two map problems are still broken, and the user says they got WORSE after my
last change. Do not claim they are fixed without the user confirming visually.**

I declared these fixed three separate times based on screenshots and local
measurements. Each time I was wrong. Twice my measurement method itself was
broken. The user has had to push back three times. Treat any instinct to say
"fixed" as a signal to go measure again, on production, and preferably to just
show the user and ask.

The two problems:

1. **Route lines look bad.** The user's reference is Apple Maps' transit view
   (NYC subway): coincident lines run parallel, smooth, constant width and
   constant spacing at every zoom.
2. **Buses do not appear to sit on their routes.**

---

## 2. How the user wants to be worked with

Standing instructions given across the session:

- **Do not stop to check in.** Work autonomously to the end of the objective.
  Only stop when genuinely done or genuinely blocked.
- **Deploy at every milestone** so they can watch progress. Push to `main`;
  CI deploys.
- **Use subagents freely.** They explicitly corrected me on this: the "no
  subagents" constraint was mine, never theirs. The only rule is never to block
  waiting on their approval. Parallel dispatch is welcomed.
- **Use the superpowers skills** (brainstorming, writing-plans,
  test-driven-development, dispatching-parallel-agents,
  requesting-code-review) and **context-mode** (`ctx_execute` etc. for anything
  that returns data; Bash only for mutations and short fixed output).
- **Make a plan when it helps.** They offered this explicitly.
- **Look at the real Passio GO app for ideas** about *what* to build, not how.
- Caveman + ponytail hooks are active: terse prose, minimum viable code.
  Code, commits and security notes are written normally.

### The project's own non-negotiables (CLAUDE.md)

- **Never present a timetable time as if it were live.** Brown's
  `calendar.txt` marks every route running daily through 2027 and Passio's
  `outdated` flag lies about seasonal suspensions. Live vs scheduled is drawn
  differently (solid vs hollow numerals) and that must not regress.
- **Valhalla and Nominatim are volunteer-run.** One request per user action,
  never per keystroke. A throttled response has no CORS headers, so it
  surfaces in the browser as a confusing CORS error rather than a rate limit.
- **Verify, don't assert.** Claims about an API come from a live response, not
  memory. `./.venv/bin/python busbus.py` is the health check.
- Tests never hit the network — frozen fixtures in `test/fixtures/`.

---

## 3. What exists

Objectives 1 and 2 (routefinding, transfers) are **done and correct**.
Objective 3 (Apple-Maps-quality UI) is **mostly built but the map rendering is
not right**.

```
busbus.py                  live-verification tool, NOT app code. Don't import.
scripts/plan-demo.ts       terminal routefinder; defaults to
                           129 Angell St <-> Trader Joe's, both directions
scripts/refresh-fixtures.sh re-freeze GTFS fixture + public/gtfs copy

src/data/
  passio.ts       endpoints, IS_NODE, httpGetBytes
  gtfs.ts         static feed parse (routes/stops/trips/shapes)
  realtime.ts     GTFS-RT TripUpdates -> Departure[]
  vehicles.ts     GTFS-RT VehiclePositions -> Bus[]
  occupancy.ts    exact paxLoad/totalCap from Passio's private JSON
  alerts.ts       GTFS-RT ServiceAlerts
  departures.ts   serviceDayStart / scheduledDepartures / buildBoard / groupLiveTrips
  geocode.ts      Nominatim search
  types.ts

src/routing/
  plan.ts         planTrips — THE ranker. Pure. earliest arrival, walking,
                  arriveBy mode, rankAndTrim
  transfers.ts    planWithTransfers — two-leg trips
  trip.ts         planBetween / findItineraries — fetch + plan
  walk.ts         Valhalla matrix + geometry, haversineMeters, nearestStops
  nearby.ts       nearbyDepartures (90-min horizon)
  stopBoard.ts    departures at one stop
  routeDetail.ts  a route's stops in riding order
  rideStops.ts    stops a ride passes through
  shape.ts        slice a route polyline between two stops
  parallel.ts     >>> lane assignment for coincident routes — SEE §4
  snap.ts         >>> snap a bus onto its route + lane — SEE §4

src/ui/
  App.tsx         all state; mode precedence via mode.ts
  TransitMap.tsx  >>> MapLibre; the file with the problems
  mapStyle.ts     hand-written vector basemap style (light + dark)
  Sheet.tsx       3-detent draggable bottom sheet
  SearchBar / Itineraries / NearbyBoard / RouteDetail / StopCard /
  AlertBanner / WhenControl / ErrorBoundary / format.ts / mode.ts
  DebugMap.tsx    raw-data view at ?debug=1
```

**170 tests**, `npm test`, all offline. jsdom component tests exist
(`test/Sheet.test.tsx`, `test/Itineraries.test.tsx`) — note the
`/** @vitest-environment jsdom */` docblock and that the sheet is a fixed side
panel above 820px, so those tests pin a 390px viewport.

---

## 4. The two broken things, in detail

### 4a / 4b. Route lines and buses -- RESOLVED BY DELETION

**Do not re-implement lane offsetting without reading this.**

Four attempts were made to fan coincident routes into parallel lanes:
per-segment lanes, rendering resampled points, one lane per whole route, and
finally a smoothed per-point lane baked into the geometry. Every one looked
worse than the last on screen. All four shared a false premise:

> **A route's published shape is NOT the street centreline.** Brown's Evening
> CW and CCW shapes are already ~7m apart -- measured -- each traced down its
> own side of the road. Offsetting outward from an already-offset shape puts
> the line on the pavement, and snapping buses to that line puts the buses
> there too.

The verification was independently wrong, which is why this survived three
"fixed" claims: it matched each bus to a route line **by colour**, and several
Brown routes share a colour, so buses were being measured against lines that
were not theirs and scoring under 1px.

**Current state:** `parallel.ts` and `snap.ts` are deleted. Routes render
`r.shape` unchanged; buses render at their reported `lat`/`lng`. Measured by
`route_id` on raw coordinates, every live bus is **0.6-18.2m from its own
route line** -- ordinary GPS error. Passio's vehicle positions and its shapes
agree; the drawing code was what moved them apart.

**If parallel lanes are ever wanted again**, the prerequisite is establishing
where the street centreline actually is (the basemap has it; the GTFS shape
does not), and any measurement must join bus to route on `route_id`, never on
colour.

---

## 5. Passio data quirks that cost real time

These are all verified against live responses. Do not re-derive.

- **Route join key is GTFS `route_id` == Passio `myid`.** The private `id`
  field is NOT unique — two Commencement routes share `221345`.
- **RT and static disagree about a trip's stops.** RT trip `899435` reports 10
  stops (seq 6–15); the static trip of the same id has 4 (seq 1–4), overlapping
  in exactly one. So a live ride is planned from the RT trip's own absolute
  times (`liveTrips` / `groupLiveTrips`), never from the static trip. Joining
  on `stop_sequence` silently discarded every live departure.
- **Post-midnight service is `24:xx`/`25:xx` on the PREVIOUS service day.**
  `scheduledDepartures` emits both the current and previous service day.
  Missing this made a 00:45 bus read as 1,425 minutes away at 00:15.
- **Shuttle routes are loops** — one trip visits a stop twice (trip 899418 hits
  stop 8380 at seq 1 and seq 15). `buildBoard` keys on `trip|stop|seq`.
- **`calendar.txt` is one blanket service**, all days, 2025-01-01 to
  2027-12-31. Useless for "is it running today".
- **`outdated` lies.** It reports the Evening routes active while Brown
  publishes "No Summer Service" for them.
- **Only some feeds are CORS-open.** The three GTFS-RT endpoints send
  `access-control-allow-origin: *`; **the static zip does not**. The build
  ships a copy at `public/gtfs/google_transit.zip` and the browser reads that.
- **Never set `User-Agent` in the browser** — forbidden header, turns the call
  into a preflight passio3.com does not answer. `IS_NODE` guards this.
- Route shapes resolve via `trips.shape_id`, not by assuming `shape_id ==
  route_id` (true today, coincidence).
- **Exact occupancy** comes from `POST https://passiogo.com/mapGetData.php?getBuses=2`
  body `{"s0":"1067","sA":1}` — `paxLoad`/`totalCap` (e.g. 1/11, 3/20).
  GTFS-RT only has a coarse enum.
- Brown's system id is `1067`, slug `brown`. No API keys anywhere, ever.
- Service hours (from Brown's site, summer): Daytime Express and Connector
  weekdays 7am–7pm; **Evening routes suspended for the summer**, back in
  semester; OnCall and Access are on other systems entirely and are not in
  Passio. Expect an empty app outside those hours — that is correct, not a bug.

---

## 6. Known outstanding work (not yet done)

1. **Fix 4a and 4b.** Highest priority.
2. `numStops` counts *hops*, not stops, so the itinerary disclosure says
   "3 stops" and lists 2 names. Decide which number the label means.
3. **Loop boarding bug:** `rideStops` recovers the boarding stop by
   `trip.stops.find(stopId)` — the *first* occurrence. A ride boarding on the
   second lap of a loop resolves to seq 1 and the expanded list shows a
   spurious extra lap. Fix needs `RideLeg` to carry `boardSeq` (touches
   `plan.ts`).
4. Turn-by-turn walking directions text (Valhalla returns maneuvers).
5. iOS home-screen icon needs a PNG `apple-touch-icon`; the manifest currently
   only has an SVG, which Android honours and Safari generally does not.

---

## 7. How to work on it

```bash
npm run dev                       # http://localhost:5173
npm test                          # 170 tests, offline
npx tsc -b --noEmit
npx tsx scripts/plan-demo.ts      # Angell <-> Trader Joe's, both ways
./.venv/bin/python busbus.py      # is Passio itself healthy?
```

Deploy: commit and `git push origin main`, then
`gh run watch $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status`.
CI runs the tests before deploying and is pinned to **Node 22** (jsdom's undici
needs it; Node 20 crashed the runner while passing locally).

**Verify on production, not just locally.** The user looks at the deployed
site. At least once I "fixed" something locally, pushed a commit claiming it
was fixed, and the deployed build did not contain it yet.
