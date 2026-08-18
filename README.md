# busbus

Brown University shuttle data — routes, stops, schedule, live vehicle positions —
from Passio GO.

> ### ▶︎ Checking that the Passio feeds still work
>
> **`busbus.py` is the live-verification tool for this project.** It is not part
> of the app — it is the thing you run when the app looks wrong and you need to
> know whether Passio broke or we did. Keep it. It stays at the repo root
> precisely so it is easy to find.
>
> ```bash
> ./.venv/bin/python busbus.py
> ```
>
> Healthy output looks like this — real numbers, fetched live, not canned:
>
> ```
> ok: 10 routes (5 active), 70 stops, 2229 stop_times, 3 vehicles live,
>     3 ws frames, feed valid through 20260917
> ```
>
> Every number there is an assertion that passed. If it prints, the GTFS static
> feed parsed, the schedule is intact, live vehicles decoded, and the websocket
> streamed real frames. If it raises instead, the traceback names the specific
> claim that stopped being true.
>
> To watch buses move in your terminal:
>
> ```bash
> ./.venv/bin/python busbus.py stream
> ```
>
> **First-time setup** (already done on this machine):
>
> ```bash
> python3 -m venv .venv
> ./.venv/bin/pip install -r requirements.txt
> ```
>
> macOS ships `python3`, not `python` — plain `python` gives
> `command not found`. And `./.venv/bin/python` is not interchangeable with
> `python3`: the GTFS-RT decoder lives in the venv, and without it `busbus.py`
> dies on `vehicles()` with `ModuleNotFoundError: No module named 'google'`.
>
> Two live things it will not warn you about: `feed_end_date` eventually passes
> (refetch is automatic, but stale schedules show up here first), and vehicle
> count is legitimately `0` overnight when no shuttles run.

```python
import busbus

s = busbus.load_static()                    # cached on disk, revalidated with ETag
s.routes["3302"].name                       # 'Daytime Express'
s.routes["3302"].shape                      # [(lat, lon), ...] drawable polyline
s.stops_on("3302")                          # ordered [Stop, ...]
s.schedule("8382", route_id="3469")         # ['17:00:00', '17:11:00', ...]

busbus.vehicles()                           # live positions (poll every 5–10s)
busbus.predictions("7865")                  # real-time arrivals at a stop
busbus.alerts()                             # detours / stop closures
busbus.active_route_ids()                   # {'3302','3469','3470','22427','62487'}

async for f in busbus.stream(): ...          # push updates, ~1 per bus per 2–6s
```

No API key. No account. Nothing to keep out of git.

---

## Recommendation: use GTFS, not the private JSON

Passio publishes a **standard GTFS static feed and a full GTFS-Realtime feed**
for Brown. Neither is linked from brownshuttle.com or referenced anywhere in the
web app's JavaScript, but both are public, unauthenticated, and correct:

| Feed | URL |
|---|---|
| GTFS static | `https://passio3.com/brown/passioTransit/gtfs/google_transit.zip` |
| GTFS-RT VehiclePositions | `https://passio3.com/brown/passioTransit/gtfs/realtime/vehiclePositions` |
| GTFS-RT TripUpdates | `https://passio3.com/brown/passioTransit/gtfs/realtime/tripUpdates` |
| GTFS-RT ServiceAlerts | `https://passio3.com/brown/passioTransit/gtfs/realtime/serviceAlerts` |

The `brown` path segment is the system's `username` field, served by
`getSystems` alongside `id: 1067`.

Use these because:

- **Standard schemas.** `gtfs-realtime-bindings` parses the RT feeds; any GTFS
  library reads the static one. The private JSON is bespoke and undocumented.
- **Stable.** The private endpoints are versioned by an opaque `appVersion` in the
  query string (`getBuses=2`, `getRoutes=1`, `schedule=4`) that Passio bumps at
  will. GTFS-RT is a fixed spec.
- **More complete.** GTFS static ships route polylines, the full timetable, and
  trip/shape structure in one 21 KB zip. Getting the same from the private API
  takes one `getStops=2` call plus one `schedule=4` call *per route per stop*.
- **Better predictions.** TripUpdates gives every upcoming arrival for every
  active trip in one request. `mapGetData.php?eta=3` gives one stop at a time.
