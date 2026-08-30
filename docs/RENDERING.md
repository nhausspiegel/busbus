# How route lines are drawn

Written 2026-08-30, when the owner first called the rendering correct. It
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
- `orientSegments` — a **canonical frame** per segment, propagated along whole
  routes in id order. Without it, two routes driving one street in opposite
  directions each offset along their own travel normal and land exactly on top
  of each other.
- `laneIndex` — for each segment, which routes use it, in a stable order.
- `relaxOrder` — resolves who gets which side. Two routes on a segment often
  both want the side they held on the previous segment and one must give; with
  no reason to prefer either, the loser was whichever route id sorted first, so
  a line running dead straight through a junction got shoved aside by one that
  had just turned in. Each claim is weighted by how straight the route runs
  through the segment (1 dead ahead, 0 at a right angle).
- `laneOffsets` — the per-segment offsets for one route, **with junction stubs
  absorbed**. See the next section; this is the subtle one.
- `laneRuns` — splits a route into features wherever the offset changes, each
  carrying `laneOffset`. Consecutive runs overlap by one node.
- `laneApprox` / `laneSnap` — the same offsets applied per vertex, so stops and
  buses sit on the line **as drawn**, not on the centreline underneath it.
  These must always go through `laneOffsets`, or they will disagree with the
  drawn line at exactly the junctions that are hardest to get right.

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

Hence `JUNCTION_M = 25` in `laneOffsets`. At a corner the crossing route
genuinely shares a metre or two of the same OSM way, so membership goes
2 → 3 → 2 over seven metres, everyone re-centres, and a seven-metre feature is
emitted at its own offset. Any run shorter than a junction is absorbed into
whichever neighbour holds more road, so a stub never decides the lane of the
street it interrupts.

Measured before the fix: six runs of 4.0–7.1m, and the shortest real street
block 34.2m. Nothing lies in that gap, so the constant is not a tuned knob.

**It is in world metres on purpose.** It describes how OSM draws a junction —
a fact about the data, not about the display — so it must not move with zoom.
That is not a relapse into metre-based symbology: the *offset* is still pixels
and only pixels.

---

## Current numbers

Re-derive rather than trust; every one of these came from a script.

| measure | value |
|---|---|
| lane gap | 5.00px at every zoom (was 3.7px @z13 → 13.5px @z18) |
| features drawn | 50 for 5 routes |
| shortest run | 34.2m (was 4.0m) |
| snapped length ÷ traced length | 0.98–1.01× per route |
| two-way distance, snapped vs trace | ≤7.4m p90 |
| reversals >150° | 0, except one real hairpin on Allens Ave |
| side-jumps (road straight, line hops across it) | 3 |
| knobs | `LANE_GAP_PX`, `JUNCTION_M` |

`test/snappedShapes.test.ts` pins length ratio, reversals, two-way distance,
the exact offset set, and the minimum run length.

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
