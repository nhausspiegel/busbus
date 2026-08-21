# Transit Map Styling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the route lines, their spacing, and the stop markers read like a
transit map (Apple Maps / NYC subway / London Underground) rather than raw GTFS
polylines.

**Architecture:** Three independent changes. Corner rounding is a pure geometry
function in `src/routing/shape.ts` applied once and shared by both the drawn
line and the bus snapping. Route separation uses MapLibre's per-feature
`line-offset`, which is already in pixels — no geometry is rewritten and nothing
depends on zoom. Stop styling derives a stop → routes map and drives circle
paint from it.

**Tech Stack:** React 19, TypeScript strict (`noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`), MapLibre GL, vitest (+ jsdom for component
tests).

## Global Constraints

- No new npm dependencies. Stdlib and already-installed only.
- Tests never hit the network. Use the frozen fixtures in `test/fixtures/`.
- `busbus.py` is the live-verification tool, not app code. Do not import it.
- Never present a timetable time as if it were live.
- The bus marker element's inline style MUST keep `position: absolute`.
  Assigning `el.style.cssText` replaces the whole inline style; an inline
  `position: relative` overrides `.maplibregl-marker { position: absolute }` and
  drops every marker into normal document flow, where they lay out side by side
  30px apart. `test/TransitMap.test.tsx` guards this — do not break it.
- Anything drawn under a bus must be the SAME geometry the bus is snapped to.
  Buses are snapped with `snapToShape` in `src/ui/TransitMap.tsx`.
- Verification must end at the **painted pixel**, not at an intermediate value.
  Compare `getBoundingClientRect()` of the visible element against
  `map.project()`. A correct coordinate proves nothing about what is on screen.
- Join a bus to its route by `route_id` (`data-route-id` on the marker), never
  by colour — several Brown routes share a colour.
- Run `npx tsc --noEmit` and `npx vitest run` before every commit; both clean.

## Apple Maps reference

Taken from screenshots of Apple Maps showing RIPTA Route 1, provided by the
user. These are observations of the real app, not guesses — where this plan says
"like Apple Maps", it means one of these.

- **The stop list is ONE vehicle's run.** Absolute clock times down the column
  (4:21 PM, 4:23, 4:24, 4:25 …), strictly increasing. Never a countdown per
  stop, and never a mixture of vehicles.
- **Other vehicles are separate "Upcoming Departures" chips**, in a horizontal
  row above the stops: `10 min / On-time`, `52 min / Scheduled`,
  `6:05 PM / Scheduled`. Right-aligned headway: `Every 41 min`.
- **The vehicle's current position** is a bus glyph in a ringed circle, inline
  in the stop list at the stop it is at.
- **Distant stops collapse**: `23 previous stops` above and
  `41 additional stops` below, with a `More` control. Only the relevant span is
  expanded, and those rows are bold white with a bright line; everything else is
  dimmed grey.
- **Connecting routes are badges under the stop name** — small rounded squares
  carrying the route's short name in the route's colour (`71` `72` `78` `R`).
  Apple does NOT colour-code the stop circle by route in the list.
- **Live vs scheduled**: live times are red with a radiating-waves glyph;
  `On-time` is green; `Scheduled` is grey. This is a ready-made vocabulary for
  this project's rule that a timetable time must never read as a live one.
- **Map stops** are small white circles with a thin coloured ring; the vehicle
  is a larger solid dot with a white ring; the route line is thick with clearly
  rounded corners.
- **Ride length is counted in hops**: `Ride 2 stops, 6 min` for a ride from
  Tunnel & Thayer to Kennedy Plaza via one intermediate stop. This confirms the
  existing "3 stops" label is right.
- **Itinerary cards** lead with the duration (`9 min`), then
  `Bus departs at 4:44 PM  Now 4:42 PM · 4:48 PM ETA`, then a row of
  walk-chip → route badge → mode glyph.

**Concurrency note:** a separate session is running in the worktree
`.claude/worktrees/mystifying-wu-484ed0` on bus movement animation. It edits the
live-buses effect of `src/ui/TransitMap.tsx`. Tasks 2 and 3 below edit the
route-drawing and stops sections of the same file. Regions do not overlap, but
expect to resolve a merge.

---

### Task 1: Slight corner rounding on route lines

Apple Maps transit lines have visibly rounded corners. GTFS shapes are polylines
with hard vertices. `line-join: round` only rounds the join of a 4px stroke,
which is imperceptible.

**Files:**
- Modify: `src/routing/shape.ts` (add `roundCorners`, next to `snapToShape`)
- Test: `test/shape.test.ts`
- Modify: `src/ui/TransitMap.tsx` (route drawing effect + bus snapping)

