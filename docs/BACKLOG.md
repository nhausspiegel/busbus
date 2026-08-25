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