- **The realtime feeds are CORS-open.** VehiclePositions, TripUpdates and
  ServiceAlerts all send `access-control-allow-origin: *`, so a browser can poll
  them directly. **The static zip does not** — see the CORS section below before
  planning a browser-only architecture.

The private JSON is still worth keeping for three things, and this module uses it
only for those:

1. **Which routes actually run.** GTFS `routes.txt` lists all 10 routes Brown has
   ever configured, including `6868 Charter` and `3528 SEAS`, which have no
   trips and never appear. `getRoutes=1` carries an `outdated` flag that marks
   the 5 real ones. → `busbus.active_route_ids()`
2. **Exact passenger counts.** `getBuses=2` returns `paxLoad: 9, totalCap: 14`.
   GTFS-RT only has the coarse `occupancy_status` enum.
3. **The websocket.** No GTFS equivalent; see below.

## Live positions: websocket vs polling

`wss://passio3.com/` pushes ~1 update per vehicle every 2–6 seconds. Polling
GTFS-RT that fast would be rude and wouldn't be any fresher. Use the socket for
map animation and GTFS-RT for everything else (route assignment, occupancy,
trip/stop context — the socket carries none of that).

Two things the socket will bite you on, both handled in `stream()`:

- **An empty `filter.busId` matches nothing.** The connection opens, the
  subscribe is accepted, and no frames ever arrive. You must send the actual bus
  ids. The official `ws.js` skips the subscribe entirely when its list is empty.
  `stream()` seeds the list from `vehicles()`. GTFS-RT `vehicle.id` and the
  private `busId` are the same number, so they cross-reference cleanly.
- **Duplicate/secondary GPS.** Frames with `more.secondary` come from a backup
  unit on the same bus and make markers jump. The web app drops them; so do we.

The server never sends initial state — it only sends deltas. Seed your map from
`vehicles()`, then apply frames.

## Endpoint reference

All private endpoints are POST with a JSON body, on `https://passiogo.com`,
except `schedule=4` and `eta=3`, which are GET with query parameters.

| Endpoint | Body / params | Returns |
|---|---|---|
| `/mapGetData.php?getRoutes=1` | `{"systemSelected0":"1067","amount":1}` | routes + `outdated` flags |
| `/mapGetData.php?getStops=2` | `{"s0":"1067","sA":1}` | stops, route polylines, stop ordering |
| `/mapGetData.php?getBuses=2` | `{"s0":"1067","sA":1}` | live vehicles, exact `paxLoad`, driver name |
| `/mapGetData.php?schedule=4` | `?routeId=3469&stopId=8382` | timetable for one stop |
| `/mapGetData.php?eta=3` | `?stopIds=7865&routeId=3302` | predicted arrivals at one stop |
| `/mapGetData.php?getSystems=2` | `{}` | all Passio agencies; Brown is `id: 1067`, `username: brown` |
| `/goServices.php?getAlertMessages=1` | `{"systemSelected0":"1067","amount":1,"routesAmount":0}` | alerts + agency config incl. `wsUrl` |

### The route id trap

`getRoutes=1` returns two id-ish fields. **`myid` is the real key** — it is what
`getStops`/`getBuses` mean by `routeId`, and what GTFS calls `route_id`. The
sibling `id` field is not unique: both Commencement routes carry `id: 221345`.
Join on `myid`.

### `goShowSchedule` gates the timetable

Only routes with `goShowSchedule: 1` return anything from `schedule=4`; the rest
give `routeStops: []`. Only the two Evening routes and Bruno's Block Party have
published times — Daytime Express and the Connector run on headways. For those,
real-time predictions are the only answer, which is another argument for
TripUpdates. (`getStops=2` also has a `routeSchedules` key, but for Brown it is
the literal placeholder `{"stub":"stub"}`.)

## Auth, rate limits, terms

- **No auth anywhere.** No key, token, or cookie on any endpoint above.
- **`credentials=1` is not required.** It appears in the unofficial Python wrapper
  on `getSystems` only. Compared side by side, the sole difference is an extra
  `email` field per agency in the response. Everything else is identical, and it
  is irrelevant to Brown data.
- **Rate limit: 1200 requests/minute per IP** on `passio3.com`, advertised in
  `x-ratelimit-limit` / `-remaining` / `-reset` with `x-ratelimit-type:
  remoteAddress`. `passiogo.com` sends no limit headers. Read the headers and
  back off rather than assuming.
