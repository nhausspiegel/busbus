# Backlog

Root causes, not symptoms. Written so it can be picked up cold after a
compaction: everything needed to act is here or named by file.

**Read `docs/HANDOFF.md` too** — it records how the user wants to be worked
with, and the approaches already ruled out, which is what stops the next
session repeating them.

Last trued against the code on **2026-08-30**.

For how route lines are drawn, read `docs/RENDERING.md` first.

---

## Still to do

### 1. Three side-jumps remain

A **side-jump** is the road running straight (turn < 60°) while the line hops
to the other side of it (world-space displacement swings > 90°). Measured
2026-08-30, three remain of four:

```
3469  41.82788,-71.40317   turn=2   swing=178    (Angell)
3470  41.82613,-71.40462   turn=3   swing=177
62487 41.82392,-71.40014   turn=0   swing=180
```

Cause: group membership changes, and both routes want the side they held on
the previous segment, so one must give. `relaxOrder` in `src/render/lanes.ts`
weights each claim by how straight the route runs through the segment, which
fixed the junction-stub cases but not these -- here the conflict is real and
someone genuinely has to move.

Whether that is even wrong is a judgement call: two lines swapping order over a
long block is a *lane change*, which real transit maps do draw. What is
definitely wrong is doing it abruptly. The honest fix is the LOOM line-ordering
formulation -- minimise order changes over the whole network at once, rather
than segment by segment.

**Measure it with the world-space displacement, never with the sign of
`offsetPx`.** That sign must flip wherever the canonical frame opposes travel,
precisely so the line stays on the same side of the road; counting those flips
calls the correction a defect, which has now been done twice.

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

### 4. `snap-to-streets.ts` hardcodes the active route ids

`const ACTIVE` in the script lists the five route ids. A route Passio adds
keeps its raw traced shape and draws without lane offsets -- degraded, not
broken -- until someone re-runs the script. Worth deriving from the feed the
next time the script is touched; not worth a special trip.

### 5. Route rendering polish

Corner radius is no longer a knob at all: `CORNER_RADIUS_PX` and the densifier
that clamped it dead are both deleted, and corners are `line-join: round`,
which MapLibre draws correctly *within* a feature. What remains is boundaries
**between** features -- see `docs/RENDERING.md`, "The fragile part". Fewer,
longer features is the only lever; `JUNCTION_M` took the count from 56 to 50.

### 6. NearbyBoard is hidden, not deleted

The owner found it useless but may want it back. `NearbyBoard.tsx` and its tests
are untouched; `src/ui/App.tsx` carries the element to restore in a comment.

### 7. Documentation upkeep

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
- **A lane change shorter than a junction is not a lane change.** At a corner a
  crossing route genuinely shares a metre or two of the same OSM way, so
  membership goes 2 -> 3 -> 2 over seven metres and a stub feature is emitted
  at its own offset. MapLibre joins only WITHIN a feature, so each boundary is
  a fake join: a nub under round caps, a notch under butt caps. Changing the
  cap changed only which artefact appeared.
- **Going straight is the stronger claim to a lane.** When two routes on one
  segment both want the side they already held, the loser used to be whichever
  route id sorted first -- so a line running dead straight through a junction
  was shoved aside by one that had just turned in.

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
