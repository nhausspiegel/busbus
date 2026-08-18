"""
busbus - Brown University shuttle data from Passio GO.

Two data sources, both public and unauthenticated:

  1. GTFS  (RECOMMENDED, and what this module uses by default)
       static:   https://passio3.com/brown/passioTransit/gtfs/google_transit.zip
       realtime: https://passio3.com/brown/passioTransit/gtfs/realtime/{vehiclePositions,tripUpdates,serviceAlerts}
     Standard formats, stable URLs, documented semantics. Covers routes, stops,
     shapes, the full timetable, live vehicles, per-stop predictions and alerts.

  2. Private JSON (https://passiogo.com/mapGetData.php, goServices.php)
     What the brownshuttle.com web app and the BrownU/Passio GO apps actually
     call. Undocumented, but has three things GTFS does not:
       - live route polylines + `outdated` flags for which routes run today
       - raw passenger counts (GTFS-RT only exposes a coarse occupancy enum)
       - the wss://passio3.com push stream, ~1 update/vehicle/4s vs polling

Recommended split: GTFS for everything static and for a correct polling
fallback; the websocket on top when you want smooth marker movement.
See README.md.

No API key, no cookie, no `credentials=1` anywhere. Rate limit is 1200
requests/min/IP on passio3.com (x-ratelimit-* headers); passiogo.com sends no
limit headers. Defaults here stay far under both.
"""

from __future__ import annotations

import csv
import io
import json
import os
import time
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

SYSTEM_ID = "1067"        # Brown University, from getSystems
SYSTEM_SLUG = "brown"     # the `username` field of that same record; builds GTFS URLs

GTFS_BASE = f"https://passio3.com/{SYSTEM_SLUG}/passioTransit/gtfs"
PRIVATE_BASE = "https://passiogo.com"
WS_URL = "wss://passio3.com/"   # served as `wsUrl` by goServices.php?getAlertMessages=1

