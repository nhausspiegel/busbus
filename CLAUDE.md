# busbus

Brown University shuttle app.

## 0. FIRST: when you get it wrong, write it down here

*This is the highest-priority instruction in this file. It comes before the
non-negotiables, because it is how they got written.*

**Whenever a decision turns out to be incorrect or misaligned with what the
owner actually wanted, add a note to THIS file saying what not to do next
time.** Not to the backlog, not to a commit message that scrolls away -- here,
because this file is what the next session reads before touching anything.

Write the rule, not the story: what the wrong instinct was, and what to do
instead. One or two sentences. The bullets under Working style below were
all earned this way, and each one exists because it was done wrong first.

The standing examples so far, kept short on purpose:

- Reaching for a remote API for data the project already has (see Working
  style). ~60 rate-limited requests for a road network that is one query.
- Inventing a metric instead of measuring the thing complained about. Three
  proxies for the map "squiggle" each moved the wrong way, and one counted a
  successful fix as the defect. Same trap, second victim: the sign of a lane's
  `line-offset` must flip where the canonical frame opposes travel, so counting
  those flips measures the correction, not the defect.
- Treating what a defect looks like instead of what causes it. Route corners
  grew nubs under round line caps; switching to butt caps replaced them with
  notches. Both are the same defect -- a boundary between two features, which
  MapLibre cannot join -- and the cap only chose which artefact appeared. When
  a fix changes the shape of a symptom without reducing it, the cause is
  somewhere else.
- Filing a dead end when the measurement answered a different question.
  Street-matching was recorded as "does not pay" because the matched line sat
  within 7.4m of the traced one -- true, and beside the point: matching exists
  to give segments a shared IDENTITY, not to move them. It is now the
  architecture that ships. Before recording a dead end, check that the question
  measured was the one that mattered.
- Shipping a run of "fixes" each measured against something other than the
  complaint. Five rendering changes in one day each improved the number they
  aimed at -- side-jumps, stub length, nubs -- and the owner said the map looked
  worse after every one. All five were reverted to `renderer-checkpoint`. The
  number that tracked how it LOOKED was the count of visible feature boundaries,
  and not one of the five was measured against it. Find the number that moves
  with the complaint before changing anything.
- Judging a half-wired rewrite by how it looks. The one-feature-per-route
  rendering was abandoned as "looks awful" while its stop and bus snapping were
  still unported and two tests were red. That is not evidence about the design.
  Finish wiring, or do not look.
- Leaving docs pointing at deleted files. `HANDOFF.md` sent the next session to
  `src/render/bundle.ts` and `test/squiggle.test.ts` for weeks after both were
  gone. Deleting a file means re-truing every doc that names it, in the same
  commit.
- Shipping rendering the owner had no chance to intercept. The dev server is
  hot-reloaded, so every edit is instantly on their screen; committing a
  rendering rewrite while they were away meant they returned to a broken map
  three hours old. Rendering experiments belong on a branch or a worktree, and
  never land while they are gone.
- Treating "no defect I can measure" as "it looks right". Three rendering
  attempts in one day measured clean -- boundary count, fold count, gap in
  pixels -- and all three were called awful on sight. Those numbers only detect
  defects already hypothesised. They cannot answer whether it LOOKS correct,
  and no number found so far can.
- Letting an unrelated fix ride along with a rendering change. The z-order fix
  and the hospital-loop fix had nothing to do with lane geometry, shared a
  working tree with it, and were reverted twice as collateral. One fix, one
  commit, verifiable alone.
- Reporting what a screenshot shows. I have twice stated the opposite of what
  was on screen, including which side of a road a line sat on. Screenshots
  spot that something is wrong; they never decide what is right.
- Explaining a report away. "It may just not be visible at that zoom" is not an
  answer to "it doesn't work". The owner is the only one who can see the
  window, so their observation is the starting point, not a claim to triage.

---

## What exists

- **Routing engine: done.** `src/routing/plan.ts` ranks by earliest arrival and
  offers walking as an option. Pure functions, no network, fully fixture-tested.
  `npx tsx scripts/plan-demo.ts` (defaults to 129 Angell St <-> Trader Joe's,
  both directions).
- **UI: done.** `src/ui/App.tsx`. Deployed to GitHub Pages on push to main.
  Debug view at `?debug=1`.
- `busbus.py` is the live-verification tool, not app code. Don't import it.

## Non-negotiable

**Never show a timetable time at all.** Not hollow, not dashed, not labelled --
not shown. Superseded the earlier "render it as a weaker claim" rule on
2026-08-23 by the project owner's decision, after measuring at 22:22 that
night:

- `calendar.txt` is ONE row: service 3302, all seven days, 20250101-20271231.
  There is no `calendar_dates.txt` in the feed at all, so the data has no field
  in which "not running today" could ever be written.
- GTFS-RT returned 0 vehicles AND 0 predictions.
- Passio's own private endpoint returned an empty bus list, so their app cannot
  show a time either. We are not missing a source they have.
- The app was nonetheless offering "10:06 PM" for four routes.

