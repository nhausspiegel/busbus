# Backlog

Triaged, with the root cause where it is known rather than the symptom. Written
so it survives a compaction: anything here can be picked up cold.

The point of the grouping below is that most of these are not separate bugs.
Four architectural changes cover eight reported problems.

---

## A. Everything on a route rides the DRAWN geometry

**Covers:** stops not sitting on the route lines; the whole recurring class of
"the buses are off their routes".

`src/render/bundle.ts` moves route coordinates on purpose — routes sharing a
street are fanned apart. The route line is drawn from that output, and buses are
snapped to it. **Stops are not**: they are still drawn at their raw GTFS
coordinates, so wherever a route has been fanned, its stops are left behind by
up to half the lane gap. The itinerary overlay has the same exposure.

This is the third time this exact mistake has cost a day: drawing one geometry
while placing something else from another. The fix is not another patch, it is
a rule with one implementation:

> Anything positioned along a route — the line, its stops, the vehicles on it,
> the highlighted itinerary — is placed by projecting onto `drawnRef`, the
> geometry that was actually drawn at the current zoom. Nothing reads
> `route.shape` directly for display.

Make it hard to get wrong: have `drawRoutes` return/publish the drawn paths and
have a single `placeOnRoute(routeId, latLng)` helper that every caller uses.

## B. Stations, not stop rows

**Covers:** stops that are not colour-coded; multi-route stops not reading as
interchanges; some of the visual clutter.

Passio models one physical stop as several stop_ids, one per direction or per
route. Measured on the real feed: **20 pairs of stop_ids sit within 25m of each
other**, e.g. `8399 "Barbour Hall/Public Safety CCW"` and `8386 "...CW"` 11m
apart, and `7869/7867 "225 Dyer (to College Hill)" / "(to South Street
Landing)"` 17m apart.

Consequences today:

- Interchange detection joins on stop_id, so those pairs look like two separate
  single-route stops. Only 5 of 33 drawn stops register as interchanges.
- Each half gets one route's colour, so a place served by two routes shows as
  two small dots of different colours rather than one neutral interchange.
- `Athletic Center` (8380) genuinely IS served by three routes — 62487, 3470,
  3469 — and that case does work. It is the split pairs that do not.

Fix: cluster stops by location (~25m) into a display "station", union the routes
serving the members, and draw one marker per station. Colour by the single
serving route, or neutral and larger for an interchange. Keep the underlying
stop_ids for departures — this is a display concern only, and the halves are
genuinely different boarding points.

Also worth knowing: **`Daytime Express` (3302) has 1 trip and 2 stops** in GTFS
despite a 177-point shape. Its line is drawn with almost no stops on it. That is
upstream data, not a rendering bug, but it explains "some routes have no
coloured stops".

## C. One selection model

**Covers:** no visual indication when a stop is selected; selecting a route
should fade the others.

There is already a `highlightRouteId` prop that dims other routes, but nothing
equivalent for stops, and the two are not expressed as one idea. Replace both
with a single `selection: { kind: "route" | "stop"; id: string } | null`, and
compute emphasis for every layer — route lines, stops, bus markers — in one
place from it.

Behaviour to match Apple Maps: the selected thing goes to full strength and
grows slightly; everything else drops to a low opacity; tapping the map clears
it (already implemented via `onDeselect`).

## D. Never draw a fake path as if it were real

**Covers:** walking directions rendering as a straight line, sometimes
permanently.

`src/ui/App.tsx` draws straight lines between the endpoints immediately, then
replaces them when Valhalla answers. Two faults:

1. The placeholder is drawn in the same style as the real path, so a rider
   cannot tell a guess from a route.
2. If the Valhalla call fails — and it will, it is a volunteer instance and a
   throttled response arrives as a CORS error — the `catch` swallows it and the
   straight line stays forever.

Fix: draw the provisional line in a visibly provisional style, retry once on
failure, and if it still fails say so rather than leaving a fabricated path on
screen. This is the same principle as the hollow-vs-solid departure times: never
present a guess with the confidence of a measurement.

## E. Active routes from data, not a constant

**Covers:** a route running right now that does not appear at all.

`ACTIVE` in `src/ui/App.tsx` is a hardcoded set of five route ids. Anything
Passio starts running that is not in that list is invisible — no line, no buses,
and since stops with no active route are now filtered out, no stops either.

Checked so far:

- The shipped GTFS is **not** stale (feedEndDate 20260917 vs live 20260922,
  identical routes and trip counts), so this is not a refresh problem.
- Of the ten routes in the feed, only four have any trips at all: 62487 (38),
  3469 (86), 3470 (62), 3302 (1). `22427 Brown Stadium Loop` is in `ACTIVE` but
  has no trips and no shape, so it can never draw.

**Unverified:** whether the route the user saw is one that reports live vehicles
without appearing in the static feed. There were 0 live vehicles when this was
investigated — outside Brown's service hours — so it could not be checked. Do
this during service hours: list `routeId` from GTFS-RT vehiclePositions and
compare against the static route ids. If RT carries routes the static feed does
not, the fix is to derive the drawn set from trips-today ∪ routes-with-vehicles,
and to accept that such a route has no shape to draw.

---

## Smaller, not yet grouped

- **Route rendering polish.** The bundler is much better but not perfect.
  Corner radius is still an unpicked knob (`CORNER_RADIUS_PX`, currently 10;
  `npx tsx scripts/bundle-knobs.ts` renders 0/8/16/28 to choose from).
- **Apple-style route detail view.** Departure chips instead of vehicle labels,
  the bus's position inline in the stop list, connecting-route badges under stop
  names, distant stops collapsed to "23 previous stops", absolute clock times.
  Written up in the plan file as Task 6.
- **Map-matching route shapes to street centrelines.** Would fix "the routes
  aren't quite on their roads", which is upstream shape data. Needs Valhalla
  map-matching run offline at build time and committed. Risks matching to the
  wrong parallel street. Deferred deliberately.
