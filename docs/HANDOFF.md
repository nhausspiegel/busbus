# busbus — session handoff

Read this first. It exists so work can resume after the conversation is
compacted, without re-deriving anything.

**Live:** https://nhausspiegel.github.io/busbus/ (GitHub Pages, deploys on push
to `main`) · debug view at `?debug=1`
**Repo:** github.com/nhausspiegel/busbus (public)

---

## 1. The single most important thing

**Read `docs/RENDERING.md` before touching how route lines are drawn.** The
rendering was rebuilt on 2026-08-30 and the owner called it correct for the
first time; `git tag renderer-checkpoint` marks it. The design is small and the
reasons are load-bearing, and the previous design survived ~100 commits mostly
because each session found it already written and assumed it had to stay.

**Do not claim a rendering fix without the owner confirming visually.** I
declared these fixed several times from screenshots and local measurements, and
was wrong every time; twice the measurement method was itself broken. The owner
is the only one who can see the window. Their observation is the ground truth
and the starting point, never a claim to triage.

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
scripts/snap-to-streets.ts  re-snap routes to OSM roads (one Overpass call)

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

src/render/
  lanes.ts        >>> lane assignment + pixel offsets — SEE docs/RENDERING.md
  symbols.ts      paint expressions (route width/colour, line-offset)
  network.ts      basemap road network drawing

src/data/snappedShapes.ts   snapped node table -> route shapes
scripts/snap-to-streets.ts  build step: routes -> real OSM road nodes

src/ui/
  App.tsx         all state; mode precedence via mode.ts
  TransitMap.tsx  MapLibre; LANE_GAP_PX lives here
  mapStyle.ts     hand-written vector basemap style (light + dark)
  Sheet.tsx       3-detent draggable bottom sheet
  SearchBar / Itineraries / NearbyBoard / RouteDetail / StopCard /
  AlertBanner / WhenControl / ErrorBoundary / format.ts / mode.ts
  DebugMap.tsx    raw-data view at ?debug=1
