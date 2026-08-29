# Backlog

Root causes, not symptoms. Written so it can be picked up cold after a
compaction: everything needed to act is here or named by file.

**Read `docs/HANDOFF.md` too** — it records how the user wants to be worked
with, and the approaches already ruled out, which is what stops the next
session repeating them.

Last trued against the code on **2026-08-29**.

---

## Still to do

### 1. Evening CW keeps one visible sideways step

Route 3469 steps about 5 screen pixels sideways near Brook/Power. Not noise:
the route passes that spot twice, the bundle drops from three members to two,
and `spread()` re-centres the whole bundle on the mean, so every remaining line
shifts when one leaves.

Fixing it properly means **stable lane identity across membership changes** —
the LOOM line-ordering problem — rather than re-spreading per point. Deliberately
not attempted yet: lines closing ranks when a route leaves the corridor is
defensible behaviour, and the renderer is at a state the owner called the best
so far (`git tag renderer-checkpoint`). Capped where it stands by
`test/squiggle.test.ts` so it cannot quietly get worse.

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

### 4. Corner radius is a DEAD knob, and reviving it is a design choice

`CORNER_RADIUS_PX` in `src/ui/TransitMap.tsx` is 10 and **does nothing**.
Measured: 6 / 10 / 16 / 24 produce byte-identical geometry at the opening zoom
and differ by at most 0.18px at zoom 16.5.

The cause is in `roundCorners`:

```ts
const cut = Math.min(radius / Math.tan(theta / 2), inL * 0.4, outL * 0.4);
```

The clamp is 40% of the ADJACENT SEGMENT, but the path reaching it is densified
to `stepM` (10m), so the cut can never exceed 4m however large a radius is
asked for — 0.6px at zoom 14.2. Every setting clamps to the same 4m.

Clamping against the run to the next **corner** instead makes it real; that was
written and reverted, because reviving it is not a free bug fix:

| corner | 22427 | 62487 | 3302 | 3470 | 3469 | (wiggles/1000px, caps 2/5/5/5/16) |
|---|---|---|---|---|---|---|
| 0px | 0.0 | 3.1 | 2.0 | 5.1 | 17.4 | |
| 2px | 0.0 | 2.3 | 2.0 | 3.4 | 14.1 | **the most that fits** |
| 3px | 0.0 | 5.3 | 5.8 | 3.4 | 14.0 | over cap |
| 10px | 11.7 | 12.3 | 5.8 | 22.9 | 20.9 | far over |

Cutting a corner IS a deviation from the source line, so `squiggle.test.ts`
counts it as one — the metric was calibrated while rounding was inert. And
today's accidental 4m clamp is WORLD-space: 0.6px zoomed out, 4.8px zoomed in.
No single screen-space value reproduces the current look at both ends.

So the fork is: keep corners as sharp as they effectively are now, or accept a
softer, more Underground-like corner and teach the straightness metric to
ignore deviations at genuine corners. Owner's call; do not change it silently,
the renderer is at `renderer-checkpoint`.

### 5. Route rendering polish

`npx tsx scripts/bundle-cases.ts` draws the five reference cases to
`docs/bundle-cases.svg`; both it and `test/bundle.test.ts` are driven by
`test/fixtures/bundleCases.ts`, so picture and assertions cannot drift.

**These show the bundler ALONE** — without the screen-space lane hold the map
applies, because the hold suppresses separation over short runs and would hide
what the cases exist to measure. They are therefore **not** a picture of what
the app draws; `test/squiggle.test.ts` is the production check.
Remaining soft spots:
- The Y-merge reaches 9.9 of a 12 gap and pinches at the merge, partly
  unavoidable — two lines that merge genuinely touch.
- `trimFolds` drops vertices where an offset self-intersects; well below the
  offset it still leaves a sharp corner. Guarded at the densities actually used
  (10, 20), not below.

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
is not a win. Now `test/squiggle.test.ts`.

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

### Street-matching the shapes to road centrelines

The obvious idea, and it does not pay. `scripts/match-shapes.ts` works and its
seam bug is fixed (chunks used to re-traverse their overlap: p99 turn angle
180°, a full reversal). But measured **point-to-segment in both directions, the
matched line sits within 7.4m of Passio's traced line everywhere** — the same
line with more vertices, worth about 5 pixels at zoom 16. Its output is not
committed and nothing reads it. Do not re-run this expecting the routes to move
onto their roads; they are already on them.

### Passio's `outdated` flag as the source of truth for active routes

It lies about seasonal suspension. The list that does work is `routes` minus
`excludedRoutesID` from `getStops=2` — measured identical to the five ids that
had been hardcoded.