**Interfaces:**
- Produces: `roundCorners(shape: LatLng[], radiusM?: number): LatLng[]`
  — default `radiusM = 10`. Pure, deterministic, no network.

- [ ] **Step 1: Write the failing tests**

Append to `test/shape.test.ts`:

```ts
describe("roundCorners", () => {
  /** 200m north, then 200m east: one hard right angle at the corner. */
  const corner: LatLng[] = [
    { lat: 41.8240, lng: -71.4000 },
    { lat: 41.8258, lng: -71.4000 },
    { lat: 41.8258, lng: -71.3976 },
  ];

  it("leaves a straight line exactly alone", () => {
    // Rounding must be a no-op where there is no corner, or every route
    // acquires wobble along its straight runs.
    const straight: LatLng[] = [
      { lat: 41.8240, lng: -71.4000 },
      { lat: 41.8250, lng: -71.4000 },
      { lat: 41.8260, lng: -71.4000 },
    ];
    expect(roundCorners(straight)).toEqual(straight);
  });

  it("replaces the hard vertex with a short arc", () => {
    const got = roundCorners(corner, 10);
    expect(got.length).toBeGreaterThan(corner.length);
    // The original corner vertex is gone.
    const hit = got.some((p) =>
      Math.abs(p.lat - 41.8258) < 1e-7 && Math.abs(p.lng - -71.4000) < 1e-7);
    expect(hit).toBe(false);
  });

  it("never strays further from the original line than the radius", () => {
    // The whole risk of smoothing: pulling the line off its street. A 10m
    // radius may cut the corner by at most 10m and nothing else may move.
    const got = roundCorners(corner, 10);
    for (const p of got) expect(haversineMeters(p, snapToShape(p, corner))).toBeLessThan(10.5);
  });

  it("clamps the cut on short segments instead of overshooting", () => {
    // Two 6m segments with a 10m radius: an unclamped fillet would consume
    // more than the whole segment and fold the line back on itself.
    const tight: LatLng[] = [
      { lat: 41.82400, lng: -71.40000 },
      { lat: 41.82405, lng: -71.40000 },
      { lat: 41.82405, lng: -71.39993 },
    ];
    const got = roundCorners(tight, 10);
    let total = 0;
    for (let i = 1; i < got.length; i++) total += haversineMeters(got[i - 1]!, got[i]!);
    let original = 0;
    for (let i = 1; i < tight.length; i++) original += haversineMeters(tight[i - 1]!, tight[i]!);
    expect(total).toBeLessThanOrEqual(original + 0.5);
  });

  it("keeps the endpoints, so a route still starts and ends where it did", () => {
    const got = roundCorners(corner, 10);
    expect(got[0]).toEqual(corner[0]);
    expect(got[got.length - 1]).toEqual(corner[corner.length - 1]);
  });

  it("handles degenerate shapes without throwing", () => {
    expect(roundCorners([])).toEqual([]);
    const two = [{ lat: 41.82, lng: -71.4 }, { lat: 41.83, lng: -71.4 }];
    expect(roundCorners(two)).toEqual(two);
  });
});
```

Add `roundCorners` to the import at the top of `test/shape.test.ts`:

```ts
import { sliceShape, snapToShape, roundCorners } from "../src/routing/shape";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/shape.test.ts`
Expected: FAIL with `roundCorners is not a function`

- [ ] **Step 3: Implement**

Add to `src/routing/shape.ts`, after `snapToShape`:

