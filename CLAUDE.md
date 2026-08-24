# busbus

Brown University shuttle app.

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
job it is honest at: which stops a route serves, in what order, from
`feed.trips` -- which never touches the board.

If you want to tell a rider when service actually runs, the only honest route
is observation: record when vehicles really report, then state that history.

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
see README.md for why. The private JSON is for exactly three things: which
routes are active (`outdated` flag), exact passenger counts, and the websocket.

Route id join key is `myid` / GTFS `route_id`. The private `id` field is not
unique — do not join on it.

No API keys anywhere. Nothing to keep out of git.

## Working style

- **Reuse before writing.** Check `busbus.py` for an existing helper first.
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