- **Terms of use:** `passio3.com/www/mapGetData.php?terms=1` — the endpoint the
  app links for its terms — currently serves only a stub: *"Here will be online
  redirect to Terms and Conditions"*, pointing at passiotech.com. There is no
  `robots.txt` on `passiogo.com` (404). So there is no published document
  restricting this, and equally nothing granting permission. Passio markets an
  "Open API" and ships CORS-open GTFS, which reads as intent to allow reuse, but
  it is not a license. If this app goes public, ask Brown Transportation
  first — they own the agency account and can get you a straight answer.

Be polite regardless: this module sets a `User-Agent` (override with
`BUSBUS_USER_AGENT`), caches the static feed on disk with ETag revalidation, and
prefers one websocket over a fast poll. Suggested budget — static: once a day;
VehiclePositions/TripUpdates: 5–10s while a map is on screen, nothing when it
isn't; alerts: once a minute.

### Personal data

Two fields carry personal information and should not be surfaced in a public UI:
`getBuses=2` includes the driver's first name and last initial, and alert records
in `getAlertMessages` include the full name and work email of the Transdev staffer
who posted them. GTFS-RT exposes neither.

## Routes Passio serves for Brown

From `getRoutes=1`. `myid` is the join key; **active** = `outdated != "1"`.

| myid | Short | Color | Name | Active | Timetable |
|---|---|---|---|---|---|
| 3302 | X | `#347f3d` | X Daytime Express | yes | headway only |
| 3469 | E | `#6a477c` | Evening CW Route | yes | published |
| 3470 | E | `#3da8df` | Evening CCW Route | yes | published |
| 22427 | | `#e2002d` | Brown Stadium Loop | yes | headway only |
| 62487 | Peach Loop | `#ff7f0e` | Peach Loop Connector Route | yes | headway only |
| 72922 | | `#ffc72c` | Commencement - College Hill Shuttle | no | — |
| 72923 | | `#d62728` | Commencement - Jewelry District Shuttle | no | — |
| 72924 | Block Party | `#000000` | Bruno's Block Party | no | published |

GTFS `routes.txt` adds two more that the private API omits entirely and that have
no trips: `6868 Charter` and `3528 SEAS`.

The three inactive routes are also listed in `excludedRoutesID` in the
`getStops=2` response — the web app hides them. Treating `outdated == "1"` as
"don't show" reproduces what students see in the BrownU and Passio GO apps.

## OnCall / on-demand service: not present

Checked explicitly, and the answer is no — **no OnCall or on-demand service
appears anywhere in the Brown 1067 responses**, so nothing to include. Four
independent confirmations:

1. None of the 8 routes from `getRoutes=1` (or the 10 in GTFS `routes.txt`) is
   OnCall or anything on-demand. All 8 are fixed-route loops.
2. Passio *does* have an on-demand product — it appears in these payloads as
   "Ride Request". Brown's config has it switched off: `goRideRequestEnabled: 0`
   in the `getAlertMessages` response.
3. The two arrays that would carry it, `routesRR` and `stopsRR` in `getStops=2`
   (RR = Ride Request), are both empty. So is `groupRoutes`.
4. GTFS `stop_times.txt` has no `start_pickup_drop_off_window` /
   `end_pickup_drop_off_window` values populated — those columns exist in the
   header and every row leaves them blank. That is the GTFS-Flex signal for
   demand-responsive service, and it is absent.

This matches your expectation: OnCall runs on TransLoc, a different vendor with a
different backend, and none of it reaches Passio. A Brown app covering both needs
a separate TransLoc integration.

## brownshuttle.com and the other apps

- **brownshuttle.com** 301s straight to `brownuniversity.passiogo.com`. It is not
  a separate service and has no data of its own.
- **brownuniversity.passiogo.com** is the Passio GO web app — jQuery, Google Maps,
  and the `mapGetData.php` / `goServices.php` calls in the table above. Its
  `ws.js` is where the websocket subscribe shape above comes from. It never
  touches GTFS; the string "gtfs" does not appear in any of its JavaScript.
- **BrownU and Passio GO (mobile)** call the same private endpoints with a
  `deviceId` query parameter added. `deviceId` is not required — every endpoint
  answers fine without it — and is presumably for Passio's own analytics and push
  registration (`goServices.php?register=1&deviceId=`). Omit it.