```ts
/** Turn angle below which a vertex is treated as straight, radians.
 *  GTFS shapes carry many near-collinear points; filleting each would multiply
 *  the vertex count for no visible change. */
const STRAIGHT_RAD = (8 * Math.PI) / 180;

/** Points sampled along each corner arc. Four is enough that a 10m fillet
 *  reads as curved at street zoom and cheap enough to run over every route. */
const ARC_STEPS = 4;

/**
 * Round the corners of a route polyline, slightly.
 *
 * Apple Maps transit lines are visibly curved at turns; a GTFS shape is hard
 * vertices, and `line-join: round` only rounds the join of the stroke itself.
 *
 * Each corner becomes a quadratic Bezier whose control point is the original
 * vertex, so the curve is guaranteed to stay inside the corner -- it can only
 * ever cut a corner, never bulge outside the original line. The cut is clamped
 * to 40% of each adjoining segment so short segments cannot be consumed and
 * folded back on themselves.
 *
 * ponytail: does not special-case the seam of a closed loop, so a route whose
 * shape starts mid-turn keeps one hard vertex there. One corner out of
 * hundreds; wrap the loop here if it ever shows.
 */
export function roundCorners(shape: LatLng[], radiusM = 10): LatLng[] {
  if (shape.length < 3) return shape;
  const out: LatLng[] = [shape[0]!];

  for (let i = 1; i < shape.length - 1; i++) {
    const a = shape[i - 1]!, b = shape[i]!, c = shape[i + 1]!;
    const inLen = haversineMeters(a, b), outLen = haversineMeters(b, c);
    if (inLen === 0 || outLen === 0) continue;

    // Turn angle at b. Near-straight vertices pass through untouched.
    const bearing = (p: LatLng, q: LatLng) =>
      Math.atan2(q.lat - p.lat, (q.lng - p.lng) * Math.cos((p.lat * Math.PI) / 180));
    let turn = Math.abs(bearing(a, b) - bearing(b, c));
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn < STRAIGHT_RAD) { out.push(b); continue; }

    const tIn = Math.min(radiusM, inLen * 0.4) / inLen;
    const tOut = Math.min(radiusM, outLen * 0.4) / outLen;
    const p = { lat: b.lat + (a.lat - b.lat) * tIn, lng: b.lng + (a.lng - b.lng) * tIn };
    const q = { lat: b.lat + (c.lat - b.lat) * tOut, lng: b.lng + (c.lng - b.lng) * tOut };

    out.push(p);
    for (let s = 1; s < ARC_STEPS; s++) {
      const t = s / ARC_STEPS, u = 1 - t;
      out.push({
        lat: u * u * p.lat + 2 * u * t * b.lat + t * t * q.lat,
        lng: u * u * p.lng + 2 * u * t * b.lng + t * t * q.lng,
      });
    }
    out.push(q);
  }

  out.push(shape[shape.length - 1]!);
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/shape.test.ts`
Expected: PASS

- [ ] **Step 5: Use the rounded shape for BOTH the line and the buses**

In `src/ui/TransitMap.tsx`, add `roundCorners` to the existing shape import:

```ts
import { snapToShape, roundCorners } from "../routing/shape";
```

Add a ref beside the other refs in the component body:

```ts
  /** Route shapes as DRAWN -- rounded once, then used for the line and for
   *  snapping buses. Two different geometries here is how buses ended up
   *  beside their own line before. */
  const drawnRef = useRef<Map<string, LatLng[]>>(new Map());
```

In the route-drawing effect, where `active` is built, round each shape and
record it, then pass the rounded shapes to `drawRoutes`:

```ts
    const active = [...feed.routes.values()].filter(
      (r) => activeRouteIds.has(r.id) && r.shape.length >= 2);
    const drawn = new Map(active.map((r) => [r.id, roundCorners(r.shape)]));
    drawnRef.current = drawn;

    try {
      drawRoutes(m, active.map((r) => ({
        id: r.id, color: r.color, shape: drawn.get(r.id)!,
      })));
```

In the live-buses effect, snap to the drawn geometry rather than the raw shape:

```ts
      const at = snapToShape({ lat: b.lat, lng: b.lng },
        drawnRef.current.get(b.routeId) ?? feed?.routes.get(b.routeId)?.shape ?? []);
```

- [ ] **Step 6: Verify tsc and the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both clean.

- [ ] **Step 7: Verify on the running map, at the painted pixel**

The dev server runs on port 5173. In the browser console:

```js
const m = globalThis.__map, canvas = m.getCanvas().getBoundingClientRect();
const byId = {}; for (const f of m.getSource("routes").serialize().data.features)
  byId[f.properties.routeId] = f.geometry.coordinates;
[...document.querySelectorAll('button.display')].map(el => {
  const t = [...el.style.transform.matchAll(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/g)].pop();
  const anchor = [+t[1], +t[2]];
  const r = el.lastElementChild.getBoundingClientRect();
  const painted = [r.left + r.width/2 - canvas.left, r.top + r.height/2 - canvas.top];
  const line = (byId[el.dataset.routeId]||[]).map(c => { const p = m.project({lng:c[0],lat:c[1]}); return [p.x,p.y]; });
  let off = Infinity;
  for (let i=1;i<line.length;i++){ const A=line[i-1],B=line[i],dx=B[0]-A[0],dy=B[1]-A[1],L=dx*dx+dy*dy;
    const u=L===0?0:Math.max(0,Math.min(1,((painted[0]-A[0])*dx+(painted[1]-A[1])*dy)/L));
    off=Math.min(off,Math.hypot(painted[0]-(A[0]+dx*u),painted[1]-(A[1]+dy*u))); }
  return { bus: el.textContent.trim(), drift: Math.hypot(painted[0]-anchor[0],painted[1]-anchor[1]).toFixed(1), offLinePx: off.toFixed(2) };
});
```

