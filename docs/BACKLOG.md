# Backlog

Root causes, not symptoms. Written so it can be picked up cold after a
compaction: everything needed to act is here or named by file.

**Read `docs/HANDOFF.md` too** — it records how the user wants to be worked
with, and the approaches already ruled out, which is what stops the next
session repeating them.

Last trued against the code on **2026-09-06**.

**Branches, as of that date.** `main` is trunk and is what GitHub Pages serves;
it is current. `render-tuning-wip` carries one commit -- the lane tuner,
sharp-corner splitting and station bead placement -- rebased onto main
2026-09-06, tsc clean, 413 tests passing. It is UNVERIFIED RENDERING and is
parked deliberately: check it out to look at it, do not merge it blind.
`render-node`, `node-render` and `push-verify` are deleted; the first was
identical to main and the other two were fully contained in it.

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

### 3. DONE — the Express's stop-to-stop times have arrived

Measured 2026-09-05 against `origin/main`'s record (NOT the working tree, which
was five days stale — see `docs/LESSONS.md`): route 3302 has 9 recorded legs, 8
of them at twenty samples against a floor of five, and the chain a rider needs
from Hillel House to Dyer & Hay is covered. Route 62487 has 13 usable of 27. The
Stadium Loop still has none.

Caveat before trusting a duration from this: `e4e7da1` made sampling per-trip so
fifteen-minute polls stop inflating counts, is now DEPLOYED (2026-09-06).
Samples recorded before that are still poll counts -- the twenties in the live
record are not twenty separate buses -- and they age out of the rolling
20-sample window as real ones arrive.

Known asymmetry while that lands: `transfers.ts` builds the FIRST leg from
`trip1.stops` directly, so a route whose GTFS trip omits its stops can be the
second leg of a transfer but never the first. Left alone deliberately —
transfers are secondary, the direct path covers the Express, and fixing it means
duplicating the observed-leg walk into another code path.

### 4. DONE — the fallback route list is written down once

Lives in `routePaths.ts` beside `parseActiveRoutes`, imported by App and the
snapper. Verified against the LIVE payload 2026-09-06: 8 routes,
excludedRoutesID `[-1, 72922, 72923, 72924]`, leaving exactly the five.


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

### 8. DONE — leg samples are deduped per trip

`recordLegs` keys on a trip stamp and rejects anything over MAX_LEG_SECONDS.
Shipped in `e4e7da1` and now deployed. NOTE: samples recorded BEFORE that
deployment are still poll counts -- the twenties in the live record are not
twenty separate buses. They age out of the rolling 20-sample window.


### 9. DONE — buildBoard supersession is keyed on trip and stop

`const call = (d) => \`${d.tripId}|${d.stopId}|${d.seq}\`` with the match made on
`tripId|stopId`, so live no longer has to agree with static on a seq the two
feeds number differently. Shipped in `e4e7da1`.


### 10. DONE — serviceHistory.local() throws rather than inventing Sunday

An unreadable weekday or hour now raises instead of filing the sample under
Sunday at midnight. Shipped in `e4e7da1`.


### 11. DONE — day counting is per bucket, not global

`observed()` reads `history.days[bucket]`, so a route watched for two weeks is
measured against the Fridays actually watched. Shipped in `e4e7da1`.

Still true and NOT fixed: `updated` only advances when the record changes, so a
dead recorder looks like unmoved service. Low stakes -- and this session found
the recorder alive and healthy by checking origin/main directly.


### 12. DONE — post-midnight departures use the real previous local midnight

No longer `dayStart - 86400`, so the two DST changeover days are right.
Shipped in `e4e7da1`.


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

### 16. DONE — the long-press guard is spent by the next press

Read, never cleared, by the click; cleared on the next mousedown/touchstart.
FakeMap now dispatches clicks in one registration-ordered list with
queryRenderedFeatures answering from the same hit set, so the test fails on the
old code. `55959b9`.


### 17. FIXED ON A BRANCH, not merged — `isStyleLoaded()` gates two one-shot effects

One defect, fixed together on **`map-reliability`** (`6229fe0`), rebased on
main, tsc clean, 420 tests. An effect that bails on a mid-load style registers
a one-shot `styledata` handler that bumps a retry counter in its deps, so it
runs once the style settles; the counter advances only on an actual bail, so
the happy path costs nothing.

NOT merged deliberately: it changes WHETHER route lines appear, which wants
looking at on a real map first. `git checkout map-reliability` and load :5173.

FakeMap's `isStyleLoaded()` returned true unconditionally, which is why this
shipped; it is controllable now and the new test fails against the old code.


### 18. FIXED ON A BRANCH, not merged — four `catch` blocks cannot rebuild