A scheduled time is therefore not a weaker claim than a live one, it is an
unfounded one, and styling cannot fix that. The board is built from live
departures only (`buildBoard(live, [])` in App). The timetable keeps the one
job it is honest at: which stops a route serves, in what order -- from
`feed.trips`, and from `feed.routeStops` where the export drops them -- which
never touches the board.

Telling a rider when service actually runs is done the only honest way there
is: observation. `scripts/record-service.ts` samples the vehicle feed every 15
minutes from CI and commits what it saw to `public/service-history.json`; the
route page and the stop card state that record and nothing beyond it. Counted
in DAYS rather than samples, nothing claimed under three days observed, and
always past tense -- it says what happened, never what will.

The same recording gives the one thing GTFS cannot: how long a leg actually
takes (`src/data/legTimes.ts`). Realtime publishes an absolute time per stop,
so the gap between two of them on one trip is a measured duration, which is
what lets a route be ridden past the stops its GTFS trip omits. Five samples
minimum, median not mean. **Never** derive a duration from distance and an
assumed speed -- that is the unfounded claim in a different coat.

Routing and geocoding both run on volunteer infrastructure, and it goes down.
Measured 2026-08-23/24:

- `valhalla1.openstreetmap.de` returned HTTP 000 -- accepted the connection,
  never replied -- for 20s on every attempt, and directions died with it.
  There are now TWO routers: FOSSGIS OSRM `routed-foot` first, Valhalla second.
  Never let this app depend on one host for its whole purpose again.
- A throttled response has no CORS headers, so it reaches the browser as
  `TypeError: Failed to fetch` rather than a 429. It looks like an outage and
  is not one.
- Requests are cached, de-duplicated, deadlined at 8s and backed off in
  `src/routing/walk.ts`. Retrying into a throttle is what keeps you throttled.

Geocoding is Photon, not Nominatim: Nominatim matches whole words, so "trad"
found nothing while "trader" found Trader Joe's, and the app wrongly told the
rider the place did not exist. Debounced AND floored at one request per 1.2s --
a trailing debounce alone still fires per keystroke for a slow typist.

## Data source

Passio GO. Use the **GTFS feeds**, not the private `mapGetData.php` endpoints —
see README.md for why. The private JSON is for exactly four things: exact
passenger counts, the websocket, which routes are running, and **the geometry
and stop lists the GTFS export drops**.

That last one is not a loosening of the rule, it is the rule applied where GTFS
is silent. Measured 2026-08-29: `routes.txt` carries 22427 Brown Stadium Loop
with **no trips and no shape**, and 3302 Daytime Express with **one trip
covering two of its nine stops**. `src/data/routePaths.ts` fills shape, stop
order and the active-route list, and **never overwrites what the GTFS does
carry**. The same payload's point counts match `shapes.txt` exactly for every
route that has both (3302:177, 3469:24, 3470:31), so it is the same geometry
rather than a second opinion about it.

Which routes are running comes from `routes` minus `excludedRoutesID` in
`getStops=2`, **not** the `outdated` flag — that flag lies about seasonal
suspension. Measured, the exclusion list reproduces exactly the five route ids
that used to be hardcoded.

Route id join key is `myid` / GTFS `route_id`. The private `id` field is not
unique — do not join on it.

Anything in front of `fetchStaticFeed` gets a deadline. That private call now
sits ahead of the whole map, and this project has already watched an
undocumented host accept a connection and never reply.

No API keys anywhere. Nothing to keep out of git.

## Working style

- **Reuse before writing.** Check `busbus.py` for an existing helper first.
- **Route rendering has its own doc.** `docs/RENDERING.md` -- read it before
  touching `src/render/lanes.ts`, `scripts/snap-to-streets.ts`, or the map's
  pixel constants. It ends with the traps, two of which have caught someone
  twice.
- **Data you already have beats an API you have to call.** Before querying a
  service, say what is already committed, vendored, parsed, or downloaded by
  the app. Street geometry is the standing example: this app ships a street
  basemap, and the campus road network is ONE Overpass query -- snapping routes
  to streets was first built as ~60 rate-limited OSRM requests taking minutes.
  And prefer one bulk request to N per-item ones; N is slower AND ruder, and
  this project has already been throttled into looking broken.
- **Stdlib before dependencies.** New packages need a reason stated out loud.
- **Minimum that works.** No abstractions for one caller, no config for a
  constant, no scaffolding for a feature that isn't requested.
- **Fail loud, don't guess.** If a test or build breaks, report the error and
  stop. Do not retry variations hoping one sticks.
- **Non-trivial logic leaves one runnable check.** TypeScript: add a vitest
  case in `test/`. Python: extend `selftest()` in `busbus.py`.
- **Tests never hit the network.** Use the frozen fixtures in `test/fixtures/`.

## Verify, don't assert

This project is built on undocumented endpoints. Claims about what an API
returns must come from a live response pasted into the conversation, not from
memory. `./.venv/bin/python busbus.py` is the check — run it before saying
something works.

## Environment

macOS ships `python3`, not `python`. Dependencies live in `.venv`:

```bash
./.venv/bin/python busbus.py
```
