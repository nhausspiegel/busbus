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

Valhalla and Nominatim are volunteer-run. One request per user action, never
per keystroke; a throttled response has no CORS headers and shows up in the
browser as a confusing CORS error rather than a rate limit.

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
