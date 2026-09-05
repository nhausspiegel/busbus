# How route lines are drawn

Written 2026-08-30, revised 2026-09-01. The baseline described here is
`git tag renderer-checkpoint` -- the rendering the owner called correct. Four
later "fixes" were measured and **every one made it slightly worse**, so they
were reverted wholesale; see "What was tried and reverted" at the end. Two
things have landed on top of that baseline since: `src/render/links.ts`, which
draws the junctions instead of hoping two features meet, and the 512px-tile
`metresPerPixel` constant. This doc exists because the whole design lived in
commit messages and one session's head, and the previous design survived ~100
commits mostly because each session found it already written and assumed it was
load-bearing.

**The one rule everything else follows from:**

> Geometry is in world coordinates and is never moved. Symbology — the gap
> between two lines sharing a street — is in device pixels and is never baked
> into geometry.

Every rendering defect this project has had came from mixing those two.

---

## Why it was hard before

The app did not know **which road a line was on**. Passio ships a polyline
traced down one side of the road with no road identity, so the renderer decided
"are these two lines the same street?" per vertex, at draw time, from proximity
and heading:

```ts
if (d > o.thresholdM) continue;                                       // 25m
if (!parallel(tan[i]!, tans[q.l]![q.i]!, o.headingTolDeg)) continue;  // 30°
```

Nine mechanisms existed only to survive that guess — `thresholdM`,
`headingTolDeg`, `stepM`, `taperM`, `selfMergeM`, `spread()`'s floor,
`trimFolds`, `LANE_HOLD_PX`, `CORNER_RADIUS_PX` — and each produced its own
symptom: gaps that grew with zoom, lopped corners, eyelets at junctions, a
corner radius clamped dead by the densifier.

Supplying the missing fact removed the need for all nine. The fix deleted far
more than it added.

---

## The pipeline

### 1. Build time — `scripts/snap-to-streets.ts`

Run by hand; output committed. Turns each route's traced polyline into a
sequence of **real OSM road nodes**.

- The road network is **ONE Overpass request** for the bbox of the route
  shapes, cached in `.cache/`. 2,743 ways, 14,140 nodes, ~1.7s. It is not 60
  requests to a routing API — see CLAUDE.md §0.
- Densify the trace to 20m; candidates are ways within 40m and parallel within
  40°; take the nearest. Those bounds only build a *candidate set* — the chain
  constraint below is what decides.
- Compress to a chain of ways. Any consecutive pair not sharing a node is
  bridged by bounded Dijkstra (≤100m) **weighted by metres**, not hop count.
  Unbridgeable transitions are reported, never silently skipped.
- Traverse each way from the junction entered to the junction left, so
  backtracking is *inexpressible* rather than penalised. **Except on a closed
  ring entered and left at the same node** — that is a loop the route really
  drives, so the whole ring is walked, in the direction the trace's own node
  order gives (`ringDir`). See the ring trap below for what index arithmetic
  did instead.
- Close the loop.

Measured: 159/161 way transitions already share a junction node (98.8%), and
both exceptions are one junction with endpoints 8.1m and 18.9m apart. That is
why no HMM or Viterbi is needed.

Output `public/gtfs/shapes-snapped.json`:

```json
{ "nodes": { "<nodeId>": [lng, lat] }, "routes": { "<routeId>": [nodeId, ...] } }
```

**The node table is the point.** Two routes down the same street get
byte-identical coordinates because they cite the same OSM node ids, so "same
street" becomes exact string equality instead of a distance test.

### 2. Load time — `src/data/snappedShapes.ts`

`withSnappedShapes` **overwrites** `route.shape` for routes present in the file
and leaves the rest alone. This is deliberately unlike `fillMissingShapes` in
`routePaths.ts`, which only fills holes: snapped geometry is a correction, not
a gap-filler. A route Passio adds tomorrow keeps its raw trace and still draws
— just without lanes. `scripts/snap-to-streets.ts` has the active route ids in
a `const ACTIVE`, so adding a route means re-running it.

