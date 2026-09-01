# Backlog

Root causes, not symptoms. Written so it can be picked up cold after a
compaction: everything needed to act is here or named by file.

**Read `docs/HANDOFF.md` too** — it records how the user wants to be worked
with, and the approaches already ruled out, which is what stops the next
session repeating them.

Last trued against the code on **2026-08-31**.

For how route lines are drawn, read `docs/RENDERING.md` first.

---

## Still to do

### 1. Every run boundary is visible — the ceiling on the map's looks

A route is cut into one feature per stretch of constant lane offset, and
MapLibre can only build a join **within** a feature. So every cut is a join it
cannot make. Measured 2026-08-30 on `renderer-checkpoint`:

```
52 features for 5 routes
47 boundaries, ALL of them visible
   25 on a corner   -- the outgoing feature overspills the turn, so the route
                       appears to bend at two points instead of one
   21 wider than the 4.5px stroke -- a clean gap in the line
median step 3.4px, max 7.0px
```

Round caps make each one a nub, butt caps make it a notch. **The cap is not the
defect and no cap fixes it.** Read `docs/RENDERING.md`, "The fragile part".

Two ways out, and only the second can reach zero:

1. Fewer boundaries. Absorbing junction stubs got 47 → 45. Not close.
2. One feature per route: offset applied to the geometry, rebuilt whenever the
   scale changes, lane changes tapered over a fixed number of pixels. Zero
   boundaries by construction, every corner a real join, and a lane change
   becomes a ramp instead of a jump.

(2) was started and abandoned half-wired — the stop and bus snapping had not
been moved onto the new geometry and two `TransitMap` tests were failing, so
what was on screen was not what the design would produce. **It is not a
measured dead end.** Finish it before judging it.

### 1b. Four side-jumps

The road runs straight (turn < 60°) but the line hops across it (world-space
displacement swings > 90°). Four, measured on the checkpoint. Fixes for these
were built and reverted — see the table at the end of `docs/RENDERING.md` —
because each traded a side-jump for more run boundaries, and boundaries are
the number that tracks what the map looks like.

**Measure this in world space, never with the sign of `offsetPx`.** That sign
must flip wherever the canonical frame opposes travel, precisely so the line
stays on the same side of the road; counting those flips calls the correction a
defect, which has now been done twice.

### 2. Geographic vs octilinear — a fork only the owner can settle

The squiggle was hard because of a design choice, not because the problem is
hard. This app draws true street geometry **and** offsets lines into lanes per
vertex; the London Underground map is octilinear and schematic, so straightness
is structural and there is nothing to filter. A schematic cannot sit truthfully
on a street basemap — the Underground has none — and pulls against the Apple
Maps behaviour also asked for. Different renderer, worth doing deliberately.

### 3. The Express's stop-to-stop times need observations

`src/data/legTimes.ts` learns leg durations from realtime and the planner uses
them (`legSecondsFor` in `src/routing/plan.ts`), but nothing is claimed under
five samples per leg and **no shuttle has reported yet** — measured 2026-08-29,
one charter bus and zero trip predictions. Nothing to do but wait for service;
check `public/service-history.json` for a populated `legs` map.

Known asymmetry while that lands: `transfers.ts` builds the FIRST leg from
`trip1.stops` directly, so a route whose GTFS trip omits its stops can be the
second leg of a transfer but never the first. Left alone deliberately —
transfers are secondary, the direct path covers the Express, and fixing it means
duplicating the observed-leg walk into another code path.

### 4. The active-route list is still hardcoded, in two places

`parseActiveRoutes()` (`src/data/routePaths.ts:143-157`) derives the running
routes from `routes` minus `excludedRoutesID`, and was written specifically to
abolish the hardcoded list. The list is still written down twice:
`scripts/snap-to-streets.ts:37` and `src/ui/App.tsx:32`.

When Brown turns the Commencement routes on, they draw from the raw Passio
trace with no snapped geometry -- reintroducing the metres-based separation the
lane subsystem exists to remove, in frame, beside routes that do not have it.

### 5. Route rendering polish

Corner radius is no longer a knob at all: `CORNER_RADIUS_PX` and the densifier
that clamped it dead are both deleted, and corners are `line-join: round`,
which MapLibre draws correctly *within* a feature. What remains is boundaries
**between** features -- see `docs/RENDERING.md`, "The fragile part". Fewer,
longer features is the only lever, and see item 1: it is the open defect.

### 6. NearbyBoard is hidden, not deleted

The owner found it useless but may want it back. `NearbyBoard.tsx` and its tests
are untouched; `src/ui/App.tsx` carries the element to restore in a comment.