Expected at z13, z15, z17, z18.5: `drift` 0 for every bus, `offLinePx` under 1.
Take a screenshot and confirm corners look curved, not chamfered.

- [ ] **Step 8: Commit**

```bash
git add src/routing/shape.ts test/shape.test.ts src/ui/TransitMap.tsx
git commit -m "feat: round route line corners, the way a transit map draws them"
```

---

### Task 2: Hide the nearby board

The default sheet view is not useful. Keep the code, stop rendering it.

**Files:**
- Modify: `src/ui/App.tsx:344` (the `<NearbyBoard .../>` render site)

- [ ] **Step 1: Stop rendering it**

In `src/ui/App.tsx`, find the `mode === "nearby"` branch that renders
`<NearbyBoard feed={feed} nearby={nearby} buses={buses} now={planNow} ... />`
and replace the element with `null`, leaving a comment and the import in place:

```tsx
            {/* The nearby board is hidden, not deleted: the user found it
                useless but may want it back. src/ui/NearbyBoard.tsx and its
                tests are untouched, and `nearby` is still computed for the
                planner. Render <NearbyBoard .../> here to restore it. */}
            {null}
```

Leave `import { NearbyBoard } from "./NearbyBoard";` in place but expect
TypeScript's unused-import check or the linter to complain. If `tsc` errors on
the unused import, comment the import out rather than deleting it, with the same
note.

- [ ] **Step 2: Verify the sheet still works with no destination set**

Run: `npx tsc --noEmit && npx vitest run` — both clean.

Open the app with no destination. The sheet must still show the search field,
the service alert banner, and the Leave/Arrive-by controls, and must not be
blank or collapsed to zero height. Searching for a destination must still move
to the results view.

- [ ] **Step 3: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat: hide the nearby board, keeping the component for later"
```

---

### Task 3: One bus's progression in the route view, not the soonest of several

**The bug, read off the screenshot:** the arrival column runs
4, 7, 10, 13, 14, 18, **now**, 5, 10, 12, 14, 18, **now**, 2. Two `now`s and the
count restarts after each — those are the positions of buses 105 and 106 on the
loop. `src/routing/routeDetail.ts:30-32` picks, for each stop independently, the
soonest departure from ANY trip on the route. Every row is individually correct
and the column is nonsense, because the list is in route order while the times
come from two different vehicles.

**Fix:** show a single vehicle's run, so the times increase down the list.

**Files:**
- Modify: `src/routing/routeDetail.ts`
- Test: `test/routeDetail.test.ts`

**Interfaces:**
- Changes: `routeStops(feed, board, routeId, now)` — same signature, but `next`
  now comes from one chosen trip rather than per-stop minima.

- [ ] **Step 1: Write the failing test**

Append to `test/routeDetail.test.ts`. Build a board with two trips on one route,
offset around a loop, and assert the times increase:

```ts
it("reads as one bus going round, not the soonest of several", () => {
  // Two buses on the same loop. Taking the soonest departure at each stop
  // independently gives 2, 4, 1, 3 -- correct per row, nonsense as a column.
  // Measured on the live route view: 4, 7, 10, 13, 14, 18, now, 5, 10, ...
  const stops = new Map([
    ["A", { id: "A", name: "A", lat: 41.82, lng: -71.4 }],
    ["B", { id: "B", name: "B", lat: 41.83, lng: -71.4 }],
    ["C", { id: "C", name: "C", lat: 41.84, lng: -71.4 }],
    ["D", { id: "D", name: "D", lat: 41.85, lng: -71.4 }],
  ]);
  const feed = {
    routes: new Map([["R", { id: "R", name: "R", color: "#111", shape: [] }]]),
    stops,
    trips: new Map([["t1", { id: "t1", routeId: "R", stops: [
      { stopId: "A", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 60 },
      { stopId: "C", seq: 3, time: 120 }, { stopId: "D", seq: 4, time: 180 }] }]]),
    feedEndDate: "20991231",
  } as unknown as StaticFeed;

  const NOW = 1_700_000_000;
  const dep = (stopId: string, tripId: string, mins: number) => ({
    stopId, tripId, routeId: "R", seq: 1, time: NOW + mins * 60, live: true,
  });
  // Bus one is just behind A; bus two is just behind C.
  const board = new Map([
    ["A", [dep("A", "t1", 2), dep("A", "t2", 14)]],
    ["B", [dep("B", "t1", 4), dep("B", "t2", 16)]],
    ["C", [dep("C", "t2", 1), dep("C", "t1", 6)]],
    ["D", [dep("D", "t2", 3), dep("D", "t1", 8)]],
  ]) as unknown as DepartureBoard;

  const got = routeStops(feed, board, "R", NOW);
  const times = got.map((s) => s.next?.time ?? null);
  expect(times.every((t) => t !== null)).toBe(true);
  for (let i = 1; i < times.length; i++)
    expect(times[i]!).toBeGreaterThan(times[i - 1]!);
  // ...and it is one vehicle's run, not a mixture.
  expect(new Set(got.map((s) => s.next!.tripId)).size).toBe(1);
});
```

Ensure the file imports `DepartureBoard` and `StaticFeed` from
`../src/data/types`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/routeDetail.test.ts`
Expected: FAIL — times are not increasing, and more than one `tripId` appears.

