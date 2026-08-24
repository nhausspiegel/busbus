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

**The check to run, during service hours (Brown runs ~7am–7pm weekdays):**
list `routeId` from GTFS-RT vehiclePositions and compare against the static
route ids. There were **0 vehicles reporting** when this was investigated, so it
could not be settled.

- If RT carries route ids the static feed lacks → derive the drawn set from
  *trips-today ∪ routes-with-live-vehicles* instead of the constant, and accept
  that such a route has no shape to draw (show its buses, not a line).
- If not → the missing route is something else; re-open with fresh evidence.

### 2. Duplicate rows in the stop card

Sciences Library lists `Evening CW Route · 4 min · 9:37 PM` **twice**,
identical. Seen after the station merge but almost certainly not caused by it —
`StopCard` is still passed a single stop_id, so the duplicate is in the board
for that stop. Look at `buildBoard` in `src/data/departures.ts`: likely a loop
trip calling twice, or a live departure not de-duplicated against the scheduled
one it replaces.

### 3. Corner radius is an unpicked knob

`CORNER_RADIUS_PX` in `src/ui/TransitMap.tsx` is 10, chosen by me not by eye.
`npx tsx scripts/bundle-knobs.ts` renders 0 / 8 / 16 / 28 to
`docs/bundle-knobs.svg`. Ask which.

### 4. Route rendering polish

The bundler is much better but not perfect. `npx tsx scripts/bundle-cases.ts`
draws the five reference cases to `docs/bundle-cases.svg`; both that and
`test/bundle.test.ts` are driven by `test/fixtures/bundleCases.ts`, so the
picture and the assertions cannot drift. Known soft spots:
- The Y-merge reaches 9.9 of a 12 gap and pinches slightly at the merge, which
  is partly unavoidable — two lines that merge genuinely touch.
- `trimFolds` drops vertices where an offset self-intersects; at sampling steps
  well below the offset it still leaves a sharp corner. Guarded at the
  densities actually used (10, 20), not below.

### 5. Apple-style route detail view — the biggest remaining feature

From the user's own screenshots of Apple Maps (recorded in `README.md`):
- **Upcoming Departures chips** replacing the `Bus 105` / `Bus 106` vehicle
  labels: `10 min · On-time` (live, red, radiating glyph), `52 min · Scheduled`
  (grey), plus a right-aligned `Every N min` headway.
- The **vehicle's position** drawn inline in the stop list, stops behind it
  dimmed.
- **Connecting-route badges** under each stop name — `stations()` already
  supplies the route ids.
- **Distant stops collapsed** to `23 previous stops` / `41 additional stops`.
- **Absolute clock times** in the column rather than `N min · H:MM`.

### 6. Map-matching shapes to street centrelines — deliberately deferred

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
  layer. Same rule as hollow-vs-solid departure times.
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
