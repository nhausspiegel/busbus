# How route lines are drawn

Written 2026-08-30. The state described here is `git tag renderer-checkpoint`
-- the rendering the owner called correct. Four later "fixes" were measured and
**every one made it slightly worse**, so they were reverted wholesale; see
"What was tried and reverted" at the end. It
exists because the whole design lived in commit messages and one session's
head, and the previous design survived ~100 commits mostly because each session
found it already written and assumed it was load-bearing.

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
  backtracking is *inexpressible* rather than penalised.
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
  each carrying `laneOffset`. Runs overlap by one node. **This is where the
  open defect lives** — see "The fragile part" below.
- `laneApprox` / `laneSnap` — the same offsets applied per vertex, so stops and
  buses sit on the line **as drawn**, not on the centreline underneath it.

The offset is centred: `(index − (n−1)/2) × LANE_GAP_PX`. Centring means every
line shifts when a route joins or leaves the group. **The owner has explicitly
asked to keep that** — do not "fix" it.

### 4. MapLibre

`LANE_GAP_PX = 5` in `TransitMap.tsx`; `symbols.ts` sets
`"line-offset": ["get", "laneOffset"]`. MapLibre displaces the line on the GPU
in **device pixels**, so the gap is 5.00px at every zoom by construction —
there is no length in the expression that could be metres. Corners are
`line-join: round`; there is no corner-radius knob any more.

---

## The fragile part: feature boundaries

MapLibre can only build a join **within one feature**. `line-offset` is
data-driven per *feature*, not per vertex, so a route whose offset changes must
be split into several features — and every boundary between them is a join
MapLibre cannot make.

That single fact produced two symptoms that looked unrelated:

| cap style | artefact at a boundary |
|---|---|
| `round` | a **nub** — the cap bulges past the corner |
| `butt`  | a **notch** — a wedge of background at the outside of the corner |

Changing the cap only changed which one appeared. The real fix is to have
**fewer, longer** features.

Measured 2026-08-30, that is not a rare edge: **all 47 run boundaries are
visible.** 25 of them fall on a corner, where the outgoing feature overspills
the turn and the route appears to bend at two points instead of one. 21 are
wider than the 4.5px stroke, which leaves a clean gap in the line.

No cap style fixes this. It is the split itself. The honest options are:

1. **Fewer boundaries.** Anything that reduces how often the lane changes.
   Absorbing junction stubs took 47 to 45 and was still not close.
2. **One feature per route**, with the offset applied to the geometry and
   rebuilt whenever the scale changes. That is the only way a lane change can
   be a ramp rather than a jump, and it makes every corner a real join. It was
   attempted and looked worse than what it replaced -- see the end of this doc.

Until one of those lands, this is the ceiling on how good the map can look.

## Current numbers

Re-derive rather than trust; every one of these came from a script.

| measure | value |
|---|---|
| lane gap | 5.00px at every zoom (was 3.7px @z13 → 13.5px @z18) |
| features drawn | 52 for 5 routes |
| visible run boundaries | 47 -- 25 on corners, 21 wider than the stroke |
| shortest run | 4.0m |
| snapped length ÷ traced length | 0.98–1.01× per route |
| two-way distance, snapped vs trace | ≤7.4m p90 |
| reversals >150° | 0, except one real hairpin on Allens Ave |
| side-jumps (road straight, line hops across it) | 4 |
| knobs | `LANE_GAP_PX` |

`test/snappedShapes.test.ts` pins length ratio, reversals, two-way distance and
the exact offset set.

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
- **Do not offset in geometry.** It was tried; the gap then grows with zoom,
  which is the original defect.
- **Do not reach for the cap style when a corner looks wrong.** Look for a
  feature boundary first.

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