### 7. `test/network.test.ts` asserts nothing

It reads `b.properties["routeId"]`, and `stationFeatures` never sets one -- a
bead carries name, id, routes, interchange, color (`src/render/network.ts:58-75`).
So `drawn.get("")` is undefined, the loop `continue`s on every iteration, and
what it asserts at three zooms is `0 < 6`.

Fix: add `routeId` to the bead properties. The test then starts failing, and
making it pass is the actual work. **This is the test that was supposed to
guard stop placement.**

### 8. Leg samples are polls, not trips

`MIN_LEG_SAMPLES = 5` (`src/data/legTimes.ts:24`) is documented as the guard
against one slow afternoon being the whole answer, but `recordLegs` has no
per-trip and no per-date dedupe. Five samples can be five polls of one bus over
ten minutes.

The shipped `public/service-history.json` shows it: a `2` -- two seconds for a
stop-to-stop leg -- at the end of four different legs simultaneously, plus a 604
and a 1375. `legSeconds` takes a median, so these are absorbed and no rider is
handed a wrong number today. It is a data-honesty defect, in the file whose
entire claim is that its durations were measured.

Fix: dedupe per trip, and reject absurd values rather than only `<= 0`.

### 9. `buildBoard` supersession is keyed on a `seq` the same file proves incomparable

Live `seq` is GTFS-RT's own numbering (`src/data/realtime.ts:27`); static `seq`
comes from `stop_times.txt` (`src/data/gtfs.ts:98`). The comment at
`src/data/departures.ts:39-47` measures the two agreeing on about one stop in
ten. So a live prediction rarely supersedes its scheduled twin, and a rider can
be shown both times for one bus.

`test/departures.test.ts` builds both sides from one helper, so it manufactures
the agreement it asserts.

### 10. `serviceHistory.local()` manufactures Sunday

`Math.max(0, dows.indexOf(get("weekday")))` (`src/data/serviceHistory.ts:56-63`)
turns an unrecognised weekday into 0, and `Number("") % 24` into NaN. The app
can print "on 3 of the 8 Sundays watched" on a Tuesday -- in the one file whose
thesis is never claiming more than was observed.

### 11. `serviceHistory` day counting hides a dead recorder and dilutes new routes

`updated` only advances when the record changes, so a recorder that stopped
looks exactly like a service that did not move. And `days` is a global
denominator, so a route watched for two weeks reads as "seen on 2 of the 40
Fridays".

### 12. Post-midnight departures are an hour off on the two DST days

`dayStart - DAY_SECONDS` (`src/data/departures.ts:22`) assumes 86400 seconds.
It is wrong at 2am on the two changeover days -- in the hours that file's own
comment calls exactly the hours the shuttle is the only way home.

### 13. `parallel()` compares unprojected bearings

`parallel()` (`scripts/snap-to-streets.ts:53-65`) takes bearings from raw
lat/lng while `dist` and `toSeg` project through `xy()`. At latitude 41.83 the
distortion reaches 8.3 degrees, so `PARALLEL_DEG = 40` is really a 32-48 degree
window depending on heading.

### 14. Unbridgeable way transitions are counted and shipped anyway

`writeFileSync` (`scripts/snap-to-streets.ts:280`) is unconditional, so
"reported" means a digit in a build log. `docs/RENDERING.md:57` claims they are
"never silently skipped": true -- they are teleported over instead.

### 15. The snapper's build input is a test fixture

`scripts/snap-to-streets.ts:113` reads `test/fixtures/route-paths.json`, while
the app fetches the same payload live. They drift apart silently and nothing
compares them.

### 16. `pressHandled` is consumed by the wrong handler -- the long-press bug is live

MapLibre keeps all `click` listeners in one array, in registration order. The
map-level handler (`TransitMap.tsx:455`) is registered at init; `routes-hit`
(`TransitMap.tsx:380`) later, inside `drawRoutes`. So the click that ends a long
press reaches the map handler first, which clears the flag and returns, and
`routes-hit` then reads false and fires. **The bug the comment says was fixed is
in the build.**

`test/TransitMap.test.tsx:37-38` asserts the opposite dispatch order, so it
passes.

Fix: clear the flag on the next `mousedown`/`touchstart`, not on the click.

### 17. `isStyleLoaded()` gates two one-shot effects

`TransitMap.tsx:517` (routes) and `:798` (overlay). `isStyleLoaded()` is false
during any pan, zoom or tile fetch, and neither effect has a dep that can fire
again -- so if `feed` resolves mid-fetch the routes never draw, and the walking
legs arrive during the 650ms `fitBounds`.

