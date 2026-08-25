# Backlog

Root causes, not symptoms. Written so it can be picked up cold after a
compaction: everything needed to act is here or named by file.

**Read `docs/HANDOFF.md` too** — it records the map-rendering failures and the
approaches already ruled out, which is what stops the next session repeating
them.

---

## Still to do

### 1. A running route does not appear on the map — UNVERIFIED, needs daylight

`ACTIVE` in `src/ui/App.tsx` is a hardcoded set of five route ids. Anything
Passio runs that is not in it is invisible: no line, no buses, and — since
stops with no active route are now filtered out — no stops either.

**Established:**
- Not a staleness problem. The shipped `public/gtfs/google_transit.zip` is
  5 days behind the live feed (feedEndDate 20260917 vs 20260922) with
  **identical routes and trip counts**.
- Only four of the ten routes in the feed have any trips: 62487 (38),
  3469 (86), 3470 (62), 3302 (1).
- `22427 Brown Stadium Loop` is in `ACTIVE` with **0 trips and no shape**, so it
  can never draw.
- `3302 Daytime Express` has **1 trip and 2 stops** against a 177-point shape,
  which is why its line has almost no stops on it. Upstream data, not a bug.

**Measured live on 2026-08-23 at ~21:55, 0 vehicles reporting:**
- Passio's private feed flags `outdated=0` for exactly `3302, 3469, 3470,
  22427, 62487` -- **identical to the hardcoded `ACTIVE`**. So the constant is
  not what is hiding a route, and deriving it from `outdated` would only add a
  network dependency to a flag CLAUDE.md already says lies about seasonal
  suspensions.
- The route serving the athletic complex is almost certainly **22427 Brown
  Stadium Loop**: flagged active by Passio, but 0 trips and no shape in GTFS,
  so there is genuinely no line to draw.
- **Its buses are not being suppressed by us.** Vehicles are never filtered by
  `ACTIVE`, and `snapToShape` returns the position unchanged when the shape has
  under 2 points, so a Stadium Loop vehicle would render at its raw GPS fix.
  The only open question is whether RT ever reports one.

**The check to run, during service hours (Brown runs ~7am–7pm weekdays):**
list `routeId` from GTFS-RT vehiclePositions and compare against the static
route ids. There were **0 vehicles reporting** when this was investigated, so it
could not be settled.

- If RT carries route ids the static feed lacks → derive the drawn set from
  *trips-today ∪ routes-with-live-vehicles* instead of the constant, and accept
  that such a route has no shape to draw (show its buses, not a line).
- If not → the missing route is something else; re-open with fresh evidence.

### 2. Corner radius is an unpicked knob

`CORNER_RADIUS_PX` in `src/ui/TransitMap.tsx` is 10, chosen by me not by eye.
`npx tsx scripts/bundle-knobs.ts` renders 0 / 8 / 16 / 28 to
`docs/bundle-knobs.svg`. Ask which.

### 3. Route rendering polish

The bundler is much better but not perfect. `npx tsx scripts/bundle-cases.ts`
draws the five reference cases to `docs/bundle-cases.svg`; both that and
`test/bundle.test.ts` are driven by `test/fixtures/bundleCases.ts`, so the
picture and the assertions cannot drift. Known soft spots:
- The Y-merge reaches 9.9 of a 12 gap and pinches slightly at the merge, which
  is partly unavoidable — two lines that merge genuinely touch.
- `trimFolds` drops vertices where an offset self-intersects; at sampling steps
  well below the offset it still leaves a sharp corner. Guarded at the
  densities actually used (10, 20), not below.

### 4. Map-matching shapes to street centrelines — deliberately deferred

Would fix "the routes aren't quite on their roads", which is upstream shape
data. Needs Valhalla map-matching run **offline at build time** and committed —
one request per user action rules out doing it live. Risks matching to the
wrong parallel street, which is worse than the current few metres. Does **not**
fix spikes or gaps; those belong to the offsetting.

---

## Done, and the rule each one established

Kept because the *rules* are what stop the bugs coming back.

- **Everything positioned along a route reads the geometry that was DRAWN,
  never `route.shape`.** The bundler moves routes; the line, its stops, the
  vehicles and the itinerary all project onto `drawnRef`, rebuilt per zoom.
  Three separate bugs had this one shape — buses twice, stops once. Stops went
  from a median 4.3m / worst 24m off the line to **0px at every zoom**.
- **One marker per PLACE, not per stop_id.** Passio splits a stop per
  direction — 20 pairs within 25m. `stations()` in `src/routing/routeDetail.ts`
  merges them and unions their routes: 33 markers → 23, interchanges 5 → 12.
- **One `selection` drives emphasis on every layer.** Routes, stops and bus
  markers all derive from it, so they cannot disagree.
- **Never present a guess with the confidence of a measurement -- and prefer
  drawing nothing to drawing a guess.** Valhalla answers in ~130ms, so a
  straight-line placeholder shown while waiting is only a flash of something
  false. Walking legs draw when they are real; a straight line means a leg that
  genuinely could not be routed and is drawn faint and loosely dotted in its own
  layer. The departure times went further and dropped the guess entirely: a
  timetable time is not a weaker claim, it is an unfounded one, so it is not
  shown at all. See CLAUDE.md.
- **Resolve independent things independently, and never gate a redraw on a
  filter over the results.** Both walking legs shared one success verdict, and
  the redraw was skipped when neither leg came back non-empty -- so a rider
  already at the boarding stop kept a straight line on screen permanently.
  `walkLegs()` in `src/routing/walk.ts` always returns one line per leg.
- **Symbology in device pixels and zoom-invariant; geometry in world
  coordinates, never edited to fake a visual effect.** Five attempts at the
  parallel-route styling failed by breaking this.
- **Measure the painted pixel, not a value upstream of it.** A marker's
  transform held the right coordinate while the browser painted it 30px per
  index away — an inline `position: relative` had knocked every marker into
  normal document flow. Guarded by a test.
- **A check that cannot fail proves nothing.** Join bus to route on
  `data-route-id`, never colour (Brown's routes share colours). Revert the fix
  and watch the test go red.
- **De-duplicate on what a rider can tell apart, not on an upstream id.**
  Passio publishes some trips twice under different trip_ids -- 218795 and
  218820 are byte-identical -- so the stop card listed one bus as two.
  `buildBoard` keys on stop + route + second; a loop's second visit has a
  different time and survives.
- **Order things along the route, not by distance to them.** Placing a vehicle
  in a stop list by nearest stop puts it behind itself on a loop, because the
  stop it passed a minute ago is still the closest one. `distanceAlongShape`
  in `src/routing/shape.ts` measures progress in the route's own order, modulo
  the shape length so the last stop's successor is the first.
- **Copy the layout, not the claim.** Apple's departure chips say "On-time";
  ours say "Live", because nothing here measures a bus against its timetable.

### 5. "Leave at" / "Arrive by" has nothing to plan with

`WhenControl` still sets `leaveAt`, and `planTrips` still takes it, but the
board is live departures only -- every one of which is within minutes of now.
Asking for 8am tomorrow can only ever return walking. The control is not wired
to anything false, it is wired to nothing. Either drive it from observed
service history (below) or remove it; leaving a control that cannot answer is
its own kind of lie.

### 6. Observed service history -- the only honest answer to "when is the next bus"

Nothing in any feed can say whether a route runs today (see CLAUDE.md for the
measurements). The one source that could is our own observation: log when
vehicles actually report, then say "last seen Fri 6:12pm" or "usually active
7am-7pm weekdays". That is a claim about recorded history rather than a
promise, it degrades gracefully, and it would give routes 3 and 4 a reason to
exist on screen when nothing is running.

---

## Reported 2026-08-24, triaged

Numbered by the order they were raised, not by priority. Priority order is
roughly: 7, 1, 2, 3, 4, 8, 5, 6, 9, 10.

1. **Pull-to-refresh on mobile must go.** It swallows the downward swipe on the
   sheet grabber, so it actively costs more than it gives.
2. **Grouped and single stops no longer share a visual language.** An
   interchange is a light pill with solid dots; a lone stop is a hollow bead.
   They now read as two unrelated symbols rather than two cases of one.
3. **Selecting a stop still does not animate**, despite the paint transitions
   measuring as real (0 idle frames vs 20 frames / 308ms). The transition
   fires; something about the change is not visible. Measure what the radius
   actually does, not whether frames render.
4. **A route's own stops must stay visible when that route is selected.**
5. **Route lines are not fully opaque**, so overlaps look muddy. `line-opacity`
   falls back to 0.9 with no selection; should be 1.
6. **Corners still produce "nubs"** -- short spurs sticking out of a corner.
   A bundler failure mode, visible on the live map. Belongs with route
   rendering polish.
7. **Valhalla throttling breaks walking, every time.** MEASURED: a pin drop
   fires `sources_to_targets` and it returns `TypeError: Failed to fetch` in
   100ms -- a throttle, not an outage, since a rate-limited response arrives
   without CORS headers and cannot be read as a 429. There is no cache and no
   backoff, so every pin drop pays full price and every failure retries into
   the same wall. This is also why the provisional dotted line never resolves.
8. **Directions view is messy.** Every other route should fade; the boarding
   and alighting stops need to be drawn as endpoints, with intermediate stops
   still visible.
9. **Dropping a pin while a route is selected leaves the route page open.**
   MEASURED: body shows "To Dropped pin / Clear" and the Evening CCW Route
   page at the same time. Mode precedence puts `routeId` above `dest`, so the
   new destination is invisible behind the old selection.
10. **Search results only appear after pressing Search.** Should appear while
    typing -- debounced, not per keystroke, because Nominatim is volunteer-run.

## Reported 2026-08-24 — resolved

| # | Item | Resolution |
|---|---|---|
| 1 | Pull-to-refresh blocks the grabber | It was the browser's; `overscroll-behavior` moved onto the scrolling element |
| 2 | Grouped vs single stops read as different symbols | One lozenge-with-dots symbol; a lone stop is the circular case |
| 3 | Stop selection does not animate | **Still open** — halo removed for looking wrong; see below |
| 4 | A route's stops must stay visible when selected | Ridden/selected routes keep their stops lit |
| 5 | Route lines not fully opaque | 0.9 → 1 |
| 6 | Corner "nubs" | **Still open** — see route rendering polish |
| 7 | Valhalla throttling breaks walking | Cache, de-dupe, 8s deadline, backoff, and a second router |
| 8 | Directions view messy | Non-ridden routes fade; board/alight drawn as endpoints |
| 9 | Pin drop behind an open route page | Long-press flag now guards the layer handlers too |
| 10 | Search only on submit | Photon type-ahead, debounced and floored |

### Also fixed in that round

- **Ghost dotted straight lines.** An unroutable leg drew a straight dashed
  line between its endpoints. It draws nothing now.
- **Two pins in quick succession did not recalculate.** Same root cause as the
  ghosts: one shared cooldown, so the first pin's failure refused the second
  pin's requests before they left.
- **The ride line did not sit on the route.** It was sliced from the raw Passio
  shape while the route was drawn from the bundler's output. Now sliced from
  the drawn line and rebuilt per zoom -- 1120 vertices, 0.00m offset.
- **Directions rested on one volunteer host.** FOSSGIS OSRM `routed-foot`
  first, Valhalla second, per-host backoff.

## Still to do, from that round

### A. Stop selection has no animation

The paint transitions are real (0 idle frames vs 20 over 308ms) but were
measured on `routes-line`, never on the circles, and selecting a stop still
reads as a jump. A halo marker was tried and removed: it looked like a stray
circle, and its CSS animation fought MapLibre for the marker element's
`transform`, which is the same failure that once laid the bus markers out in
document flow. Whatever replaces it must not animate `transform` on a marker
element.

### B. Corner "nubs"

Short spurs sticking out of corners on the live map. A bundler failure mode;
belongs with route rendering polish.

### C. One route drawn as two parallel lines

Passio traces a route's outbound and return legs as separate geometry a few
metres apart. Measured on the shipped feed:

| route | self-pairs within 20m | median gap | doubled runs | longest |
|---|---|---|---|---|
| 3302 Daytime Express | 230 | 9.0m | 2 | 43 vertices |
| 62487 Connector | 168 | 8.4m | 4 | 24 vertices |
| 3469 Evening CW | 1 | 1.0m | 0 | 1 |

Drawn faithfully that is one route showing as two parallel lines with a narrow
spur where the passes meet -- the "nubs". A route is ONE line on a transit map
whichever way the bus is pointing, so the two passes should be merged onto a
centreline.

**Attempted and reverted.** A `selfMerge` pass that moved both members of a
close self-pair to their midpoint made the doubled stretch coincident (median
gap 9 -> under 2 in a fixture) but left DUPLICATE vertices with opposing
tangents. `turn()` reads a zero-length segment as 0 degrees while the offset
output reads 180, so it tripped the "never folds back on itself" invariant at
both sampling densities. Merging has to collapse the doubled stretch into a
single traversal rather than leaving two coincident ones; that is the piece to
get right next time.

---

## The pattern behind most of these

Four defects this round were the same defect wearing different clothes: **two
geometries for one thing.** Vehicles beside their own line; stops drifting off
it; the itinerary's ride sliced from the raw Passio shape while the route under
it came from the bundler; the ends of a ride drawn as their own symbol beside
the stops already there. Each was found by eye, in production, one at a time.

They shared a cause. The derivation lived inside a React effect and read the
drawn geometry out of a ref, so every consumer re-derived positions on its own
and nothing could be checked without a browser -- and a check that runs in the
page can only ask what was DRAWN, never whether it was right. That is why
`queryRenderedFeatures` twice reported a bar as present that was never visible,
and why "the ride sits 0.00m off the route" said nothing about where it ended.

`src/render/network.ts` now derives all of it from one `drawn` map passed in,
and `test/network.test.ts` asserts the invariants against the real feed with no
browser at all: every bead within 6m of the line it belongs to at three zooms,
a ride within 0.5m of the route beneath it, a ride ending within 30m of its
alight stop. Reverting each historical bug turns the matching test red -- 11.18m,
5,898m, 0 ticks.

**The same move is still available elsewhere:**

1. **One definition per symbol.** Stop sizes are set by the layer AND re-set by
   the selection effect; they diverged once already (an interchange dot at 3.5
   against a lone stop's 2.5, with the white shapes agreeing at 14.2px).
   `selectedRadius()` is the beginning of this; the fills, strokes and the tick
   widths still have two homes.
2. **Planning as a state machine.** `planning` is a boolean guarded by a
   `cancelled` flag, and a cancelled run skips clearing it -- which is how the
   spinner stuck forever behind a fresh `origin` object every geolocation
   report. Explicit phases would make that unrepresentable.

---

## Reported 2026-08-24, second round

Grouped by cause rather than by symptom, because most of them share one.

### Root cause: the bundler assigns a lane PER POINT, and it wobbles

MEASURED on the shipped feed, per route, over one loop:

| route | points | lane-index changes | bundle-size changes | median run |
|---|---|---|---|---|
| 3302 | 397 | 18 | 9 | **3 samples (30m)** |
| 62487 | 875 | 22 | 12 | 6 samples |
| 3470 | 371 | 14 | 11 | 20 samples |
| 3469 | 371 | 11 | 13 | 16 samples |

Route 3302 changes its lane assignment every ~30 metres. Every change moves the
line sideways. These are all the same defect:

- [ ] **Nubs / spurs on the purple line.** Not the bus's actual route.
- [ ] **Green lines at an acute angle.** Should be coincident or parallel,
      never converging. Passio traces 3302's out-and-back 9.0m apart (230 self
      pairs), and the bundler then gives the two passes DIFFERENT displacements
      -- measured on the Connector, own-pass separation grew from 13.4m at p90
      in the source to 19.2m after offsetting, median 1.8m to 3.8m.
- [ ] **Kink in the orange line** on a straight street.
- [ ] **Stops change which line they sit on between zooms.** A bead is snapped
      to its own route's drawn line, so when that line's lane flips, the bead
      goes with it.

**The fix being built:** snap every route's shape to the street it runs on, at
build time, and commit it (`scripts/match-shapes.ts`). Two routes on one street
then share the SAME geometry rather than a nearly-identical one, so there is
nothing left for the nearest-neighbour search to guess at and nothing to wobble.
It also fixes "the routes aren't quite on their roads", which has been open for
ages. Verified the tool works before building on it: FOSSGIS OSRM `/match`
returns confidence 0.94-0.98 on Brown's shapes, at up to ~10 trace points per
request (25 is refused as TooBig), so it runs in overlapping chunks.

Every match is checked before being accepted -- map matching's failure mode is
snapping confidently onto the wrong parallel street, which is worse than the
few metres it fixes.

### Fixed in this round

- [x] **A station rendered as a bare dot at some zooms.** The white lozenge
      came only from the bar joining a station's beads, and that bar is only
      emitted when the beads are far enough apart to span -- which depends on
      the lane gap, which depends on zoom. `stops-base` now covers every bead,
      so a stop's background cannot depend on whether a bar was drawn.
- [x] **Desktop zoom-out on route select was far too aggressive.** The fit
      reserved half the viewport HEIGHT for the sheet, which is a bottom tray
      on a phone and a side panel on a wide screen. `framePadding()` now
      reserves the panel's width instead.

### Still open from earlier rounds

- [ ] Planning is a boolean guarded by a `cancelled` flag rather than a state
      machine; a cancelled run skips clearing it. That is how the spinner stuck.

---

## Street-matching the shapes: TRIED, MEASURED WORSE, NOT SHIPPED

The idea was sound and is worth recording properly, because it is the obvious
thing to reach for and the numbers say no.

`scripts/match-shapes.ts` snaps every route's shape onto the road network via
FOSSGIS OSRM's `/match`, at build time. It works, and it is accurate:

| route | src pts | matched pts | chunks | failed | moved median | max |
|---|---|---|---|---|---|---|
| 62487 | 163 | 567 | 21 | 0 | 0.4m | 7.6m |
| 3302 | 177 | 235 | 22 | 0 | 0.0m | 6.3m |
| 3470 | 31 | 217 | 4 | 0 | 3.4m | 7.0m |
| 3469 | 24 | 199 | 3 | 0 | 3.6m | 7.1m |

4 kept, 0 rejected. Confidence 0.94-0.98. The public instance takes at most 10
trace points per request (12 is refused as TooBig) and a rejection takes ~9.8s,
so it runs in overlapping chunks with a deadline.

**And it makes the drawing worse**, measured on the same metric both ways --
turns the bundler ADDS that the source does not have, matched by nearest source
point because `applyLanes` trims vertices and the indices do not align:

| shapes | added turns >20 deg | worst | lane-index changes |
|---|---|---|---|
| raw Passio | 70 / 2005 pts | +176 deg | 56 |
| street-matched | **217 / 2589 pts** | +180 deg | **120** |

Matched geometry is far denser (567 points against 163) and follows every
kerb, so there are many more short segments for the offsetting to fold. The
loader was written and then reverted; the script and this table are kept so
nobody spends another afternoon discovering it.

## The real diagnosis, written down

The bundler asks "are these two lines the same street?" independently at every
10m sample, from traces that are 7-9m apart and weaving. That question has no
stable answer, so every mechanism layered on top -- smoothing, dilation, a
median despeckle, a quantised sort key, ordering by a run median -- is an
approximation of an approximation. Each was tried and each moved the metric by
almost nothing:

| attempt | added turns |
|---|---|
| baseline | 70 |
| + median despeckle of the displacement | 70 |
| + ordering on a locally smoothed offset | 70 |

All reverted. The fix is not another filter: it is to make the question exact.
Snap coincident geometry to ONE shared polyline first, so two routes on a
street have identical vertices rather than nearly-identical ones, then
membership is equality and there is nothing left to wobble. Measured, a
clustering radius of 8m would move points a median of 1.9-3.3m (max 4.9m) and
covers 793 of 1883 sampled points; 12m covers 1006 and moves them 2.5-4.6m.
That is the next thing to build, and it should replace the per-point
membership search rather than sit in front of it.

---

## The rewrite that actually fixed the lines (2026-08-25)

Everything above about nubs, acute wedges, kinks and stops swapping lines was
ONE defect, and no amount of filtering touched it. The old renderer asked "are
these two lines the same street?" independently at every 10m sample, from
traces Passio draws 7-9m apart that weave around each other. That question has
no stable answer, so the lane assignment oscillated -- route 3302 changed lane
eighteen times around one loop, roughly every 30m -- and every flip stepped the
line sideways by a full lane gap.

Four attempts to damp it (median despeckle, quantised sort key, ordering by a
per-run median, ordering on a locally smoothed offset) each moved the defect
count by nothing. They were approximations of an approximation.

**What replaced it, in three parts:**

1. **The shapes are matched to the streets** (`scripts/match-shapes.ts`, run at
   build time, output committed). Passio's traces wander and two routes down
   one street sit at different angles; matched, both land on the same OSM way.
   4/4 routes kept, 0 rejected, moved 0.0-3.6m median. The Connector's average
   wiggle drops from 15.6 to 9.0 degrees.

2. **Corridors are found by IDENTITY, not proximity** (`src/render/graph.ts`).
   Because matched routes share the same OSM way they share the same vertices
   exactly -- 3469 and 3470 share 120 to a tenth of a metre -- so membership is
   a map lookup. There is no radius to tune. `shareCorridors`, written earlier
   the same day to cluster nearby points, was deleted: matching made it
   unnecessary.

3. **The offset is one number per EDGE.** An edge is a stretch carrying a fixed
   set of routes; each route is ranked once for the whole stretch. A per-vertex
   decision cannot wobble because there is no per-vertex decision. Edges
   shorter than 6 samples are contracted, because a membership change lasting
   20m is a gap in the pairing rather than a change of street: that takes the
   network from 138 edges with a median length of 40m to 50 edges at 190m, and
   sideways moves from 126 to 40.

**Two details that mattered more than they look:**

- Lanes are NOT centred on the corridor. `rank - (n-1)/2` moves every incumbent
  sideways when another route joins (-0.5/+0.5 becomes -1/0/+1), and that step
  is the jog in a straight street. Anchoring at rank 0 means a joiner slots in
  beside the others and nobody else moves.
- The gap is capped in METRES as well as pixels. Five pixels at z13 is 71m of
  ground, and a lane wider than the street folds the line around every corner:
  15 reversals at z13 with a worst of 176 degrees, against 0 at z12 and z17.5.
  Capped at 11m: 2 reversals, worst 50.

**Measured after, across the whole network:** sharp turns over 30 degrees are
0 at z12, 2 at z13, 2 at z14.6, 2 at z16, 0 at z17.5, worst 53 degrees --
against a map that previously showed visible spurs and wedges at every zoom.

### The old bundler is gone

`src/render/bundle.ts` (546 lines of searching, sorting, smoothing, dilating
and despeckling) is now `src/render/geometry.ts` (82 lines: the point types and
corner rounding). Everything else propped up a per-vertex answer to a question
that should never have been asked per vertex. `test/bundle.test.ts` and
`scripts/bundle-knobs.ts` went with it; the five reference cases live on in
`test/graphCases.test.ts` and `scripts/render-cases.ts`, pointed at the
renderer that actually draws the map.

If the corner-radius knob sheet is wanted again, it was `bundle-knobs.ts` in
the history and would now sweep `drawLanes`'s `cornerRadiusM`.

---

## State at the end of 2026-08-25

Route drawing is rewritten and verified in production: **0 sharp turns over 30
degrees** across the network at z14.6, against a map that previously showed
spurs, acute wedges and kinks at every zoom. Across zooms: 0 at z12, 2 at z13,
2 at z14.6, 2 at z16, 0 at z17.5.

### Still open

1. **Planning is a boolean, not a state machine.** `planning` is guarded by a
   `cancelled` flag and a cancelled run skips clearing it -- that is how the
   spinner once stuck forever behind a fresh `origin` object on every
   geolocation report. Fixed by memoising origin, but the shape is still
   fragile. Explicit phases (idle / planning / ready / failed) would make the
   stuck state unrepresentable.
2. **`WhenControl` has nothing to plan with.** Every live departure is minutes
   away, so "8am tomorrow" can only return walking. Either drive it from
   observed service history or remove it.
3. **Observed service history.** Nothing in any feed can say whether a route
   runs today. Logging when vehicles actually report, and stating that history,
   is the only honest answer to "when is the next bus" -- and it is what would
   give the app something to say when nothing is running, which at night and
   through the summer is most of the time.
4. **A running route with no shape.** 22427 Brown Stadium Loop is flagged
   active by Passio with 0 trips and no shape, so no line can be drawn. Its
   buses would render at their raw positions if any ever reported; whether RT
   ever carries them is still unverified.
5. **Re-run `scripts/match-shapes.ts` when the feed changes.** The matched
   shapes are committed, so they age with `google_transit.zip`. Takes about two
   minutes and prints how far each route moved -- anything over 45m is rejected
   rather than drawn.