### 3. Draw time — `src/render/lanes.ts`

- `segKey(a, b)` — an unordered pair of exact coordinate strings. Equality is
  exact, which is only sound because of the shared node table above.
- `laneIndex` — for each segment, which routes use it, sorted by route id, plus
  a `forward` end. Sorting by id is what keeps a route on the same side along
  its length; `forward` is the travel direction of the **lowest-id route** on
  the segment, because MapLibre offsets to the right of a feature's own
  direction and two routes driving one street in opposite directions would
  otherwise land in the same lane — measured at exactly 0.00px apart.
- `laneRuns` — splits a route into one feature per stretch of constant offset,
  each carrying `laneOffset`. Runs overlap by one node. Every cut is a join
  MapLibre cannot make; `links.ts` below is what draws those joins now.
- `laneApprox` / `laneSnap` — the same offsets applied per vertex, so stops and
  buses sit on the line **as drawn**, not on the centreline underneath it.
  Both are live: `TransitMap` calls `laneSnap` for each stop bead and each bus,
  and `laneApprox` for the drawn geometry as a whole. They reproduce in
  **metres** what the GPU does in **pixels**, so they are only as correct as
  `metresPerPixel` — see section 5.

The offset is centred: `(index − (n−1)/2) × TUNING.laneGapPx`. Centring means
every line shifts when a route joins or leaves the group. **The owner has explicitly
asked to keep that** — do not "fix" it.

### 4. Junctions and corners — `src/render/links.ts`

**A route line is no longer only runs.** Each run is pulled back from its
junctions by `clearPx` and the gap is reconnected with a short cubic curve.
`laneLinks` returns those curves already displaced, so they draw with
`laneOffset: 0` and ask nothing of the GPU.

Sharp corners are handed to the same connector, for a different reason:
`line-offset` places the displaced vertex on the **miter**, so a corner of
interior angle *t* pushes it out to `offset / sin(t/2)` — unbounded as the
corner sharpens, and untouched by `line-join`, which only rounds whatever the
spike leaves behind. Measured, that spiked a 5px offset to **7.2px** against a
4.5px stroke on the inside lane of a three-wide corner. `splitAtSharpCorners`
cuts on the **excess** (`miterExcessPx = 0.9`), not on the angle, because the
spike scales with the offset: one 95° corner overshoots by 1.2px in a two-wide
group and 2.4px in a three-wide one. Both halves keep the same offset, so the
connector rounds the corner rather than changing lane.

All four knobs are in `TUNING`, in device pixels, and `?tune` in the URL puts
sliders on them — every one was first set by guessing and corrected once the
owner looked at the map.

### 5. MapLibre

`TUNING.laneGapPx = 5`; `symbols.ts` sets
`"line-offset": ["get", "laneOffset"]`. MapLibre displaces the line on the GPU
in **device pixels**, so the gap is 5.00px at every zoom by construction —
there is no length in the expression that could be metres. Corners are
`line-join: round`; there is no corner-radius knob any more.

**`metresPerPixel` is `78_271.51696 · cos(lat) / 2^zoom`.** That constant is the
equator's circumference over the width of the world at zoom 0 *in this
renderer*, and MapLibre uses **512px** tiles: `40075016.686 / 512`. The 256px
figure — 156543.03392, which is what Google, Leaflet and most of the internet
mean by "metres per pixel" — was used here and is **exactly twice too large**.
Because `laneApprox` and `laneSnap` convert pixels to metres, every stop bead
and every bus was displaced **twice as far as its own line**: a bead sat a mean
2.2px off it, worst 8.3px. Now a mean 0.2px. Being off by a constant factor at
every zoom is why it never looked like a zoom bug, was invisible to review and
to unit tests, and survived a whole rewrite of the bundler.
It was caught by measuring against the running map: at zoom 13.1468, 100m of
ground measured 15.55px, so a pixel is 6.4309m, and this returns 6.4309.

