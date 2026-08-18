# busbus

Brown University shuttle app.

- **Routing engine: done.** `src/routing/plan.ts` ranks itineraries by earliest
  arrival. Pure function, 44 tests, no network. `npx tsx scripts/plan-demo.ts`.
- **UI: not built.** Objective 3 (Apple-Maps-style transit view) is next and
  needs `superpowers:brainstorming` first.
- `busbus.py` is the live-verification tool, not app code. Don't import it.

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