- [ ] **Step 3: Implement**

Replace the body of the `for (const ts of longest)` loop's `next` lookup in
`src/routing/routeDetail.ts`. Choose the trip first, then read every stop from
it:

```ts
  const seen = new Set<string>();
  const ordered: { stopId: string; seq: number; stop: Stop }[] = [];
  for (const ts of longest) {
    if (seen.has(ts.stopId)) continue;      // a loop revisits its first stop
    seen.add(ts.stopId);
    const stop = feed.stops.get(ts.stopId);
    if (stop) ordered.push({ stopId: ts.stopId, seq: ts.seq, stop });
  }

  // One vehicle's run, not the soonest arrival at each stop from whichever bus
  // happens to be nearest it. With two buses on a loop the per-stop minimum
  // sawtooths -- the times restart every time the list passes the other bus,
  // which reads as a bug even though every row is correct.
  const upcoming = (stopId: string) =>
    (board.get(stopId) ?? []).filter((d) => d.routeId === routeId && d.time >= now);
  const first = ordered[0];
  const chosen = first
    ? upcoming(first.stopId).sort((a, b) => a.time - b.time)[0]?.tripId ?? null
    : null;

  return ordered.map(({ stop, seq, stopId }) => {
    const here = upcoming(stopId).sort((a, b) => a.time - b.time);
    const next = (chosen ? here.find((d) => d.tripId === chosen) : undefined)
      // A short trip may skip a stop the longest trip serves; fall back rather
      // than leaving a hole in the middle of the line.
      ?? here[0] ?? null;
    return { stop, seq, next };
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/routeDetail.test.ts`
Expected: PASS. Then `npx vitest run` — the existing routeDetail cases must
still pass; if one asserted the old per-stop-minimum behaviour, read it and
decide whether it encoded the bug before changing it.

- [ ] **Step 5: Verify on the running app**

Open the Connector Route detail view while two buses are running. The arrival
column must increase from top to bottom with at most one `now`.

**Answered by the reference screenshots.** Apple keeps the stop list to one
vehicle and surfaces the others as "Upcoming Departures" chips above it. The
existing `Bus 105` / `Bus 106` chips already occupy that spot, so the follow-up
work is to turn them into departure chips (`10 min · On-time`, `52 min ·
Scheduled`) rather than vehicle labels. That is Task 6; this task only makes the
column monotonic.

Apple also shows absolute clock times in this column, not countdowns. The
current view shows `4 min · 4:32 PM`. Leave that alone for now — it carries the
same information — and revisit it in Task 6.

- [ ] **Step 6: Commit**

```bash
git add src/routing/routeDetail.ts test/routeDetail.test.ts
git commit -m "fix: route view follows one bus round, not the soonest at each stop"
```

---

### Task 3b: Breathing room in the sheet on desktop

The sheet's header stack — search field, alert banner, Leave/Arrive-by row,
`NEAR YOU` eyebrow, `Next departures` heading — is cramped at desktop widths.
The controls were sized for a phone, where the sheet is narrow and vertical
space is scarce; on a wide window they read as a wall.