There is no better-documented official endpoint hiding behind either app. The
GTFS feeds are the well-documented source, and nothing Brown ships points at them.

---

# Routefinding

The app answers one question: **given where I am and where I'm going, which shuttle gets me there soonest?** Earliest *arrival*, not shortest ride — a slower bus leaving now routinely beats an express leaving in fifteen minutes.

```bash
npm install
npx tsx scripts/plan-demo.ts                          # John Hay -> South St Landing
npx tsx scripts/plan-demo.ts 41.8315,-71.4020 41.8243,-71.4005   # any two points
```

Real output:

```
[1] ARRIVE 7:47 PM   leave by 7:40 PM   3 min walking, 0 transfer(s)
     walk 3 min to Cushing & Thayer
     7:43 PM board Evening CW Route at Cushing & Thayer  [scheduled]
     7:47 PM alight at Patriots Court (2 stops)
     walk 1 min to destination
```

## How it works

| Step | Source |
|---|---|
| Find candidate stops near each end | GTFS `stops.txt`, pruned to the 8 nearest |
| Real walking times to those stops | Valhalla `sources_to_targets` — **one** call per end |
| When each bus actually departs | GTFS-RT TripUpdates, falling back to the timetable |
| Rank by arrival at the destination | `src/routing/plan.ts` — pure function, no I/O |
| Two-leg trips when no single ride works | `src/routing/transfers.ts` |

`planTrips()` is deliberately pure — no `fetch`, no `Date.now()`. Every input is an argument, which is what makes the ranking logic testable against frozen fixtures instead of against whatever the buses happen to be doing.

## Why Valhalla and not OSRM

OSRM's public demo server **has no pedestrian profile loaded**. It answers `/route/v1/foot/` with car routing and still returns `code: "Ok"` — measured 2,087 m in 176 s, which is 42 km/h. Valhalla returns 5.0 km/h with real sidewalk geometry. Both are free and keyless; only one is correct.

## Known limits, all upstream

- **Predictions reach only ~18 minutes ahead.** Beyond that the ranker uses the timetable and marks the itinerary `[scheduled]` rather than `[live]`.
- **Daytime Express has 1 static trip; Brown Stadium Loop has 0.** Passio publishes no timetable for them, so outside live-prediction range they cannot be routed. This is missing upstream data, not a bug here.
- **An empty result is often correct.** After the Connector's last run, nothing connects College Hill to the Jewelry District, and the honest answer is "no itineraries."

## Tests

```bash
npm test
```

44 tests, no network — everything runs against frozen fixtures in `test/fixtures/`. To re-freeze after Passio changes its data:

```bash
./scripts/refresh-fixtures.sh
```

Run that when a test fails *because the data changed*, never to make a failing test pass. Inspect the diff first.


## CORS: the static feed is the exception

Measured per endpoint, with `Origin: http://localhost:5173`:

| Endpoint | `access-control-allow-origin` |
|---|---|
| `realtime/vehiclePositions` | `*` |
| `realtime/tripUpdates` | `*` |
| `realtime/serviceAlerts` | `*` |
| `google_transit.zip` | **absent** |

So a browser can poll live data directly but **cannot fetch the timetable**. Three ways around it, in order of laziness:

1. **Dev:** the Vite proxy at `/passio-gtfs` (already configured in `vite.config.ts`).
2. **Production:** any one-line reverse proxy, or a scheduled job that copies the zip somewhere you control. The feed changes about once a month, so this need not be live.
3. **Bundle it at build time** and re-deploy monthly. Watch `feed_end_date` — a stale timetable fails quietly, which is the worst way to fail.

One related trap: do **not** set a `User-Agent` header on browser fetches. It is a forbidden header, and merely requesting it makes the call non-simple, triggering a CORS preflight that passio3.com does not answer — so the request fails even against the endpoints that are CORS-open. `httpGetBytes` sets it only under Node.

## Debug map

A deliberately bare map for seeing what the feeds actually contain — route shapes, all 70 stops, live buses, and what the router picks. Not the real UI.

```bash
npm run dev      # http://localhost:5173
```

Click once for origin, once for destination, once more to reset. Ranked itineraries appear top-left; the chosen route is drawn dark over the map.

`0 bus(es) live` is frequently correct rather than broken — Passio reports zero vehicles whenever none are broadcasting GPS, including mid-evening while scheduled service is still running.