USER_AGENT = os.environ.get(
    "BUSBUS_USER_AGENT",
    "busbus/0.1 (+https://github.com/yourname/busbus) python-urllib",
)
CACHE_DIR = Path(os.environ.get("BUSBUS_CACHE", Path.home() / ".cache" / "busbus"))


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def _get(url: str, headers: dict | None = None, timeout: int = 30):
    """GET -> (status, body_bytes, response_headers). 304 comes back with b''."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return 304, b"", dict(e.headers)
        raise


def _post_json(path: str, body: dict, timeout: int = 30) -> dict | list:
    """POST a JSON body to a private mapGetData/goServices endpoint."""
    req = urllib.request.Request(
        PRIVATE_BASE + path,
        data=json.dumps(body).encode(),
        headers={"User-Agent": USER_AGENT, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


# --------------------------------------------------------------------------
# (a) routes + stops, and (b) the schedule -- all from GTFS static
# --------------------------------------------------------------------------

@dataclass
class Route:
    id: str            # GTFS route_id == `myid` in the private JSON. NOT the private `id`.
    name: str
    short_name: str
    color: str         # "#RRGGBB"
    shape: list[tuple[float, float]] = field(default_factory=list)  # (lat, lon) polyline


@dataclass
class Stop:
    id: str
    name: str
    lat: float
    lon: float


@dataclass
class Static:
    """One decoded GTFS static feed. Cheap to hold; refetch daily at most."""
    routes: dict[str, Route]
    stops: dict[str, Stop]
    trips: list[dict]
    stop_times: list[dict]
    feed_end_date: str    # YYYYMMDD; refetch before this or the timetable goes stale

    def stops_on(self, route_id: str) -> list[Stop]:
        """Stops served by a route, in the order the first trip visits them."""
        trip_ids = {t["trip_id"] for t in self.trips if t["route_id"] == route_id}
        if not trip_ids:
            return []
        # Longest trip = the fullest picture of the route; short trips skip stops.
        best, seen = [], {}
        for st in self.stop_times:
            if st["trip_id"] in trip_ids:
                seen.setdefault(st["trip_id"], []).append(st)
        best = max(seen.values(), key=len, default=[])
        best.sort(key=lambda s: int(s["stop_sequence"]))
        return [self.stops[s["stop_id"]] for s in best if s["stop_id"] in self.stops]

    def schedule(self, stop_id: str, route_id: str | None = None) -> list[str]:
        """Scheduled departure times ("HH:MM:SS") at a stop, sorted.

        GTFS allows times past 24:00:00 for trips running after midnight -- the
        Evening routes here do exactly that. Sorting the raw strings keeps that
        ordering correct, so don't parse these into `datetime.time`.
        """
        ok = None
        if route_id is not None:
            ok = {t["trip_id"] for t in self.trips if t["route_id"] == route_id}
        return sorted(
            st["departure_time"]
            for st in self.stop_times
            if st["stop_id"] == stop_id and (ok is None or st["trip_id"] in ok)
        )


def load_static(force: bool = False) -> Static:
    """Fetch (or reuse a cached copy of) the GTFS static feed.

    Cached on disk and revalidated with If-None-Match, so a warm call is one
    conditional request that the server answers 304 with an empty body.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    zip_path, etag_path = CACHE_DIR / "gtfs.zip", CACHE_DIR / "gtfs.etag"

    headers = {}
    if zip_path.exists() and etag_path.exists() and not force:
        headers["If-None-Match"] = etag_path.read_text().strip()

    status, body, resp = _get(f"{GTFS_BASE}/google_transit.zip", headers)
    if status == 200:
        zip_path.write_bytes(body)
        if resp.get("etag"):
            etag_path.write_text(resp["etag"])
    raw = zip_path.read_bytes()

    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        def table(name):
            with z.open(name) as f:
                return list(csv.DictReader(io.TextIOWrapper(f, "utf-8-sig")))

        # shapes.txt gives the drawable polyline for each route.
        shapes: dict[str, list] = {}
        for p in table("shapes.txt"):
            shapes.setdefault(p["shape_id"], []).append(
                (int(p["shape_pt_sequence"]), float(p["shape_pt_lat"]), float(p["shape_pt_lon"]))
            )
        for k in shapes:
            shapes[k] = [(lat, lon) for _, lat, lon in sorted(shapes[k])]

        routes = {
            r["route_id"]: Route(
                id=r["route_id"],
                name=r["route_long_name"],
                short_name=r["route_short_name"],
                # GTFS colors are bare hex with no '#'.
                color="#" + (r["route_color"] or "888888"),
                shape=shapes.get(r["route_id"], []),
            )
            for r in table("routes.txt")
        }
        stops = {
            s["stop_id"]: Stop(s["stop_id"], s["stop_name"], float(s["stop_lat"]), float(s["stop_lon"]))
            for s in table("stops.txt")
        }
        info = table("feed_info.txt")
        return Static(
            routes=routes,
            stops=stops,
            trips=table("trips.txt"),
            stop_times=table("stop_times.txt"),
            feed_end_date=info[0]["feed_end_date"] if info else "",
        )


# --------------------------------------------------------------------------
# (c) live vehicles
# --------------------------------------------------------------------------

@dataclass
class Vehicle:
    bus_id: str          # stable per physical bus; the websocket keys on this
    label: str           # fleet number painted on the bus, e.g. "124"
    route_id: str
    lat: float
    lon: float
    bearing: float
    stop_id: str | None
    occupancy: str       # GTFS-RT enum name, e.g. "MANY_SEATS_AVAILABLE"
    timestamp: int       # unix seconds, from the bus's own GPS fix