`FakeMap.isStyleLoaded()` returns true unconditionally, so no test can see it.

### 18. Four `catch { /* the next render rebuilds */ }` blocks cannot rebuild

Effects do not re-run on render, and `ready` never increments after first load:
there is no `styledata` listener and no `setStyle` call anywhere in `src/`. The
comment describes a recovery that does not exist.

### 19. The lane geometry is rebuilt and re-uploaded on every zoom step

`laneRuns` is recomputed on every zoom step and produces a byte-identical
FeatureCollection, which is pushed through `setData`, re-uploading every GPU
buffer. `laneIndex` runs twice per redraw. Only `laneApprox` and
`stationFeatures` need `mpp` at all.

### 20. The selected stop's tween restarts every 10 seconds

`selection` is a fresh object literal on every parent render
(`src/ui/App.tsx:378`) and the app re-renders every 10s on the bus poll, so the
grow tween is torn down and started again. With a stop card open, the dot
visibly shrinks and re-grows every 10 seconds.

### 21. Dead code

- `laneSnap` (`src/render/lanes.ts:131-157`, 27 lines) -- zero callers.
- `isWalkOnly` (`src/routing/plan.ts:66`) -- zero callers.
- `walkTimesAreEstimated()` (`src/routing/walk.ts:232`) -- implemented, and
  documented as something the UI should surface. Never called.

### 22. Documentation upkeep

This file and `HANDOFF.md` drift fast, because the work moves faster than the
prose. Re-true both whenever a "Still to do" item ships, and delete rather than
accumulate — the value is in being correct cold, not in being a diary.

---

## Done, and the rule each one established

Newest first. Each line is the rule, not the change.

**2026-08-30**

- **Snap to the road, offset in pixels.** Routes are matched to real OSM road
  nodes at build time, and MapLibre displaces them with `line-offset` in device
  pixels. The gap is 5.00px at every zoom, by construction -- there is no
  length in the expression that could be metres. Nine tuning mechanisms deleted.
  This is `renderer-checkpoint`, and the owner called it correct.
- **Five follow-up "fixes" were reverted, all of them.** Junction-stub
  absorption, butt caps, straightness-weighted lane ordering, frame continuity
  by union-find, and a lane ladder tied to the road. Each improved the number
  it was aimed at; every one raised the count of visible run boundaries, and
  the owner reported the map looked worse after each. **Measure the boundary
  count before believing any rendering change.** The full table is at the end
  of `docs/RENDERING.md`.

**2026-08-29**

- **A live departure whose realtime trip stops short is still a ride.** Passio
  predicts only the stops a vehicle has left to serve, so the last stops of a
  trip have no downstream prediction. Treating "realtime knows this trip" as
  "realtime knows every leg" threw the whole ride away. Falls through to the
  static trip, keeping the live departure and taking only the DURATION from the
  timetable.
- **Refreshing must be free, not avoided.** Itineraries are built from live
  departures, so they must re-plan as those move — but the board was once a
  dependency and hit Valhalla every 30s, and a throttled response reads as a
  network error. `stablePosition()` snaps the origin to 10m so the walk-matrix
  cache key stops churning: 4 polls sent 4 requests unsnapped, 1 snapped.
- **Never assert service hours.** Two empty states named Brown's schedule in
  prose. `calendar.txt` is one row through 2027 with no `calendar_dates.txt`, so
  "not running today" has no field to live in. Saying service is over is no
  safer than saying a bus is coming.
- **An effect that reads a prop must depend on it.** The walking dotted line
  vanished because the effect building the itinerary's map sources omitted
  `overlay`. Every other overlay test passed the prop at mount then fired load —
  the one ordering production never has.
- **Fill the GTFS's holes from Passio, but only its holes.** The export ships
  22427 with no trips and no shape, and 3302 with one trip covering two of nine
  stops. `routePaths.ts` fills shape, stop order, and the active-route list —
  and never overwrites what the GTFS does carry.
- **Don't draw a bus on a route with no line.** Passio reports charters (6868)
  and routes it does not publish (3528). A marker floating on no line claims a
  rider can board.
- **Measure rendering in screen pixels.** See the dead ends below.
- **Observation is the only honest answer to "when does it run".**
  `scripts/record-service.ts` samples every 15 minutes in CI and commits only
  when the record moves; days, not samples; nothing said under three days.
- **Read the rider's clock, not the planning clock.** "Leave now" was decided
  against the *planning* time, so a trip planned for the evening told the rider
  to leave immediately.