```

**344 tests**, `npm test`, all offline. jsdom component tests exist
(`test/Sheet.test.tsx`, `test/Itineraries.test.tsx`) — note the
`/** @vitest-environment jsdom */` docblock and that the sheet is a fixed side
panel above 820px, so those tests pin a 390px viewport.

---

## 4. Lane offsetting — see `docs/RENDERING.md`

The full design lives in `docs/RENDERING.md`. The three facts worth carrying
here, because each cost real time:

> **A route's published shape is NOT the street centreline.** Brown's Evening
> CW and CCW shapes are ~7m apart -- measured -- each traced down its own side
> of the road. Offsetting outward from an already-offset shape puts the line on
> the pavement, and snapping buses to it puts the buses there too. This is why
> routes are snapped to real OSM road nodes at build time
> (`scripts/snap-to-streets.ts`) rather than offset from the raw trace.

> **The gap is held in device pixels, by MapLibre's `line-offset`.** Never bake
> it into geometry: that is what made the gap grow from 3.7px at zoom 13 to
> 13.5px at zoom 18 for a year.

> **Verification was once wrong in a way that hid the defect** -- it matched
> each bus to a route line **by colour**, and several Brown routes share one.
> Join bus to route on `route_id`, never on colour.

`test/snappedShapes.test.ts` pins the geometry and the lane offsets. Do not
change `src/render/lanes.ts` or the map's pixel constants without running it,
and read the traps at the end of `docs/RENDERING.md` first -- two of them have
been walked into twice.

## 4b. Reflexes that wasted real time

Distinct from the technical dead ends in `docs/BACKLOG.md`: those are ideas that
were measured and lost. These are *habits* — the wrong instinct reached for
before thinking, each one caught by the owner rather than by me.

- **Reaching for a remote API for data the project already has.** Snapping
  routes to street centrelines was first built as ~60 rate-limited OSRM map
  requests taking many minutes, when this app already ships a street basemap
  and the whole campus road network is ONE Overpass query. Before calling a
  service, ask what is already downloaded, vendored, or committed. Volunteer
  infrastructure is not a convenience layer over data you can hold.
- **Inventing a metric instead of measuring the thing complained about.** Three
  separate proxies for the map "squiggle" each moved the wrong way or counted a
  successful fix as the defect. Measure in the units the defect is seen in.
- **Reading a screenshot and reporting what it shows.** I have twice stated the
  opposite of what was on screen — including which side of a road a line sat
  on. Screenshots are for spotting that something is wrong, never for deciding
  what is right. Measure it, or ask.
- **Explaining a report away.** "It may just not be visible at that zoom" is not
  an answer to "it doesn't work". The owner is the only one who can see the
  window; their observation is the ground truth and the starting point, not a
  claim to be triaged.

### Postmortem, 2026-08-31: three hours, nothing shipped

Net output of an afternoon: the service recorder ran once. Everything else was
written, measured, committed and reverted. Worth writing down in full, because
the same shape has now repeated three times in one day.

**What was attempted, in order.** A z-order fix (the selected route was being
painted over by the dimmed ones), thinner strokes and a casing that survives
selection, the hospital-loop snapper fix, and three separate attempts at
continuous route lines. Two of those -- z-order and the hospital loop -- were
correct, independent of route drawing, and were reverted anyway.

**What actually went wrong.**

1. **I shipped rendering I cannot evaluate.** Three times my numbers said the
   change was good and the owner said the map looked awful. The numbers were
   not wrong; they measured defects I had already hypothesised (boundary count,
   fold count, gap in pixels) and were structurally incapable of detecting
   "looks crooked". **An absence of the defects I thought of is not evidence
   that it looks right.** Only the owner can supply that evidence.

2. **I committed a rendering rewrite while the owner was away**, onto a branch
   whose dev server they were watching. HMR means every edit is instantly on
   their screen, so there was no gate between "I am trying something" and "this
   is what the app looks like now". They came back to a broken map three hours
   old with no way to have intercepted it.

3. **I entangled good fixes with bad ones.** The z-order fix and the hospital
   loop had nothing to do with lane geometry, but they sat in the same working
   tree and the same commit sequence, so "revert the rendering" took them out
   twice. Both are still unfixed as a result.

4. **I argued past a documented trap instead of testing it.** `RENDERING.md`
   said not to offset in geometry. I decided the reason did not apply to me and
   did it -- twice -- before finding, in data I had already collected and
   explained away, that a naive offset folds 20 times over at the opening zoom.
   The doc was not right for the reason it gave, but it was right.

5. **I explained away my own measurement.** 51 self-intersections against a
   baseline of zero, dismissed with an invented loop-perimeter metric. That is
   the third time this exact move appears in these docs.

**What to do instead.**

- **Route rendering does not go near the owner's dev server unreviewed.** Use a
  branch or a worktree. What is running on :5173 should be a state they have
  agreed to look at, not the middle of an experiment.
- **Never commit a rendering change while the owner is away.** There is no one
  to say "that is worse" and the feedback loop is hours long.
- **One fix, one commit, verified alone.** Anything that is not about lane
  geometry must be separable from lane geometry, or it dies with it.
- **Stop proposing the next rendering idea until the previous one is
  understood.** Three attempts were made today without ever establishing why
  the first looked wrong. The diagnosis came only after the third.

**The one durable technical finding.** At the zoom the app opens at, the road's
own vertices are ~1.3px apart while the lane offset is 5px. Any scheme that
displaces vertices individually folds over itself under that ratio -- measured
20 self-crossings across the five routes, against 0 in the source geometry.
Proper offsetting needs both joins (outer corners reach out to the miter, inner
corners are pulled back to the crossing) AND excision of the loops that a
vertex-at-a-time join cannot see. That was implemented, measured clean -- folds
20 to 1, gap exactly 5.00px at z13/14.2/16/18 -- and STILL looked wrong on the
map. So the geometry direction is now twice-rejected on sight, and the reason
is not any of the things that have been measured so far.

---

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

See `docs/BACKLOG.md` for the full list with its evidence. The short version:

1. **Every run boundary is visible** -- 47 of them, 25 overspilling a corner
   and 21 wider than the stroke. This is the ceiling on how good the map can
   look, and no cap style touches it. `docs/BACKLOG.md` item 1, and
   `docs/RENDERING.md` for why. Five attempted fixes were reverted on
   2026-08-30; read the table at the end of `docs/RENDERING.md` before trying
   a sixth.
2. Geographic vs octilinear rendering is a fork only the owner can settle.
3. The Express's stop-to-stop times need real observations before the planner
   can route through the seven stops its GTFS trip omits.
4. `scripts/snap-to-streets.ts` hardcodes the five active route ids in `ACTIVE`.
   A route Passio adds keeps its raw trace and draws without lanes -- degraded,
   not broken -- until the script is re-run.

Resolved since this was last written: the loop boarding bug (`RideLeg` carries
`boardSeq` and `rideStops` joins on it), turn-by-turn walking directions, the
iOS `apple-touch-icon.png`, the `numStops` label, and the whole route-rendering
rebuild described in `docs/RENDERING.md`.

## 7. How to work on it

```bash
npm run dev                       # http://localhost:5173
npm test                          # 344 tests, offline
npx tsc -b --noEmit
npx tsx scripts/plan-demo.ts      # Angell <-> Trader Joe's, both ways
./.venv/bin/python busbus.py      # is Passio itself healthy?
npx tsx scripts/record-service.ts # what is running right now, and record it
```

Deploy: commit and `git push origin main`, then
`gh run watch $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status`.
CI runs the tests before deploying and is pinned to **Node 22** (jsdom's undici
needs it; Node 20 crashed the runner while passing locally).

**Verify on production, not just locally.** The user looks at the deployed
site. At least once I "fixed" something locally, pushed a commit claiming it
was fixed, and the deployed build did not contain it yet.