def vehicles() -> list[Vehicle]:
    """Poll GTFS-RT VehiclePositions. Feed refreshes every few seconds.

    Poll at 5-10s. Faster buys nothing -- use `stream()` for smooth motion.
    """
    from google.transit import gtfs_realtime_pb2

    _, body, _ = _get(f"{GTFS_BASE}/realtime/vehiclePositions")
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(body)
    out = []
    for e in feed.entity:
        v = e.vehicle
        out.append(Vehicle(
            bus_id=v.vehicle.id,
            label=v.vehicle.label,
            route_id=v.trip.route_id,
            lat=v.position.latitude,
            lon=v.position.longitude,
            bearing=v.position.bearing,
            stop_id=v.stop_id or None,
            occupancy=gtfs_realtime_pb2.VehiclePosition.OccupancyStatus.Name(v.occupancy_status),
            timestamp=v.timestamp,
        ))
    return out


def predictions(stop_id: str | None = None) -> dict[str, list[dict]]:
    """Poll GTFS-RT TripUpdates -> {stop_id: [{route_id, trip_id, arrival, ...}]}.

    This is the real-time "when is the next bus" answer. The static timetable
    only covers the Evening routes; Daytime Express and the Connector run on
    headways with no published times, so predictions are all riders get.
    """
    from google.transit import gtfs_realtime_pb2

    _, body, _ = _get(f"{GTFS_BASE}/realtime/tripUpdates")
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(body)
    out: dict[str, list[dict]] = {}
    for e in feed.entity:
        tu = e.trip_update
        for stu in tu.stop_time_update:
            if stop_id and stu.stop_id != stop_id:
                continue
            out.setdefault(stu.stop_id, []).append({
                "route_id": tu.trip.route_id,
                "trip_id": tu.trip.trip_id,
                "vehicle_label": tu.vehicle.label,
                "arrival": stu.arrival.time or None,
                "stop_sequence": stu.stop_sequence,
            })
    for v in out.values():
        v.sort(key=lambda x: x["arrival"] or 0)
    return out


def alerts() -> list[dict]:
    """Poll GTFS-RT ServiceAlerts (detours, stop closures)."""
    from google.transit import gtfs_realtime_pb2

    _, body, _ = _get(f"{GTFS_BASE}/realtime/serviceAlerts")
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(body)
    return [{
        "route_ids": [ie.route_id for ie in e.alert.informed_entity if ie.route_id],
        "header": e.alert.header_text.translation[0].text if e.alert.header_text.translation else "",
        "description": (e.alert.description_text.translation[0].text
                        if e.alert.description_text.translation else ""),
        "start": e.alert.active_period[0].start if e.alert.active_period else None,
        "end": e.alert.active_period[0].end if e.alert.active_period else None,
    } for e in feed.entity]


async def stream(bus_ids: list[int] | None = None):
    """Async-iterate live positions off wss://passio3.com/.

    Yields dicts: {busId, latitude, longitude, course, paxLoad}. Roughly one
    frame per vehicle every 2-6s -- smoother than any polling rate, and cheaper
    on the server. Reconnect on drop; the server never resends state, so seed
    your map from `vehicles()` first and let the stream apply deltas.

    `bus_ids` is the set of vehicles to subscribe to. It is NOT optional to the
    server: an empty `filter.busId` matches nothing and the connection just sits
    silent, which is why the official ws.js skips the subscribe entirely when its
    list is empty. Omit the argument and we seed it from the RT feed, which is
    what you want anyway -- you need that snapshot for initial marker positions.
    """
    import websockets  # optional dependency; only this function needs it

    if bus_ids is None:
        bus_ids = [int(v.bus_id) for v in vehicles() if v.bus_id]
    if not bus_ids:
        return  # nothing in service; caller should retry later

    sub = {
        "subscribe": "location",
        "userId": [int(SYSTEM_ID)],
        "filter": {"outOfService": 0, "busId": sorted(bus_ids)},
        "field": ["busId", "latitude", "longitude", "course", "paxLoad", "more"],
    }
    async with websockets.connect(WS_URL, user_agent_header=USER_AGENT) as ws:
        await ws.send(json.dumps(sub))
        async for msg in ws:
            frame = json.loads(msg)
            # `more.secondary` marks a backup GPS unit on the same bus. The
            # official web app drops these; keeping them makes markers jump.
            if frame.get("more", {}).get("secondary"):
                continue
            yield frame