- **An animation is not verified by looking at a preview.** rAF does not fire in
  a hidden tab, so the clock has to be driven by hand. Doing that for the
  stop-selection tween — which was carried as "still reads as a jump", and does
  not — found a real defect: `if (!start) start = now` treats a frame timestamp
  of 0 as falsy, so the tween measured from the SECOND frame and could stall.
  Browsers pass large timestamps, which is exactly why it survived.

**Earlier**

- Planning is generation-counted, not a boolean guarded by `cancelled` — a
  superseded run never reached its own `finally`, so the spinner stuck.
- Stops snap to the line as DRAWN, never the raw shape.
- A ride is sliced from the same geometry the route under it is drawn from.
- Geocoding is Photon, not Nominatim: Nominatim matches whole words, so "trad"
  found nothing and the app wrongly said the place did not exist.
- Two routers, never one: a single volunteer host is a single point of failure
  for the app's whole purpose.

---

## Dead ends — measured, and not to be retried blind

### Metre-based metrics for a pixel-based defect

The squiggle outlived a dozen attempts because **every measure taken of it was
in metres while the offsets that cause it are in device pixels**, so a number
could improve while the map got worse. Three separate invented proxies —
"turns added in metres", "doubled-pass points", "visible kinks" — each moved the
wrong way or **counted the fix as the defect**, since merged points coincide.
Index-aligned comparisons are equally useless: the drawn line gains and loses
vertices, so compare to the source polyline **by geometry**.

What worked: measure the drawn line against its own source, at the zoom the app
actually opens at (~14.2 on a phone), and pin both axes — sideways reversals AND
distance off-street, since straightness bought by shoving the line off its road
is not a win. `test/squiggle.test.ts` did that job and is deleted -- it
measured a wobble the current design cannot produce. `test/snappedShapes.test.ts`
replaces it, and pins the offsets in pixels.

### Scaling the ease-in taper with zoom

Plausible — the ramp is a fixed 60m while the offset is 5 device px, so at zoom
13 the line moved its full offset over 4 pixels of travel. Measured worse:
kinks 8 → 12 at zoom 13. Not shipped.

### Growing the self-merge threshold with the lane gap

Also plausible: offsets split a route's two passes further than the fixed 12m
merge threshold can rejoin. Measured worse: doubled-pass points 269 → 311 for
3302. Raising `selfMergeM` 12 → 30 cleared a real eyelet at the Fones Alley
junction, verified in isolation, but was a wash overall (Express 25.6 → 21.5,
Connector 8.6 → 13.1) and was reverted. **It was never a squiggle fix.**

What did work: a **median over the offset signal**, holding a lane assignment
for 80 screen pixels before the line moves. An average smears real transitions;
a median deletes an excursion shorter than half its window and leaves a
sustained change in place. Four of five routes went to 0–2.4 reversals per
1000px and moved *closer* to their streets.

### Street-matching the shapes to road centrelines — REVERSED 2026-08-30

**This entry used to say street-matching "does not pay". That was wrong, and it
is now the architecture that ships** (`docs/RENDERING.md`). The measurement
behind the old entry was correct; the conclusion drawn from it was not, which
is the more useful lesson.

What was measured: matched geometry sits within 7.4m of Passio's traced line
everywhere, about 5 pixels at zoom 16. What was concluded: matching is not
worth it, because the routes are already on their roads.

The error is that **moving the line was never the point.** The point is that
matching gives every route segment a *shared identity* -- two routes down one
street cite the same OSM node ids and therefore have byte-identical
coordinates. That turns "are these the same street?" from a proximity-and-angle
guess made per vertex at draw time into exact string equality. Nine tuning
mechanisms existed only to survive that guess, and all nine are now deleted.

A measurement answers the question you asked. Before recording something as a
dead end, check that the question was the one that mattered.

(`scripts/match-shapes.ts`, the ~60-request OSRM matcher this entry described,
is deleted. `scripts/snap-to-streets.ts` does the job with ONE Overpass call.)

### Passio's `outdated` flag as the source of truth for active routes

It lies about seasonal suspension. The list that does work is `routes` minus
`excludedRoutesID` from `getStops=2` — measured identical to the five ids that
had been hardcoded.

### OSM way ids as the lane frame

The snapper knows which OSM way each node came from and discards it. Carrying it
through looks like the elegant fix for the lane frame, because a way has its own
node order and would give an orientation continuous along a street.

Measured: way-based framing produces **42** frame sign-flips against the current
lowest-id-route scheme's **30**. Worse -- OSM way node-order is arbitrary, and
consecutive ways along one street often oppose. Do not retry.