One defect, fixed together on **`map-reliability`** (`6229fe0`), rebased on
main, tsc clean, 420 tests. An effect that bails on a mid-load style registers
a one-shot `styledata` handler that bumps a retry counter in its deps, so it
runs once the style settles; the counter advances only on an actual bail, so
the happy path costs nothing.

NOT merged deliberately: it changes WHETHER route lines appear, which wants
looking at on a real map first. `git checkout map-reliability` and load :5173.

FakeMap's `isStyleLoaded()` returned true unconditionally, which is why this
shipped; it is controllable now and the new test fails against the old code.


### 19. The lane geometry is rebuilt and re-uploaded on every zoom step

`laneRuns` is recomputed on every zoom step and produces a byte-identical
FeatureCollection, which is pushed through `setData`, re-uploading every GPU
buffer. `laneIndex` runs twice per redraw. Only `laneApprox` and
`stationFeatures` need `mpp` at all.

### 20. DONE — the selected stop's tween survives a bus poll

Keyed on the stop ID, and `selectedRadius` is now the single owner of
`circle-radius` -- `stopPaint` was writing a base value over the tween whenever
the emphasis effect re-ran. `f845073`.


### 21. DONE — a walking time says when it is an estimate

`walkMatrixMulti` returns `{ rows, estimated }`, `planBetween` marks the
itineraries it built from a fallback, and `ItineraryList` says so.

Read off the itineraries rather than passed in as a prop, deliberately. The
previous attempt at this honesty was `walkTimesAreEstimated()`, a flag with
zero callers -- the appearance of the thing. A caller-supplied boolean has the
same failure mode one step later: forget it and the app silently claims the
walk was measured. Derived from the data, it cannot be forgotten.


### 22. Documentation upkeep

This file and `HANDOFF.md` drift fast, because the work moves faster than the
prose. Re-true both whenever a "Still to do" item ships, and delete rather than
accumulate — the value is in being correct cold, not in being a diary.

---

### 23. Say WHY there is no shuttle, using the record we already keep

"Why did no directions turn up?" — answered 2026-09-05, and the planner is not
at fault. Every gate below the top of `planTrips`'s loop is open for Address J
-> RISD Fleet Library on the Express: Hillel House is 85m from one end and a
candidate, Dyer & Hay 290m from the other and a candidate, the single GTFS trip
covers both (seq 1 and seq 3), and the observed legs between them carry twenty
samples each. All three ride-construction paths can build that ride.

What is missing is a live departure to hang it on, and the reason is service:

```
route 3302 Daytime Express  Mon-Fri only, hours 7-17, never a weekend
  present in 16 of 16 sampled WEEKDAY-DAYTIME buckets = 100%
  (16 of 51 buckets overall; the other 35 are nights and weekends)
route 62487                 21 buckets, Mon-Fri, 7h-20h
```

Measured live at Sat 22:04-22:22, a point sample plus twelve at 60s intervals:
**0 tripUpdate entities and 0 vehicles in all thirteen**, on every route.

Mind the distinction that nearly produced a wrong answer here.
`scripts/record-service.ts` fills `seen`/`days` from `fetchVehicles()` --
vehiclePositions -- so those buckets record a bus reporting its POSITION. The
board is built from tripUpdates. Position is necessary for a prediction, not
sufficient, and citing one as the other is this project's standing trap.

The evidence that tripUpdates does carry this route is separate and stronger:
`legs` is filled from `fetchLiveDepartures()`, which reads tripUpdates, and
route 3302 holds twenty samples on `7864|7865`. That leg cannot exist unless
tripUpdates published a prediction AT Hillel House, the boarding stop, on every
one of those occasions. (Twenty is a poll count, not twenty distinct buses --
see the `legTrips` caveat in item 3 -- but it is not zero.)

So the app declining to name a bus on a Saturday night is correct, and there is
no time gate and no arithmetic error to find.

Still unmeasured, and cheap to settle: a weekday 7h-17h poll of tripUpdates, to
learn whether predictions are CONTINUOUSLY present during service or only
intermittently. It does not change the fix below either way.

The defect is that it does not SAY so. The rider gets a walk and an empty
result, while `public/service-history.json` already knows this route was only
ever seen on weekday daytimes. That statement clears the non-negotiable on its
own terms: observed, counted in days, past tense — "this route has only been
seen running Mon-Fri, 7am-5pm" claims nothing about the future.

`serviceHistory` is already surfaced on the route page and stop card. It is not
surfaced on the results screen, which is the one place a rider is being handed a
walk instead of a bus. That is the fix.

### 24. `stopRoutes()` gates candidates on GTFS trips alone

`routeDetail.ts`'s `stopRoutes()` builds its servable set only from
`feed.trips`, and `trip.ts:42-43` uses it to decide which stops may take one of
the eight candidate slots. Measured 2026-09-05: 36 of 70 stops are eligible; 44
would be if `feed.routeStops` were folded in. Eight stops that sit on a real
route can never be planned to or from — including Dyer & Pine/Public Health,
306m from the RISD Fleet Library and on the Express.