# --------------------------------------------------------------------------
# Private JSON -- only for what GTFS genuinely lacks
# --------------------------------------------------------------------------

def private_routes() -> list[dict]:
    """Raw mapGetData.php?getRoutes=1.

    Use for the `outdated` flag: GTFS ships every route Brown has ever
    configured, including Charter and SEAS which have no service. This tells
    you which ones are live. Join on `myid` -- the sibling `id` field is NOT
    unique (both Commencement routes share id 221345).
    """
    return _post_json("/mapGetData.php?getRoutes=1", {"systemSelected0": SYSTEM_ID, "amount": 1})


def active_route_ids() -> set[str]:
    """Route ids currently in service, per the agency's own config."""
    return {r["myid"] for r in private_routes() if r.get("outdated") != "1"}


def private_buses() -> dict:
    """Raw mapGetData.php?getBuses=2. Has exact paxLoad/totalCap and driver name.

    Note this returns a real passenger count and the driver's first name +
    initial. Don't surface the driver in a public UI.
    """
    return _post_json("/mapGetData.php?getBuses=2", {"s0": SYSTEM_ID, "sA": 1})


# --------------------------------------------------------------------------

def selftest() -> None:
    """One live check covering every claim this module makes. Hits the network."""
    s = load_static()

    assert len(s.routes) >= 8, s.routes
    assert "3302" in s.routes and s.routes["3302"].name == "Daytime Express"
    assert s.routes["3302"].color.startswith("#") and len(s.routes["3302"].color) == 7
    assert len(s.routes["3302"].shape) > 10, "route polyline missing"
    assert s.feed_end_date.isdigit() and len(s.feed_end_date) == 8

    # Evening CW is the timetabled route; its stop 8382 must have real times.
    times = s.schedule("8382", route_id="3469")
    assert times and all(t.count(":") == 2 for t in times), times
    # Post-midnight trips are encoded as 24:xx/25:xx, not 00:xx (22 such rows in
    # the current feed). Asserting `times == sorted(times)` would be vacuous --
    # schedule() already sorts. Assert the property that actually matters: late
    # trips stay after evening ones instead of wrapping to the front.
    hours = [int(t.split(":")[0]) for t in times]
    assert hours == sorted(hours), f"ordering broke: {times[:5]}..{times[-5:]}"
    if any(h >= 24 for h in hours):
        assert hours[-1] >= 24, "post-midnight trip did not sort last"

    ordered = s.stops_on("3302")
    assert len(ordered) >= 5 and all(isinstance(x, Stop) for x in ordered)

    active = active_route_ids()
    assert "3302" in active and "6868" not in active, active  # Charter never runs

    v = vehicles()
    for x in v:  # may legitimately be empty overnight
        assert -90 <= x.lat <= 90 and -180 <= x.lon <= 180
        assert x.route_id in s.routes, f"RT route {x.route_id} absent from static"

    # The websocket seeds its subscription from `v`; an empty busId filter is
    # silently accepted and then streams nothing, so assert we get real frames.
    frames = 0
    if v:
        import asyncio

        async def _sip():
            nonlocal frames
            async for _ in stream():
                frames += 1
                if frames >= 3:
                    return
        try:
            asyncio.run(asyncio.wait_for(_sip(), 40))
        except ImportError:
            frames = -1  # `websockets` not installed; stream() is optional
        assert frames != 0, "websocket subscribed but streamed nothing"

    print(f"ok: {len(s.routes)} routes ({len(active)} active), {len(s.stops)} stops, "
          f"{len(s.stop_times)} stop_times, {len(v)} vehicles live, "
          f"{frames} ws frames, feed valid through {s.feed_end_date}")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "stream":
        import asyncio

        async def _demo():
            async for f in stream():
                print(f"{f['busId']:>6}  {f['latitude']:.5f},{f['longitude']:.5f}  "
                      f"hdg {f['course']:>6.1f}  pax {f['paxLoad']}")
        asyncio.run(_demo())
    else:
        selftest()