---

## The fragile part: feature boundaries

MapLibre can only build a join **within one feature**. `line-offset` is
data-driven per *feature*, not per vertex, so a route whose offset changes must
be split into several features — and every boundary between them is a join
MapLibre cannot make. Measured 2026-08-30 on the five Brown routes: **47
boundaries, every one of them visible.**

Two separate things make a boundary visible, and only the first is obvious:

- the offset **changes**, so the two features are drawn at different distances
  from the road and the line steps sideways. Median 3.4px, max 10px.
- the two features meet at a **corner**, so their last and first segments have
  different normals and their ends part by `offset · |n1 − n2|` — up to **8px**
  — even when the offset either side is **identical**. **17 of the 47.**

That second one is why no cap style reaches this. A cap only chooses which
artefact appears at a boundary:

| cap style | artefact at a boundary |
|---|---|
| `round` | a **nub** — the cap bulges past the corner |
| `butt`  | a **notch** — a wedge of background at the outside of the corner |

Both were tried. **So stop trying to make the features meet.** `links.ts` pulls
them deliberately apart and draws the connection — which is what LOOM does
(Bast/Brosi/Storandt, *Efficient Generation of Geographically Accurate Transit
Maps*, stage 3: free node area, then inner connections as cubic Béziers).

The straight runs keep GPU `line-offset` exactly as before — untouched, and
still exact. Only the short curves are geometry.

The option NOT taken, for the record: **one feature per route**, with the offset
applied to the whole geometry and rebuilt whenever the scale changes. It was
attempted twice and rejected on sight both times — see the end of this doc.

## Current numbers

Re-derive rather than trust; every one of these came from a script.

| measure | value |
|---|---|
| lane gap | 5.00px at every zoom (was 3.7px @z13 → 13.5px @z18) |
| runs (`laneRuns`) | 52 for 5 routes; shortest 4.0m |
| run boundaries | 47, all visible -- 17 of them from the corner **alone**, at an identical offset either side. This is what `links.ts` now connects, not an open defect |
| stop bead / bus off its own line | mean 0.2px (was 2.2px, worst 8.3px, from the 256px constant) |
| snapped length ÷ traced length | 0.99–1.01× per route |
| two-way distance, snapped vs trace | ≤6.2m p90 |
| **worst** trace point to its drawn line | 8.6m, all routes (was 48.6m — see the ring trap) |
| reversals >150° | 0, except one real hairpin on Allens Ave |
| side-jumps (road straight, line hops across it) | 4 |
| knobs | `TUNING` — `laneGapPx`, `clearPx`, `miterExcessPx`, `curveTension` (`?tune`) |

`test/snappedShapes.test.ts` pins length ratio, reversals, two-way distance, the
exact offset set, and — added after the ring defect below — the **worst** trace
point, which is the only one of them that a single missing stretch can fail.

---

## Traps

- **Do not measure a sign flip of `offsetPx` as a defect.** When the canonical
  frame opposes travel the rendered offset *must* flip, precisely so the line
  stays on the same side of the road. Counting those calls the correction a
  bug — this has now been done twice. Measure the **world-space displacement**:
  the road runs straight (turn < 60°) but the line hops across it (swing > 90°).
- **Do not simplify or resample the snapped geometry.** It destroys the exact
  coordinate identity that `segKey` depends on, and every gap silently collapses
  to zero.
- **Do not offset in geometry** — but know what the rule is evidence of, because
  `links.ts` does exactly that on purpose. Offsetting the **whole line** by hand
  is what is banned: the gap then grows with zoom (the original defect), and it
  **folds** — at the zoom the app opens at the road's own vertices are ~1.3px
  apart against a 5px offset, so any scheme displacing vertices one at a time
  self-intersects, measured 20 times over. A short curve between two ports a few
  pixels apart cannot fold, and is rebuilt per zoom, so neither hazard applies.
  The line between them is length: a run's length must never be in metres; a
  connector's is only ever a few pixels.