**Files:**
- Modify: `src/ui/Sheet.tsx` and/or `src/ui/App.tsx` (the sheet's header stack)
- Modify: `src/ui/theme.css` if the spacing scale needs a token

- [ ] **Step 1: Look at it at both widths first**

Screenshot the sheet at 390px wide (phone) and at the current desktop width
before changing anything, so the phone layout can be checked against the same
bar afterwards. The phone case is the primary target — this app is for a rider
standing at a stop — so desktop must not win at its expense.

- [ ] **Step 2: Add vertical rhythm at wide widths only**

Use a container query or a `min-width` media query so the phone layout is
untouched. Increase the gap between the header controls and give the
`Next departures` heading room above it. Do not change font sizes; this is a
spacing problem, not a type problem.

- [ ] **Step 3: Verify both widths and commit**

Re-screenshot at 390px and desktop. `npx tsc --noEmit && npx vitest run` clean.
`test/Sheet.test.tsx` must still pass — it covers the detents.

```bash
git commit -m "feat: give the sheet header room to breathe on wide windows"
```

---

### Task 4: Never let two routes overlap, with a minimum gap in pixels

Near-parallel routes currently draw on top of each other when zoomed out.

**Approach, and why it is not the one that failed four times.** Every previous
attempt rewrote route COORDINATES to fan routes into lanes, which required a
metres-per-pixel conversion, had to be rebuilt on every zoom, and assumed the
GTFS shape sits on the street centreline — Brown's do not, the two Evening loops
are already ~7m apart, one per side of the road. Offsetting outward from an
already-offset shape put the lines on the pavement.

This uses MapLibre's `line-offset` paint property, which is **already in
pixels**, applied per feature. No geometry is touched, nothing is recomputed on
zoom, and the gap is pixel-constant at every scale by construction — which is
exactly what was asked for. The cost is that a route running alone is displaced
by a couple of pixels too. At a 4px line width that is imperceptible; at the 8px
used before it was not, which is the actual reason attempt 3 looked wrong.

**Files:**
- Modify: `src/ui/TransitMap.tsx` (`drawRoutes`)

- [ ] **Step 1: Assign each drawn route a lane and offset it**

In `drawRoutes` in `src/ui/TransitMap.tsx`, replace the feature build and the
two `addLayer` calls:

```ts
  /** Centre-to-centre gap between routes sharing a street, in screen pixels.
   *  Must exceed the line width or the two strokes touch. */
  const ROUTE_GAP_PX = 6;

  function drawRoutes(m: maplibregl.Map, routes: { id: string; color: string; shape: LatLng[] }[]) {
    // One lane per route, centred on zero, in sorted id order so the map never
    // reshuffles between renders. Lanes are PIXELS via line-offset: no
    // geometry is rewritten and nothing here depends on zoom.
    const ordered = [...routes].sort((a, b) => a.id.localeCompare(b.id));
    const mid = (ordered.length - 1) / 2;

    const data: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: ordered.map((r, i) => ({
        type: "Feature",
        properties: { routeId: r.id, color: r.color, lane: i - mid },
        geometry: { type: "LineString", coordinates: r.shape.map((q) => [q.lng, q.lat]) },
      })),
    };

    const src = m.getSource("routes") as maplibregl.GeoJSONSource | undefined;
    if (src) { src.setData(data); return; }
    m.addSource("routes", { type: "geojson", data });
    const offset: maplibregl.ExpressionSpecification = ["*", ["get", "lane"], ROUTE_GAP_PX];
    m.addLayer({
      id: "routes-case", type: "line", source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": darkRef.current ? "#15110F" : "#FFFFFF",
        "line-width": 7.5, "line-opacity": 0.9, "line-offset": offset,
      },
    });
    m.addLayer({
      id: "routes-line", type: "line", source: "routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": 4, "line-offset": offset },
    });
  }
```

- [ ] **Step 2: Measure the actual displacement before believing it**

Run: `npx tsc --noEmit && npx vitest run` (both clean), then in the browser:

```js
const m = globalThis.__map;
const f = m.getSource("routes").serialize().data.features;
({ routes: f.length,
   lanes: f.map(x => `${x.properties.routeId}:${x.properties.lane}`),
   maxDisplacementPx: Math.max(...f.map(x => Math.abs(x.properties.lane))) * 6 });
```

Expected: 4 routes, lanes `-1.5 -0.5 0.5 1.5`, max displacement 9px.

**Gate:** 9px is more than attempt 3 used and that attempt was rejected as
looking wrong. If a screenshot at z15 and z17 shows routes visibly beside their
streets, drop `ROUTE_GAP_PX` to 4 (max 6px) and re-screenshot. Do not proceed
past this step on the numbers alone — look at it.

- [ ] **Step 3: Confirm no two lines overlap when zoomed out**

Screenshot at z13 and z14, where the Evening CW and CCW loops are under a pixel
apart in ground distance. Both must be visible as separate lines.

- [ ] **Step 4: Re-check the buses at the painted pixel**

Buses snap to the shape, which `line-offset` moves the LINE away from by up to
`ROUTE_GAP_PX * maxLane` pixels. Re-run the Task 1 Step 7 snippet. `drift` must
still be 0. `offLinePx` will now be up to the max displacement and constant
across zooms — confirm it is constant, since a value that grows with zoom means
something metre-based has crept back in.

If the residual reads badly on screen, the fix is to lower `ROUTE_GAP_PX`, not
to reintroduce coordinate rewriting.

- [ ] **Step 5: Commit**

```bash
git add src/ui/TransitMap.tsx
git commit -m "feat: hold a constant pixel gap between routes sharing a street"
```

---

### Task 5: Stops styled like a subway map

Current stop circles use a 1.5px stroke against a 4px line, and carry no route
colour. NYC and London both solve the multi-line case the same way: a stop on
one line is drawn in that line's colour; an interchange is drawn as a larger
neutral circle, because it belongs to no single colour.

**Files:**
- Modify: `src/routing/routeDetail.ts` (add `stopRoutes`)
- Test: `test/routeDetail.test.ts`
- Modify: `src/ui/TransitMap.tsx` (stops source + `stops` layer paint)

**Interfaces:**
- Produces: `stopRoutes(feed: StaticFeed): Map<string, string[]>`
  — stop id to the sorted, de-duplicated route ids calling there.

- [ ] **Step 1: Write the failing test**

Append to `test/routeDetail.test.ts`:

```ts
describe("stopRoutes", () => {
  it("lists every route calling at a stop, de-duplicated and sorted", () => {
    const feed = {
      routes: new Map(),
      stops: new Map(),
      trips: new Map([
        ["t1", { id: "t1", routeId: "R2", stops: [
          { stopId: "A", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 60 }] }],
        ["t2", { id: "t2", routeId: "R1", stops: [
          { stopId: "B", seq: 1, time: 0 }, { stopId: "C", seq: 2, time: 60 }] }],
        // A second trip on a route already seen must not duplicate it, and a
        // loop calling twice at one stop must not either.
        ["t3", { id: "t3", routeId: "R1", stops: [
          { stopId: "B", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 60 }] }],
      ]),
      feedEndDate: "20991231",
    } as unknown as StaticFeed;

    const got = stopRoutes(feed);
    expect(got.get("A")).toEqual(["R2"]);
    expect(got.get("B")).toEqual(["R1", "R2"]);   // the interchange
    expect(got.get("C")).toEqual(["R1"]);
    expect(got.get("nope")).toBeUndefined();
  });
});
```

Add to that file's imports:

```ts
import { routeStops, stopRoutes } from "../src/routing/routeDetail";
import type { StaticFeed } from "../src/data/types";
```

(keep whatever it already imports; add only what is missing)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/routeDetail.test.ts`
Expected: FAIL with `stopRoutes is not a function`

- [ ] **Step 3: Implement**

Add to `src/routing/routeDetail.ts`:

```ts
/** Which routes call at each stop.
 *
 *  Subway maps colour a stop by its line and draw interchanges neutrally, so
 *  the map needs to know which stops serve more than one route. Built from
 *  trips because GTFS has no stop-to-route table. */
export function stopRoutes(feed: StaticFeed): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  for (const trip of feed.trips.values())
    for (const ts of trip.stops) {
      const set = sets.get(ts.stopId) ?? new Set<string>();
      set.add(trip.routeId);
      sets.set(ts.stopId, set);
    }
  return new Map([...sets].map(([id, set]) => [id, [...set].sort()]));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/routeDetail.test.ts`
Expected: PASS

- [ ] **Step 5: Colour the stops**

In `src/ui/TransitMap.tsx`, import it:

```ts
import { stopRoutes } from "../routing/routeDetail";
```

In the route-drawing effect, where the `stops` source is created, give each stop
its colour and its interchange flag. Replace the `m.addSource("stops", ...)`
call and the `stops` layer:

```ts
      if (!m.getSource("stops")) {
        const serving = stopRoutes(feed);
        m.addSource("stops", { type: "geojson", data: { type: "FeatureCollection",
          features: [...feed.stops.values()].map((s) => {
            const ids = (serving.get(s.id) ?? []).filter((id) => activeRouteIds.has(id));
            return {
              type: "Feature" as const,
              properties: {
                name: s.name, id: s.id,
                // An interchange belongs to no single line, so it takes the
                // neutral ink the way an NYC transfer station does. A stop on
                // one route wears that route's colour.
                interchange: ids.length > 1,
                color: ids.length === 1
                  ? (feed.routes.get(ids[0]!)?.color ?? "#6F625A")
                  : (darkRef.current ? "#C6BAB1" : "#241C17"),
              },
              geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
            };
          }) } });
```

Then replace the `stops` layer paint (leave `stops-active` and `stops-hit` as
they are):

```ts
        m.addLayer({ id: "stops", type: "circle", source: "stops", minzoom: 13,
          paint: {
            // Interchanges read one step larger, as they do on the Underground
            // map, so a transfer point is findable without reading labels.
            "circle-radius": ["interpolate", ["linear"], ["zoom"],
              13, ["case", ["get", "interchange"], 3.5, 2.5],
              16, ["case", ["get", "interchange"], 7, 5]],
            "circle-color": darkRef.current ? "#15110F" : "#FFFFFF",
            "circle-stroke-color": ["get", "color"],
            // Matches the route line's own width at street zoom, so a stop
            // looks like a bead on the line rather than a separate dot.
            "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 13, 2, 16, 4],
          } });
```

- [ ] **Step 6: Re-tint on theme change**

The theme effect already re-tints `stops`. Update it so the fill still follows
the ground colour — find the block setting `circle-color` on `stops` and leave
it; DELETE the line that sets `circle-stroke-color` on `stops`, since the stroke
is now per-feature and overwriting it would erase the colour coding:

```ts
      if (m.getLayer("stops")) {
        m.setPaintProperty("stops", "circle-color", ground);
      }
```

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npx vitest run` — both clean.

Screenshot at z15 and z17. Confirm: stop rings are the colour of their route;
stops served by more than one active route are larger and neutral; ring
thickness visually matches the line width.

- [ ] **Step 8: Commit**

```bash
git add src/routing/routeDetail.ts test/routeDetail.test.ts src/ui/TransitMap.tsx
git commit -m "feat: colour stops by their route, interchanges neutral and larger"
```

---

### Task 6: Route view like Apple's — departure chips, vehicle position, badges

Deferred deliberately: Tasks 1-5 are the fixes the user asked for. This is the
larger rework the reference screenshots imply, and it should be planned properly
once those have landed and been looked at. Recorded here so it is not lost.

Scope, in impact order:

1. **Upcoming Departures chips.** Replace the `Bus 105` / `Bus 106` vehicle
   labels with a horizontal row of the next few departures from the first stop:
   `10 min · On-time` (live, red with a radiating glyph), `52 min · Scheduled`
   (grey), `6:05 PM · Scheduled`. Right-align the headway, `Every N min`,
   computed from the gaps between scheduled departures. This is what makes a
   second bus visible without corrupting the stop list.
2. **Vehicle position in the list.** Draw a bus glyph in a ringed circle at the
   stop the chosen vehicle is currently at, with the stops behind it dimmed.
   `snapToShape` already gives the position on the line; map it to the nearest
   stop.
3. **Connecting-route badges.** Under each stop name, a badge per other route
   calling there — small rounded square, route colour, route short name.
   `stopRoutes()` from Task 5 already supplies the ids.
4. **Collapse distant stops** to `N previous stops` / `N additional stops` with
   a `More` control, bolding only the relevant span.
5. **Absolute clock times** in the column rather than `N min · H:MM`.

## Self-review

**Spec coverage.** (1) corner rounding — Task 1. (1a) hide the nearby board,
keeping the code — Task 2. (1b) route-view arrival times out of order — Task 3.
(2) never overlap, minimum gap clamped in pixels — Task 4. (3) stop ring
thickness matching line width, colour coding, NYC/London handling of multi-line
stops — Task 5. All five covered, in the priority order given.

**Task order matters.** Task 1 must land before Task 4: Task 1 introduces
`drawnRef`, which Task 4's `drawRoutes` signature relies on being populated with
rounded shapes. Tasks 2, 3 and 5 are independent of the others and of each
other.

**Not addressed, deliberately.** The user noted the routes do not sit on their
roads and attributed it to Passio's coordinates. That is correct and nothing
here changes it — the shapes are what Passio publishes. Fixing it would mean
map-matching every shape onto the basemap's street centrelines, which is a much
larger piece of work and is not requested.

**Type consistency.** `roundCorners(LatLng[], number?) => LatLng[]` and
`stopRoutes(StaticFeed) => Map<string, string[]>` are used with those exact
signatures at every call site above. `drawnRef` is declared in Task 1 and read
in Task 1 only. `ROUTE_GAP_PX` is declared and used only inside Task 2.

**Risk.** Task 2 is the one with history. Its Step 2 is an explicit look-at-it
gate rather than a numeric pass, because the numbers looked fine on all four
previous attempts too.