**The exclusion is deliberate and the reasoning still partly holds** — read
`routePaths.ts`'s `withRouteStops` comment before touching it. A stop with no
trip behind it has no times to ride on, and letting those compete for slots is
how 6 of the 8 nearest to Barus & Holley became parking lots and monuments.
What changed since: `plan.ts` path 3 can now time such a stop from observed
legs. So the fix is NOT "fold in routeStops" — it is "a stop is a candidate if
it has a trip OR its route's adjacent legs are observed", and it belongs in
`trip.ts` where the candidates are chosen, not in `stopRoutes` whose other
callers want the current behaviour. Held pending item 23.

### 25. Shah's Halal is not in OpenStreetMap

Not an app defect. Checked against Overpass 2026-09-05: OSM carries 31 named
food POIs on that block of Thayer — East Side Pockets, Kabob and Curry,
Chinatown on Thayer — and zero matching `/shah|halal/i` anywhere on College
Hill. Photon indexes OSM, so no geocoder built on it can return what OSM lacks.

The fixable half shipped: the 70 shuttle stops are now searchable, which they
never were. What still will not turn up: anything OSM lacks, and any query under
three characters (`MIN_QUERY`). If this keeps biting, the answer is adding the
place to OSM, or a second source — not a change to the filter.

### 26. DONE — the destination is named once

The results eyebrow duplicated the search bar directly above it. Removed from
both call sites. `4674356`.


### 27. `test/fixtures/route-paths.json` is a stale capture

It carries 4 routes; the live `getStops=2` payload has 8 (measured 2026-09-06:
excludedRoutesID `[-1, 72922, 72923, 72924]`, leaving 22427, 3302, 3469, 3470,
62487 -- which is exactly `FALLBACK_ACTIVE_ROUTES`, so the fallback is right).

Consequences: any test comparing derived state against the real network is
measuring a subset, and a measurement taken FROM this fixture will understate
things. It already misled one -- counting the Express's stops from it gives 9
against a fixture that does not carry two of the active routes at all.

Refresh with `scripts/refresh-fixtures.sh`, then re-true whatever asserts
against it. Not done blind: refreshing changes what several tests see, and that
diff wants reading rather than accepting.

### 28. GitHub skips most of the recorder's scheduled runs

`record-service.yml` is `cron: "*/15 * * * *"` -- 96 runs a day, so every
hour-of-day slot should be hit every day. Measured 2026-09-06 over the first 8
days: only 57 of 168 weekday-hour slots were EVER sampled. GitHub drops
scheduled workflow runs under load and makes no promise about them.

This is now the binding constraint on how fast the observed-service record
becomes usable -- more than MIN_DAYS or the bucket width, both of which have
been addressed. Nothing here is a code defect. Options if it matters: accept
slower coverage, or move the recorder somewhere with a real scheduler. Do not
"fix" it by lowering MIN_DAYS; that trades honesty for speed, which is the one
trade this file exists to refuse.

### 29. Measured leg times may be systematically SHORT — they measure predictions, not buses

`legTimes` derives a leg from the gap between two PREDICTED times on one live
trip. That is a measurement of Passio's predictions, not of a bus. If its
predictions are internally compressed -- and bunching is normal in realtime
feeds -- every derived duration inherits the compression.

Measured 2026-09-06, the Daytime Express, Hillel House -> South Street Landing:

```
measured legs sum   194s  -> 30.8 km/h average over ~1.66km with 3 stops
GTFS timetable      600s  -> 10.0 km/h
```

Neither is obviously right. The timetable is a round ten minutes with BLANK
intermediate times, so it is a placeholder rather than an observation. But
30.8 km/h including three stops is optimistic for a campus shuttle, and the
error would bias arrival estimates EARLY -- telling a rider they arrive sooner
than they will, which is the direction that makes someone miss a connection.

This only affects routes that fall through to observed legs -- the Express.
The Connector has 38 timetable trips covering 14 stops and rides on those.

Settle it with ground truth, which nothing in the repo currently has: ride the
Express and time it, or record a prediction and compare against the arrival
that followed. Until then no number here should be trusted to better than the
factor of three above. Do NOT "fix" it by scaling the measurement to match the
timetable; that is fitting observation to a placeholder.

## Done, and the rule each one established

**Routefinding requires a real location.** The origin fell back to the middle of
campus when location was denied, and said so in grey text under the results.
Disclosure is not honesty: every walking time, every "leave by" and which stop
is even nearest all rest on that guess, and the app also sent a volunteer
router a walk matrix from a place nobody was standing. `origin` is now
`LatLng | null`, so the type forces every downstream path to face it rather than
one view remembering to. Rule: **do not compute an answer from a premise the
rider never supplied -- decline, and say what is missing.**


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