- **Do not reach for the cap style when a corner looks wrong.** Look for a
  feature boundary first — and note that 17 of 47 were visible from the **corner
  alone**, at an identical offset either side, which no cap can help.
- **Do not use the 256px metres-per-pixel constant.** This renderer is 512px
  tiles; 156543.03392 is exactly twice too large. See section 5.
- **A closed OSM way cannot be walked by index.** `indexOf` returns 0 for both
  ends of a ring, so a way entered and left at the same node walked one node and
  the loop vanished. That deleted the Connector's hospital turnaround — way
  274668429, 135m, 20 nodes — leaving 15 consecutive trace points up to 48.6m
  from the drawn line, and put the Rhode Island Hospital stop 43.4m off its own
  route's centreline. Both the length ratio (0.984×) and the p90 were blind to
  it: a 135m ring is 1.7% of a 7.9km route. 40 of the 2,743 ways in the network
  are closed rings. `ringDir` picks which way round from the trace's own node
  order; it is derivable, not a guess.

---

## What was tried and reverted, 2026-08-30

Four changes on top of this baseline. Each was measured, each looked defensible
on its own number, and the owner reported the map looked **worse** after every
one. All four were reverted together, back to this state.

| change | its own number | what it cost |
|---|---|---|
| tie the lane ladder to the road, thin the strokes | fixed a reported side-swap | run boundaries 47 → **60** — the worst of the five |
| butt caps, orient the frame along routes | removed the corner nubs | replaced them with notches; 49 boundaries |
| order lanes by which route runs straight | — | 51 boundaries |
| absorb lane changes shorter than a junction (`JUNCTION_M`) | shortest run 4.0m → 34.2m, boundaries → 45 | side-jumps unchanged; corner overspill still 25 |
| frame continuity by union-find parity | side-jumps 4 → 1 | boundaries back up to 50, corners 25 → **31** |

The lesson is in the last column. Every one of these optimised a number that
was real, and every one was measured against something other than the thing
that had been complained about. **The boundary count is the number that tracks
what the map looks like**, and nothing above moved it in the right direction.

A fifth and sixth attempt -- one feature per route, the offset applied to the
geometry and rebuilt per zoom -- were both rejected on sight. The sixth was
finished rather than half-wired: stops and buses snapped to the same geometry
that was drawn, every test passing, and measured clean on every number anyone
had thought to take.

- folds 20 -> 1 at the opening zoom (naive offsetting produces 20; the source
  geometry has 0)
- gap between coincident routes exactly 5.00px at z13, z14.2, z16 and z18
- the side each route sits on matching this checkpoint, 436 samples to 29

It still looked wrong. **So this is now a measured dead end for the second
time, and the reason is none of the things listed above.** Before trying a
seventh, find a number that separates "looks right" from "looks crooked" --
none of boundary count, fold count, gap width or side agreement does.

The one thing worth keeping from it: at the opening zoom the road's own
vertices are ~1.3px apart while the offset is 5px, so ANY scheme that displaces
vertices one at a time folds over itself. Proper offsetting needs outer corners
reaching to the miter, inner corners pulled back to the crossing, AND excision
of loops spanning several segments. That code is in the dropped commit
`1c3ca9d` if it is ever wanted.

### What did land: `src/render/links.ts`

The seventh attempt does **not** reopen that question. Attempts 5 and 6 moved
the whole line into geometry and inherited every fold above; `links.ts` leaves
every straight run on GPU `line-offset`, untouched and still exact, and puts
into geometry only the few pixels **between** two runs — a span too short to
fold. That is why the ban in Traps still stands and this is not a violation of
it. The boundary count is no longer the ceiling because the boundaries are
drawn rather than hidden.
