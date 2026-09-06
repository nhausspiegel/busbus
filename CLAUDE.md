# busbus

Brown University shuttle app.

## 0. FIRST: when you get it wrong, write it down

*Comes before the non-negotiables: it is how they got written.* **When a decision
turns out wrong or misaligned with what the owner wanted, record the instance in
`docs/LESSONS.md` under its pattern; a NEW root pattern goes HERE.** Rule, not story.

**Two rules generalise the rest. They come first.**

- **A cheap proxy stood in for the expensive real thing, and then got trusted.**
  Measuring instead of reading the code. A sample instead of the population. One
  zoom instead of the range. My metric instead of the complaint. A green suite
  instead of a test that can fail. Cheapest exactly when being wrong costs most:
  name the proxy out loud -- what the real thing is, why this stands in for it.
- **"Do not stop" means do not stop WORKING, not always produce a change.** Six
  rendering attempts shipped in one day, each before the last was understood, every
  one reverted. "I do not know yet, and here is what I would need to find out" is a
  complete report. A diff is not evidence of progress.
- **Treat the cause, not the shape of the symptom.** Corner nubs under round caps
  became notches under butt caps: one defect (MapLibre cannot join a boundary between
  features), two artefacts. A shape that changes without shrinking = wrong target.
- **The owner is ground truth.** "It may just not be visible at that zoom" is not
  an answer to "it doesn't work". When they are at the keyboard, ask.
- **One fix, one commit, verifiable alone.** Deleting a file means re-truing every
  doc that names it, in the same commit.
- **Data in the repo beats an API you call.** One bulk request beats N.

All 26 instances, and the measurements behind the non-negotiables, are verbatim in
**`docs/LESSONS.md`**.

## What exists

- **Routing engine: done.** `src/routing/plan.ts` ranks by earliest arrival and
  offers walking. Pure, no network, fixture-tested. `npx tsx scripts/plan-demo.ts`
  defaults to Address J <-> Trader Joe's, both directions.
- **UI: done.** `src/ui/App.tsx`, GitHub Pages on push to main; debug view `?debug=1`.
- `busbus.py` is the live-verification tool, not app code. Don't import it.

## Non-negotiable

- **Never show a timetable time at all.** Not hollow, not dashed, not labelled --
  not shown. A scheduled time is not a weaker claim than a live one, it is an
  unfounded one. The board is live departures only (`buildBoard(live, [])` in App).
  The timetable keeps its one honest job, **which stops a route serves in what
  order** (`feed.trips` + `feed.routeStops` where dropped), never touching the board.
- **When service runs comes from observation, never the feed.** CI runs
  `scripts/record-service.ts` every 15 min into `public/service-history.json`.
  Counted in DAYS not samples, nothing under three days observed, always past tense.
- **Leg durations: five samples minimum, median not mean** (`src/data/legTimes.ts`).
  **Never** derive a duration from distance and an assumed speed -- that is the
  unfounded claim in a different coat.
- **Two pedestrian routers, never one host.** FOSSGIS OSRM `routed-foot` first,
  Valhalla second. Cached, de-duplicated, deadlined at 8s and backed off in
  `src/routing/walk.ts`; retrying into a throttle is what keeps you throttled.
- **Geocoding is Photon, not Nominatim** (Nominatim matches whole words).
  Debounced AND floored at one request per 1.2s -- a trailing debounce alone still
  fires per keystroke for a slow typist.

## Data source

Passio GO. Use the **GTFS feeds**, not the private `mapGetData.php` endpoints —
README says why. The private JSON is for exactly four things: exact passenger counts,
the websocket, which routes are running, and **the geometry and stop lists the GTFS
export drops** -- the rule applied where GTFS is silent, not a loosening of it.
`src/data/routePaths.ts` fills shape, stop order and the active-route list, and
**never overwrites what the GTFS does carry**. Which routes are running is `routes`
minus `excludedRoutesID` in `getStops=2`, **not** the `outdated` flag, which lies
about seasonal suspension. Join key is `myid` / GTFS `route_id` (the private `id` is
not unique). Anything before `fetchStaticFeed` gets a deadline. No API keys anywhere.

## Working style

- **Reuse before writing.** Check `busbus.py` for an existing helper first.
- **Route rendering has its own doc.** Read `docs/RENDERING.md` before touching
  `src/render/lanes.ts`, `scripts/snap-to-streets.ts` or the map's pixel constants.
- **Data you already have beats an API you call.** Before querying, say what is
  already committed, vendored, parsed or downloaded -- the campus road network is ONE
  Overpass query. One bulk request over N: N is slower AND ruder, and has already
  throttled this project into looking broken.
- **Stdlib before dependencies.** New packages need a reason stated out loud.
- **Minimum that works.** No abstractions for one caller, no config for a constant,
  no scaffolding for a feature that isn't requested.
- **Fail loud, don't guess.** If a test or build breaks, report the error and stop.
  Do not retry variations hoping one sticks.
- **Non-trivial logic leaves one runnable check.** TypeScript: a vitest case in
  `test/`. Python: extend `selftest()` in `busbus.py`.
- **Tests never hit the network.** Use the frozen fixtures in `test/fixtures/`.

## Verify, don't assert

Built on undocumented endpoints: claims about what an API returns must come from a
live response pasted into the conversation, never from memory. Run the check before
saying something works — macOS ships `python3`, not `python`, and deps are in `.venv`:

```bash
./.venv/bin/python busbus.py
```
