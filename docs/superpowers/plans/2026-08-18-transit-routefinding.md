# Transit Routefinding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given any origin and destination near Brown, return a list of shuttle itineraries ranked by **earliest arrival at the destination**, with walking time on both ends included.

**Architecture:** Three layers with hard boundaries. `data/` fetches and normalizes Passio's feeds (GTFS static + GTFS-RT). `routing/walk.ts` turns coordinates into walking times via Valhalla. `routing/plan.ts` is a **pure function** — it takes already-fetched departures and walk times and returns ranked itineraries, touching no network. Purity is the whole point: the ranker is the part that can be subtly wrong, so it must be testable against frozen fixtures with zero I/O.

**Tech Stack:** TypeScript, Vite, React 19, Vitest, `gtfs-realtime-bindings` (protobuf decode), `fflate` (unzip GTFS in-browser), MapLibre GL (later tasks).

## Global Constraints

- **No API keys, ever.** Any dependency requiring a key or billing account is disqualified. This is a hard project requirement.
- **Route join key is GTFS `route_id`**, equal to `myid` in Passio's private JSON. The private `id` field is NOT unique — two Commencement routes share `221345`. Never join on it.
- **Times may exceed 24:00:00.** GTFS encodes post-midnight service as `24:xx`/`25:xx` (22 such rows currently). Never parse a GTFS time into a `Date` without adding it to a service-day epoch.
- **Rate limit: 1200 req/min per IP** on passio3.com. Valhalla and Nominatim are volunteer-run — one request per user action, never per keystroke.
- **Set a User-Agent** on every outbound request: `busbus/0.1 (github.com/<user>/busbus)`.
- **Tests never hit the network.** All tests run against frozen fixtures in `test/fixtures/`.
- **`busbus.py` is not part of the app.** It stays at repo root as the live-verification tool. Do not import, move, or modify it.
- Node 20+. `npm test` must be the single command that runs everything (the Stop hook depends on it).

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html` | Scaffolding. `npm test` → vitest run. |
| `src/data/types.ts` | Shared domain types. No logic. |
| `src/data/passio.ts` | Endpoint constants + `httpGet` with User-Agent. Single place any URL appears. |
| `src/data/gtfs.ts` | Fetch + unzip + parse GTFS static into `StaticFeed`. |
| `src/data/realtime.ts` | Decode GTFS-RT TripUpdates → `LiveDeparture[]`. |
| `src/data/departures.ts` | Merge live + scheduled into one `DepartureBoard`. RT wins on conflict. |
| `src/routing/walk.ts` | Valhalla matrix + geometry. Only file that knows Valhalla exists. |
| `src/routing/plan.ts` | **Pure earliest-arrival ranker.** The core. |
| `src/routing/transfers.ts` | Objective 2. Second-round transfer search. |
| `test/fixtures/*` | Frozen GTFS zip + RT protobuf + expected outputs. |
| `test/*.test.ts` | One test file per source module. |

---

### Task 1: Scaffold + fixtures

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `.gitignore` (append)
- Create: `test/fixtures/README.md`, `test/fixtures/gtfs.zip`, `test/fixtures/tripUpdates.pb`
- Create: `scripts/refresh-fixtures.sh`

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` runs vitest; fixtures available at `test/fixtures/`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "busbus",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "gtfs-realtime-bindings": "^1.1.1",
    "fflate": "^0.8.2",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src", "test"]
}
```

`noUncheckedIndexedAccess` is deliberate: the ranker indexes into arrays of departures constantly, and this forces the undefined checks that prevent silent wrong answers.

- [ ] **Step 3: Create `vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
```

- [ ] **Step 4: Create `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>busbus</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `scripts/refresh-fixtures.sh`**

```bash
#!/usr/bin/env bash
# Re-freeze test fixtures from the live Passio feeds.
# Run this when a test fails because Passio changed its data, NOT to make a
# failing test pass. Inspect the diff before committing.
set -euo pipefail
cd "$(dirname "$0")/.."
UA='busbus/0.1 (fixture refresh)'
B=https://passio3.com/brown/passioTransit/gtfs
curl -sS -H "User-Agent: $UA" "$B/google_transit.zip"            -o test/fixtures/gtfs.zip
curl -sS -H "User-Agent: $UA" "$B/realtime/tripUpdates"          -o test/fixtures/tripUpdates.pb
echo "refreshed. gtfs.zip=$(wc -c < test/fixtures/gtfs.zip)B  tripUpdates.pb=$(wc -c < test/fixtures/tripUpdates.pb)B"
```

- [ ] **Step 6: Fetch fixtures and install**

```bash
chmod +x scripts/refresh-fixtures.sh && ./scripts/refresh-fixtures.sh
npm install
```

- [ ] **Step 7: Verify the harness runs**

Run: `npm test`
Expected: vitest reports "No test files found" and exits 0. (Exit 0 matters — the Stop hook keys on it.)

- [ ] **Step 8: Append to `.gitignore`**

```
node_modules/
dist/
```

---

### Task 2: Domain types

**Files:**
- Create: `src/data/types.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `Stop`, `Route`, `TripStop`, `Trip`, `StaticFeed`, `Departure`, `DepartureBoard`, `LatLng`, `WalkLeg`, `RideLeg`, `Itinerary`

- [ ] **Step 1: Write the types**

```ts
export interface LatLng { lat: number; lng: number }

export interface Stop { id: string; name: string; lat: number; lng: number }

export interface Route {
  id: string;          // GTFS route_id == Passio `myid`. Never Passio `id`.
  name: string;
  shortName: string;
  color: string;       // "#RRGGBB"
  shape: LatLng[];     // drawable polyline from shapes.txt
}

/** One stop on one trip. `time` is seconds after that service day's midnight,
 *  so post-midnight trips legitimately exceed 86400. */
export interface TripStop { stopId: string; seq: number; time: number }

export interface Trip { id: string; routeId: string; stops: TripStop[] }

export interface StaticFeed {
  routes: Map<string, Route>;
  stops: Map<string, Stop>;
  trips: Map<string, Trip>;
  feedEndDate: string;   // YYYYMMDD
}

/** A bus leaving a specific stop at a specific absolute time.
 *  `live` distinguishes a real-time prediction from a timetable entry. */
export interface Departure {
  stopId: string;
  tripId: string;
  routeId: string;
  seq: number;
  time: number;     // absolute epoch SECONDS
  live: boolean;
}

/** All known departures, grouped by stop, each list sorted ascending by time. */
export type DepartureBoard = Map<string, Departure[]>;

export interface WalkLeg { from: LatLng; to: LatLng; seconds: number; geometry?: LatLng[] }

export interface RideLeg {
  routeId: string;
  tripId: string;
  boardStopId: string;
  alightStopId: string;
  departTime: number;   // epoch seconds
  arriveTime: number;   // epoch seconds
  live: boolean;
  numStops: number;
}

export interface Itinerary {
  arriveTime: number;      // epoch seconds at the DESTINATION — the ranking key
  departTime: number;      // when the user must leave their current position
  walkToStop: WalkLeg;
  rides: RideLeg[];        // length 1 today; >1 once transfers land
  walkFromStop: WalkLeg;
  totalWalkSeconds: number;
  transfers: number;
  allLive: boolean;        // false if any leg came from the timetable
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/data/types.ts && git commit -m "feat: domain types for transit routing"
```

---

### Task 3: GTFS static parsing

**Files:**
- Create: `src/data/passio.ts`, `src/data/gtfs.ts`
- Test: `test/gtfs.test.ts`

**Interfaces:**
- Consumes: `StaticFeed`, `Route`, `Stop`, `Trip`, `TripStop` from Task 2
- Produces: `parseStaticFeed(zip: Uint8Array): StaticFeed`, `fetchStaticFeed(): Promise<StaticFeed>`, `gtfsTimeToSeconds(hhmmss: string): number | null`

- [ ] **Step 1: Write `src/data/passio.ts`**

```ts
export const SYSTEM_ID = "1067";     // Brown University
export const SYSTEM_SLUG = "brown";  // `username` from getSystems; builds GTFS URLs

export const GTFS_BASE = `https://passio3.com/${SYSTEM_SLUG}/passioTransit/gtfs`;
export const GTFS_STATIC_URL = `${GTFS_BASE}/google_transit.zip`;
export const GTFS_TRIP_UPDATES_URL = `${GTFS_BASE}/realtime/tripUpdates`;
export const GTFS_VEHICLES_URL = `${GTFS_BASE}/realtime/vehiclePositions`;
export const GTFS_ALERTS_URL = `${GTFS_BASE}/realtime/serviceAlerts`;

export const USER_AGENT = "busbus/0.1 (github.com/busbus/busbus)";

export async function httpGetBytes(url: string): Promise<Uint8Array> {
  // Browsers forbid setting User-Agent; it applies when running under Node
  // (tests, scripts). Harmless either way.
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
```

- [ ] **Step 2: Write the failing test `test/gtfs.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStaticFeed, gtfsTimeToSeconds } from "../src/data/gtfs";

const zip = new Uint8Array(readFileSync("test/fixtures/gtfs.zip"));

describe("gtfsTimeToSeconds", () => {
  it("parses a normal time", () => {
    expect(gtfsTimeToSeconds("07:30:00")).toBe(7 * 3600 + 30 * 60);
  });

  it("preserves post-midnight times past 24h instead of wrapping", () => {
    // The Evening routes run past midnight; GTFS encodes 1:11am as 25:11:00.
    // Wrapping this to 4260 would sort it before the 11pm trips and produce
    // an itinerary that tells the user to catch a bus that already left.
    expect(gtfsTimeToSeconds("25:11:00")).toBe(25 * 3600 + 11 * 60);
  });

  it("returns null for the blank times GTFS uses at non-timepoint stops", () => {
    expect(gtfsTimeToSeconds("")).toBeNull();
  });
});

describe("parseStaticFeed", () => {
  const feed = parseStaticFeed(zip);

  it("loads every route with a usable color and shape", () => {
    expect(feed.routes.size).toBeGreaterThanOrEqual(8);
    const x = feed.routes.get("3302");
    expect(x?.name).toBe("Daytime Express");
    expect(x?.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(x!.shape.length).toBeGreaterThan(10);
  });

  it("loads stops with real coordinates near Providence", () => {
    expect(feed.stops.size).toBeGreaterThanOrEqual(60);
    for (const s of feed.stops.values()) {
      expect(s.lat).toBeGreaterThan(41.7);
      expect(s.lat).toBeLessThan(41.9);
      expect(s.lng).toBeGreaterThan(-71.5);
      expect(s.lng).toBeLessThan(-71.3);
    }
  });

  it("orders every trip's stops by ascending sequence", () => {
    for (const t of feed.trips.values()) {
      const seqs = t.stops.map((s) => s.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    }
  });

  it("drops trip stops that have no time rather than defaulting them to zero", () => {
    // 3 such rows exist. Defaulting them to 0 would make them look like
    // midnight departures and poison the ranker.
    for (const t of feed.trips.values()) {
      for (const s of t.stops) expect(s.time).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run test/gtfs.test.ts`
Expected: FAIL — cannot resolve `../src/data/gtfs`.

- [ ] **Step 4: Implement `src/data/gtfs.ts`**

```ts
import { unzipSync, strFromU8 } from "fflate";
import { GTFS_STATIC_URL, httpGetBytes } from "./passio";
import type { StaticFeed, Route, Stop, Trip, TripStop, LatLng } from "./types";

/** GTFS times are "HH:MM:SS" and MAY exceed 24h for post-midnight service.
 *  Returns seconds after service-day midnight, or null for blank entries. */
export function gtfsTimeToSeconds(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const p = t.split(":");
  if (p.length !== 3) return null;
  const [h, m, s] = p.map(Number);
  if (![h, m, s].every(Number.isFinite)) return null;
  return h! * 3600 + m! * 60 + s!;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const split = (line: string): string[] => {
    // GTFS quotes any field containing a comma (stop names do this).
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const header = split(lines[0]!).map((h) => h.replace(/^﻿/, "").trim());
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

export function parseStaticFeed(zipBytes: Uint8Array): StaticFeed {
  const files = unzipSync(zipBytes);
  const table = (name: string): Record<string, string>[] =>
    files[name] ? parseCsv(strFromU8(files[name]!)) : [];

  // shapes.txt -> one ordered polyline per shape_id
  const shapes = new Map<string, { seq: number; p: LatLng }[]>();
  for (const r of table("shapes.txt")) {
    const id = r["shape_id"]!;
    if (!shapes.has(id)) shapes.set(id, []);
    shapes.get(id)!.push({
      seq: Number(r["shape_pt_sequence"]),
      p: { lat: Number(r["shape_pt_lat"]), lng: Number(r["shape_pt_lon"]) },
    });
  }
  const shapeOf = (id: string): LatLng[] =>
    (shapes.get(id) ?? []).sort((a, b) => a.seq - b.seq).map((x) => x.p);

  const routes = new Map<string, Route>();
  for (const r of table("routes.txt")) {
    const id = r["route_id"]!;
    routes.set(id, {
      id,
      name: r["route_long_name"] ?? "",
      shortName: r["route_short_name"] ?? "",
      // GTFS ships bare hex with no leading '#'.
      color: "#" + (r["route_color"] || "888888"),
      shape: shapeOf(id),
    });
  }

  const stops = new Map<string, Stop>();
  for (const r of table("stops.txt")) {
    stops.set(r["stop_id"]!, {
      id: r["stop_id"]!,
      name: r["stop_name"] ?? "",
      lat: Number(r["stop_lat"]),
      lng: Number(r["stop_lon"]),
    });
  }

  const tripRoute = new Map<string, string>();
  for (const r of table("trips.txt")) tripRoute.set(r["trip_id"]!, r["route_id"]!);

  const tripStops = new Map<string, TripStop[]>();
  for (const r of table("stop_times.txt")) {
    const time = gtfsTimeToSeconds(r["departure_time"] ?? "");
    if (time === null) continue;  // blank at non-timepoint stops; skip, never default
    const id = r["trip_id"]!;
    if (!tripStops.has(id)) tripStops.set(id, []);
    tripStops.get(id)!.push({ stopId: r["stop_id"]!, seq: Number(r["stop_sequence"]), time });
  }

  const trips = new Map<string, Trip>();
  for (const [id, ts] of tripStops) {
    trips.set(id, {
      id,
      routeId: tripRoute.get(id) ?? "",
      stops: ts.sort((a, b) => a.seq - b.seq),
    });
  }

  const info = table("feed_info.txt")[0];
  return { routes, stops, trips, feedEndDate: info?.["feed_end_date"] ?? "" };
}

export async function fetchStaticFeed(): Promise<StaticFeed> {
  return parseStaticFeed(await httpGetBytes(GTFS_STATIC_URL));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/gtfs.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/data/passio.ts src/data/gtfs.ts test/gtfs.test.ts
git commit -m "feat: parse GTFS static feed"
```

---

### Task 4: Real-time departures

**Files:**
- Create: `src/data/realtime.ts`
- Test: `test/realtime.test.ts`

**Interfaces:**
- Consumes: `Departure` from Task 2
- Produces: `parseTripUpdates(bytes: Uint8Array): Departure[]`, `fetchLiveDepartures(): Promise<Departure[]>`

- [ ] **Step 1: Write the failing test `test/realtime.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseTripUpdates } from "../src/data/realtime";

const pb = new Uint8Array(readFileSync("test/fixtures/tripUpdates.pb"));

describe("parseTripUpdates", () => {
  const deps = parseTripUpdates(pb);

  it("decodes departures without throwing on an empty feed", () => {
    // Overnight the feed legitimately has zero entities. That is not an error.
    expect(Array.isArray(deps)).toBe(true);
  });

  it("marks everything it returns as live", () => {
    for (const d of deps) expect(d.live).toBe(true);
  });

  it("returns absolute epoch seconds, not service-day offsets", () => {
    // A service-day offset would be < 100000; an epoch is > 1.7e9. Confusing
    // the two silently produces itineraries decades in the past.
    for (const d of deps) expect(d.time).toBeGreaterThan(1_600_000_000);
  });

  it("carries stop sequence so downstream stops can be identified", () => {
    for (const d of deps) expect(d.seq).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/realtime.test.ts`
Expected: FAIL — cannot resolve `../src/data/realtime`.

- [ ] **Step 3: Implement `src/data/realtime.ts`**

```ts
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { GTFS_TRIP_UPDATES_URL, httpGetBytes } from "./passio";
import type { Departure } from "./types";

/** Decode GTFS-RT TripUpdates into flat Departures.
 *
 *  Passio's predictions reach only ~18 minutes ahead and cover only trips
 *  currently running, so this is never the complete picture on its own --
 *  departures.ts merges it with the timetable. */
export function parseTripUpdates(bytes: Uint8Array): Departure[] {
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes);
  const out: Departure[] = [];
  for (const entity of feed.entity) {
    const tu = entity.tripUpdate;
    if (!tu?.trip) continue;
    const tripId = tu.trip.tripId ?? "";
    const routeId = tu.trip.routeId ?? "";
    for (const stu of tu.stopTimeUpdate ?? []) {
      // Prefer departure; fall back to arrival (Passio often sets only one).
      const t = stu.departure?.time ?? stu.arrival?.time;
      if (t === null || t === undefined) continue;
      out.push({
        stopId: stu.stopId ?? "",
        tripId,
        routeId,
        seq: stu.stopSequence ?? 0,
        time: Number(t),        // protobuf int64 arrives as Long|number
        live: true,
      });
    }
  }
  return out;
}

export async function fetchLiveDepartures(): Promise<Departure[]> {
  return parseTripUpdates(await httpGetBytes(GTFS_TRIP_UPDATES_URL));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/realtime.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/data/realtime.ts test/realtime.test.ts
git commit -m "feat: decode GTFS-RT trip updates"
```

---

### Task 5: Merged departure board

**Files:**
- Create: `src/data/departures.ts`
- Test: `test/departures.test.ts`

**Interfaces:**
- Consumes: `StaticFeed`, `Departure`, `DepartureBoard` (Task 2); `parseStaticFeed` (Task 3)
- Produces: `serviceDayStart(now: Date): number`, `scheduledDepartures(feed: StaticFeed, dayStart: number): Departure[]`, `buildBoard(live: Departure[], scheduled: Departure[]): DepartureBoard`

- [ ] **Step 1: Write the failing test `test/departures.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStaticFeed } from "../src/data/gtfs";
import { serviceDayStart, scheduledDepartures, buildBoard } from "../src/data/departures";
import type { Departure } from "../src/data/types";

const feed = parseStaticFeed(new Uint8Array(readFileSync("test/fixtures/gtfs.zip")));

const dep = (o: Partial<Departure>): Departure => ({
  stopId: "S", tripId: "T", routeId: "R", seq: 1, time: 1000, live: false, ...o,
});

describe("serviceDayStart", () => {
  it("returns local midnight, so 25:11:00 lands after 23:00:00 of the same day", () => {
    const noon = new Date(2026, 7, 18, 12, 0, 0);
    const start = serviceDayStart(noon);
    expect(start).toBeLessThanOrEqual(noon.getTime() / 1000);
    expect(noon.getTime() / 1000 - start).toBe(12 * 3600);
  });
});

describe("scheduledDepartures", () => {
  it("produces absolute times from the timetable", () => {
    const start = serviceDayStart(new Date(2026, 7, 18, 12, 0, 0));
    const deps = scheduledDepartures(feed, start);
    expect(deps.length).toBeGreaterThan(100);
    for (const d of deps) {
      expect(d.live).toBe(false);
      expect(d.time).toBeGreaterThan(start);
    }
  });
});

describe("buildBoard", () => {
  it("groups by stop and sorts each list ascending by time", () => {
    const board = buildBoard([], [dep({ stopId: "A", time: 300 }), dep({ stopId: "A", time: 100 })]);
    expect(board.get("A")!.map((d) => d.time)).toEqual([100, 300]);
  });

  it("lets a live prediction replace the scheduled entry for the same trip+stop", () => {
    // The bus is running 4 minutes late. Showing both would offer the user a
    // departure that will not happen.
    const scheduled = dep({ stopId: "A", tripId: "T1", time: 1000, live: false });
    const live = dep({ stopId: "A", tripId: "T1", time: 1240, live: true });
    const board = buildBoard([live], [scheduled]);
    expect(board.get("A")).toHaveLength(1);
    expect(board.get("A")![0]!.time).toBe(1240);
    expect(board.get("A")![0]!.live).toBe(true);
  });

  it("keeps scheduled departures for trips with no live data", () => {
    // Only ~1-2 trips are live at once; the rest of the timetable must survive.
    const board = buildBoard(
      [dep({ stopId: "A", tripId: "T1", time: 1240, live: true })],
      [dep({ stopId: "A", tripId: "T2", time: 1500, live: false })],
    );
    expect(board.get("A")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/departures.test.ts`
Expected: FAIL — cannot resolve `../src/data/departures`.

- [ ] **Step 3: Implement `src/data/departures.ts`**

```ts
import type { StaticFeed, Departure, DepartureBoard } from "./types";

/** Epoch seconds at local midnight of `now`'s day. GTFS times are offsets
 *  from this, which is what lets 25:11:00 stay after 23:00:00. */
export function serviceDayStart(now: Date): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export function scheduledDepartures(feed: StaticFeed, dayStart: number): Departure[] {
  const out: Departure[] = [];
  for (const trip of feed.trips.values()) {
    for (const s of trip.stops) {
      out.push({
        stopId: s.stopId,
        tripId: trip.id,
        routeId: trip.routeId,
        seq: s.seq,
        time: dayStart + s.time,
        live: false,
      });
    }
  }
  return out;
}

/** Merge live predictions over the timetable, grouped by stop.
 *  A live entry supersedes the scheduled entry for the same (tripId, stopId). */
export function buildBoard(live: Departure[], scheduled: Departure[]): DepartureBoard {
  const key = (d: Departure) => `${d.tripId}|${d.stopId}`;
  const superseded = new Set(live.map(key));
  const board: DepartureBoard = new Map();
  for (const d of [...live, ...scheduled]) {
    if (!d.live && superseded.has(key(d))) continue;
    if (!board.has(d.stopId)) board.set(d.stopId, []);
    board.get(d.stopId)!.push(d);
  }
  for (const list of board.values()) list.sort((a, b) => a.time - b.time);
  return board;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/departures.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/data/departures.ts test/departures.test.ts
git commit -m "feat: merge live and scheduled departures"
```

---

### Task 6: Walking times

**Files:**
- Create: `src/routing/walk.ts`
- Test: `test/walk.test.ts`

**Interfaces:**
- Consumes: `LatLng`, `Stop` (Task 2)
- Produces: `haversineMeters(a: LatLng, b: LatLng): number`, `nearestStops(from: LatLng, stops: Stop[], k: number): Stop[]`, `walkMatrix(from: LatLng, to: Stop[]): Promise<Map<string, number>>`, `walkGeometry(from: LatLng, to: LatLng): Promise<LatLng[]>`

- [ ] **Step 1: Write the failing test `test/walk.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { haversineMeters, nearestStops } from "../src/routing/walk";
import type { Stop } from "../src/data/types";

const s = (id: string, lat: number, lng: number): Stop => ({ id, name: id, lat, lng });

describe("haversineMeters", () => {
  it("measures a known campus distance within 5%", () => {
    // John Hay Library -> South Street Landing, ~1.16 km straight line.
    const d = haversineMeters({ lat: 41.826195, lng: -71.404656 }, { lat: 41.817892, lng: -71.406899 });
    expect(d).toBeGreaterThan(900);
    expect(d).toBeLessThan(1100);
  });

  it("is zero for identical points", () => {
    expect(haversineMeters({ lat: 41.8, lng: -71.4 }, { lat: 41.8, lng: -71.4 })).toBe(0);
  });
});

describe("nearestStops", () => {
  const stops = [s("far", 41.90, -71.40), s("near", 41.8262, -71.4047), s("mid", 41.84, -71.40)];

  it("returns the k closest, closest first", () => {
    const got = nearestStops({ lat: 41.826195, lng: -71.404656 }, stops, 2);
    expect(got.map((x) => x.id)).toEqual(["near", "mid"]);
  });

  it("returns everything when k exceeds the stop count", () => {
    expect(nearestStops({ lat: 41.826, lng: -71.404 }, stops, 99)).toHaveLength(3);
  });

  it("returns empty for no stops rather than throwing", () => {
    // Happens when the feed fails to load; the UI must degrade, not crash.
    expect(nearestStops({ lat: 41.8, lng: -71.4 }, [], 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/walk.test.ts`
Expected: FAIL — cannot resolve `../src/routing/walk`.

- [ ] **Step 3: Implement `src/routing/walk.ts`**

```ts
import type { LatLng, Stop } from "../data/types";

const VALHALLA = "https://valhalla1.openstreetmap.de";

/** Great-circle distance in metres. Used ONLY to pre-select candidate stops
 *  before asking Valhalla for real walking times -- never as a walking
 *  estimate itself. College Hill is steep enough that straight-line distance
 *  badly misreports uphill walking time. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** The k nearest stops by straight-line distance, closest first.
 *  51 of 70 stops fall within a 10-minute walk of central campus, so asking
 *  Valhalla about all of them would be wasteful; k=8 covers every realistic
 *  boarding choice. */
export function nearestStops(from: LatLng, stops: Stop[], k: number): Stop[] {
  return [...stops]
    .map((s) => ({ s, d: haversineMeters(from, s) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, k)
    .map((x) => x.s);
}

/** Real pedestrian walking seconds from one point to many stops, in ONE call.
 *
 *  Valhalla is used rather than OSRM's public demo: that server has no foot
 *  profile loaded and silently answers pedestrian queries with car routing
 *  (2.1km in 176s = 42km/h) while still returning code "Ok". */
export async function walkMatrix(from: LatLng, to: Stop[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (to.length === 0) return out;
  const res = await fetch(`${VALHALLA}/sources_to_targets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sources: [{ lat: from.lat, lon: from.lng }],
      targets: to.map((s) => ({ lat: s.lat, lon: s.lng })),
      costing: "pedestrian",
    }),
  });
  if (!res.ok) throw new Error(`valhalla matrix -> HTTP ${res.status}`);
  const data = await res.json();
  const row = data?.sources_to_targets?.[0] ?? [];
  row.forEach((cell: { time?: number }, i: number) => {
    const stop = to[i];
    if (stop && typeof cell?.time === "number") out.set(stop.id, cell.time);
  });
  return out;
}

/** Sidewalk-following polyline for drawing one walking leg. */
export async function walkGeometry(from: LatLng, to: LatLng): Promise<LatLng[]> {
  const res = await fetch(`${VALHALLA}/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      locations: [
        { lat: from.lat, lon: from.lng },
        { lat: to.lat, lon: to.lng },
      ],
      costing: "pedestrian",
    }),
  });
  if (!res.ok) throw new Error(`valhalla route -> HTTP ${res.status}`);
  const data = await res.json();
  const shape: string | undefined = data?.trip?.legs?.[0]?.shape;
  return shape ? decodePolyline6(shape) : [];
}

/** Valhalla encodes shapes as Google polyline at precision 6, not the
 *  usual 5. Decoding at precision 5 puts the path in the wrong hemisphere. */
export function decodePolyline6(str: string): LatLng[] {
  const out: LatLng[] = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    let shift = 0, result = 0, byte: number;
    do { byte = str.charCodeAt(i++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { byte = str.charCodeAt(i++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    out.push({ lat: lat / 1e6, lng: lng / 1e6 });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/walk.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/routing/walk.ts test/walk.test.ts
git commit -m "feat: pedestrian walking times via Valhalla"
```

---

### Task 7: The earliest-arrival ranker

This is the core. It is a pure function: no fetch, no clock, no globals. Everything it needs arrives as an argument, which is what makes the failure modes testable.

**Files:**
- Create: `src/routing/plan.ts`
- Test: `test/plan.test.ts`

**Interfaces:**
- Consumes: `StaticFeed`, `DepartureBoard`, `Itinerary`, `LatLng`, `Stop` (Task 2)
- Produces: `planTrips(opts: PlanOptions): Itinerary[]` where
  `PlanOptions = { feed: StaticFeed; board: DepartureBoard; origin: LatLng; destination: LatLng; walkFromOrigin: Map<string, number>; walkToDestination: Map<string, number>; now: number; maxResults?: number }`

- [ ] **Step 1: Write the failing test `test/plan.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { planTrips } from "../src/routing/plan";
import type { StaticFeed, DepartureBoard, Departure, Trip, Stop } from "../src/data/types";

const NOW = 1_700_000_000;
const ORIGIN = { lat: 41.8262, lng: -71.4047 };
const DEST = { lat: 41.8179, lng: -71.4069 };

/** Two stops on one trip: A (seq 1) then B (seq 2), ten minutes apart. */
function fixture(departAt: number, live = false) {
  const stops = new Map<string, Stop>([
    ["A", { id: "A", name: "A", lat: 41.8262, lng: -71.4047 }],
    ["B", { id: "B", name: "B", lat: 41.8179, lng: -71.4069 }],
  ]);
  const trip: Trip = {
    id: "T1", routeId: "R1",
    stops: [
      { stopId: "A", seq: 1, time: 0 },
      { stopId: "B", seq: 2, time: 600 },
    ],
  };
  const feed: StaticFeed = {
    routes: new Map([["R1", { id: "R1", name: "Route 1", shortName: "1", color: "#347f3d", shape: [] }]]),
    stops, trips: new Map([["T1", trip]]), feedEndDate: "20991231",
  };
  const d = (stopId: string, seq: number, time: number): Departure =>
    ({ stopId, tripId: "T1", routeId: "R1", seq, time, live });
  const board: DepartureBoard = new Map([
    ["A", [d("A", 1, departAt)]],
    ["B", [d("B", 2, departAt + 600)]],
  ]);
  return { feed, board };
}

const base = (extra: object = {}) => ({
  origin: ORIGIN, destination: DEST, now: NOW,
  walkFromOrigin: new Map([["A", 120]]),
  walkToDestination: new Map([["B", 180]]),
  ...extra,
});

describe("planTrips", () => {
  it("ranks by arrival at the destination, not by ride length", () => {
    // THE core requirement. A slow bus leaving now can beat a fast bus later.
    const { feed, stops } = { ...fixture(NOW + 300), stops: null } as never;
    const f = fixture(NOW + 300);
    const slowEarly = planTrips({ feed: f.feed, board: f.board, ...base() });
    expect(slowEarly).toHaveLength(1);
    expect(slowEarly[0]!.arriveTime).toBe(NOW + 300 + 600 + 180);
  });

  it("excludes a bus that leaves before the user can physically walk there", () => {
    // 120s walk, bus leaves in 60s. Offering it would send the user running
    // for a bus that is already gone -- the single worst failure this can have.
    const f = fixture(NOW + 60);
    expect(planTrips({ feed: f.feed, board: f.board, ...base() })).toHaveLength(0);
  });

  it("includes a bus that leaves exactly when the user arrives", () => {
    const f = fixture(NOW + 120);
    expect(planTrips({ feed: f.feed, board: f.board, ...base() })).toHaveLength(1);
  });

  it("never rides backwards along a trip", () => {
    // Boarding at B (seq 2) cannot reach A (seq 1) on the same trip.
    const f = fixture(NOW + 300);
    const got = planTrips({
      feed: f.feed, board: f.board, ...base({
        walkFromOrigin: new Map([["B", 60]]),
        walkToDestination: new Map([["A", 60]]),
      }),
    });
    expect(got).toHaveLength(0);
  });

  it("returns empty when nothing is running instead of throwing", () => {
    // Overnight, and any time the RT feed is empty. Must degrade quietly.
    const f = fixture(NOW + 300);
    expect(planTrips({ feed: f.feed, board: new Map(), ...base() })).toEqual([]);
  });

  it("returns empty when no stop is reachable on foot", () => {
    const f = fixture(NOW + 300);
    expect(planTrips({
      feed: f.feed, board: f.board, ...base({ walkFromOrigin: new Map() }),
    })).toEqual([]);
  });

  it("reports total walking time across both legs", () => {
    const f = fixture(NOW + 300);
    expect(planTrips({ feed: f.feed, board: f.board, ...base() })[0]!.totalWalkSeconds).toBe(300);
  });

  it("flags an itinerary as not fully live when it rests on the timetable", () => {
    // The UI must not present a scheduled guess with the same confidence as a
    // real-time prediction.
    const f = fixture(NOW + 300, false);
    expect(planTrips({ feed: f.feed, board: f.board, ...base() })[0]!.allLive).toBe(false);
  });

  it("keeps only the best departure per route rather than every later bus", () => {
    const f = fixture(NOW + 300);
    // Add a second, later trip on the same route.
    const later = { stopId: "A", tripId: "T2", routeId: "R1", seq: 1, time: NOW + 900, live: false };
    const laterB = { stopId: "B", tripId: "T2", routeId: "R1", seq: 2, time: NOW + 1500, live: false };
    f.feed.trips.set("T2", {
      id: "T2", routeId: "R1",
      stops: [{ stopId: "A", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 600 }],
    });
    f.board.get("A")!.push(later);
    f.board.get("B")!.push(laterB);
    const got = planTrips({ feed: f.feed, board: f.board, ...base() });
    expect(got).toHaveLength(1);
    expect(got[0]!.arriveTime).toBe(NOW + 300 + 600 + 180);
  });

  it("sorts multiple routes by arrival time ascending", () => {
    const f = fixture(NOW + 300);
    f.feed.routes.set("R2", { id: "R2", name: "Route 2", shortName: "2", color: "#000000", shape: [] });
    f.feed.trips.set("T9", {
      id: "T9", routeId: "R2",
      stops: [{ stopId: "A", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 60 }],
    });
    f.board.get("A")!.push({ stopId: "A", tripId: "T9", routeId: "R2", seq: 1, time: NOW + 240, live: true });
    f.board.get("B")!.push({ stopId: "B", tripId: "T9", routeId: "R2", seq: 2, time: NOW + 300, live: true });
    const got = planTrips({ feed: f.feed, board: f.board, ...base() });
    expect(got.map((i) => i.arriveTime)).toEqual([...got.map((i) => i.arriveTime)].sort((a, b) => a - b));
    expect(got[0]!.rides[0]!.routeId).toBe("R2");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/plan.test.ts`
Expected: FAIL — cannot resolve `../src/routing/plan`.

- [ ] **Step 3: Implement `src/routing/plan.ts`**

```ts
import type {
  StaticFeed, DepartureBoard, Itinerary, LatLng, RideLeg,
} from "../data/types";

export interface PlanOptions {
  feed: StaticFeed;
  board: DepartureBoard;
  origin: LatLng;
  destination: LatLng;
  /** stopId -> walking seconds from the origin. Already pruned to k nearest. */
  walkFromOrigin: Map<string, number>;
  /** stopId -> walking seconds to the destination. */
  walkToDestination: Map<string, number>;
  now: number;            // epoch seconds
  maxResults?: number;
}

/** Rank single-shuttle itineraries by arrival time at the destination.
 *
 *  Earliest ARRIVAL, not shortest ride: a slower bus leaving now routinely
 *  beats an express leaving in fifteen minutes, and the rider only cares when
 *  they get there.
 *
 *  Pure by construction -- no fetch, no Date.now(). Every input is an argument
 *  so the ranking logic is testable without the network.
 *
 *  ponytail: single-ride only; transfers.ts layers a second round on top. */
export function planTrips(opts: PlanOptions): Itinerary[] {
  const { feed, board, origin, destination, walkFromOrigin, walkToDestination, now } = opts;
  const maxResults = opts.maxResults ?? 5;

  const found: Itinerary[] = [];

  for (const [boardStopId, walkSecs] of walkFromOrigin) {
    const readyAt = now + walkSecs;
    const boardStop = feed.stops.get(boardStopId);
    if (!boardStop) continue;

    for (const dep of board.get(boardStopId) ?? []) {
      // Cannot board a bus that leaves before you can get there on foot.
      if (dep.time < readyAt) continue;

      const trip = feed.trips.get(dep.tripId);
      if (!trip) continue;

      for (const alight of trip.stops) {
        // Strictly downstream. stop_sequence is monotonic in both the static
        // feed and Passio's RT updates, so this comparison is sound.
        if (alight.seq <= dep.seq) continue;

        const finalWalk = walkToDestination.get(alight.stopId);
        if (finalWalk === undefined) continue;

        const alightStop = feed.stops.get(alight.stopId);
        if (!alightStop) continue;

        // Ride duration from the timetable's own stop-to-stop offsets, applied
        // to the actual (possibly live, possibly late) departure time.
        const boardSched = trip.stops.find((s) => s.seq === dep.seq);
        if (!boardSched) continue;
        const rideSecs = alight.time - boardSched.time;
        if (rideSecs <= 0) continue;

        const arriveStop = dep.time + rideSecs;
        const ride: RideLeg = {
          routeId: dep.routeId,
          tripId: dep.tripId,
          boardStopId,
          alightStopId: alight.stopId,
          departTime: dep.time,
          arriveTime: arriveStop,
          live: dep.live,
          numStops: alight.seq - dep.seq,
        };

        found.push({
          arriveTime: arriveStop + finalWalk,
          departTime: dep.time - walkSecs,
          walkToStop: { from: origin, to: boardStop, seconds: walkSecs },
          rides: [ride],
          walkFromStop: { from: alightStop, to: destination, seconds: finalWalk },
          totalWalkSeconds: walkSecs + finalWalk,
          transfers: 0,
          allLive: dep.live,
        });
      }
    }
  }

  // One suggestion per route: riders choose between routes, not between the
  // 3pm and 3:20pm bus on the same route.
  const bestByRoute = new Map<string, Itinerary>();
  for (const it of found) {
    const key = it.rides[0]!.routeId;
    const prev = bestByRoute.get(key);
    if (!prev || it.arriveTime < prev.arriveTime) bestByRoute.set(key, it);
  }

  return [...bestByRoute.values()]
    .sort((a, b) =>
      a.arriveTime - b.arriveTime ||
      a.totalWalkSeconds - b.totalWalkSeconds ||
      a.transfers - b.transfers)
    .slice(0, maxResults);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/plan.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all files PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routing/plan.ts test/plan.test.ts
git commit -m "feat: earliest-arrival itinerary ranker"
```

---

### Task 8: End-to-end wiring against real data

Proves the pieces compose against the live feeds, and gives a command that answers the actual question from a terminal before any UI exists.

**Files:**
- Create: `src/routing/trip.ts`
- Create: `scripts/plan-demo.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `findItineraries(origin: LatLng, destination: LatLng, now?: Date): Promise<Itinerary[]>`

- [ ] **Step 1: Implement `src/routing/trip.ts`**

```ts
import { fetchStaticFeed } from "../data/gtfs";
import { fetchLiveDepartures } from "../data/realtime";
import { serviceDayStart, scheduledDepartures, buildBoard } from "../data/departures";
import { nearestStops, walkMatrix } from "./walk";
import { planTrips } from "./plan";
import type { LatLng, Itinerary, StaticFeed } from "../data/types";

const CANDIDATE_STOPS = 8;
let cachedFeed: StaticFeed | null = null;

/** Fetch everything needed and rank itineraries. One Valhalla call per end,
 *  one RT fetch, and the GTFS zip only on the first call. */
export async function findItineraries(
  origin: LatLng,
  destination: LatLng,
  now: Date = new Date(),
): Promise<Itinerary[]> {
  cachedFeed ??= await fetchStaticFeed();
  const feed = cachedFeed;
  const allStops = [...feed.stops.values()];

  const originStops = nearestStops(origin, allStops, CANDIDATE_STOPS);
  const destStops = nearestStops(destination, allStops, CANDIDATE_STOPS);

  const [live, walkFromOrigin, walkToDestination] = await Promise.all([
    fetchLiveDepartures().catch(() => []),   // RT is optional; timetable still works
    walkMatrix(origin, originStops),
    walkMatrix(destination, destStops),      // symmetric enough for pedestrians
  ]);

  const board = buildBoard(live, scheduledDepartures(feed, serviceDayStart(now)));
  return planTrips({
    feed, board, origin, destination,
    walkFromOrigin, walkToDestination,
    now: Math.floor(now.getTime() / 1000),
  });
}
```

- [ ] **Step 2: Implement `scripts/plan-demo.ts`**

```ts
/** Terminal proof that objective 1 works end to end, before any UI exists.
 *  Usage: npx tsx scripts/plan-demo.ts [fromLat,fromLng] [toLat,toLng] */
import { findItineraries } from "../src/routing/trip";

const parse = (s: string | undefined, fallback: { lat: number; lng: number }) => {
  if (!s) return fallback;
  const [lat, lng] = s.split(",").map(Number);
  return { lat: lat!, lng: lng! };
};

const from = parse(process.argv[2], { lat: 41.826195, lng: -71.404656 }); // John Hay Library
const to = parse(process.argv[3], { lat: 41.817892, lng: -71.406899 });   // South Street Landing

const fmt = (t: number) =>
  new Date(t * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const mins = (s: number) => `${Math.round(s / 60)} min`;

const its = await findItineraries(from, to);
if (its.length === 0) {
  console.log("No itineraries. No shuttle is running that connects these points right now.");
} else {
  console.log(`${its.length} option(s), earliest arrival first:\n`);
  for (const it of its) {
    const r = it.rides[0]!;
    console.log(`  arrive ${fmt(it.arriveTime)}  (leave now, ${mins(it.totalWalkSeconds)} walking)`);
    console.log(`    walk ${mins(it.walkToStop.seconds)} -> board ${r.boardStopId} at ${fmt(r.departTime)}`);
    console.log(`    ride route ${r.routeId}, ${r.numStops} stops${r.live ? " (live)" : " (scheduled)"}`);
    console.log(`    alight ${r.alightStopId} at ${fmt(r.arriveTime)} -> walk ${mins(it.walkFromStop.seconds)}\n`);
  }
}
```

- [ ] **Step 3: Run it against live data**

```bash
npm i -D tsx && npx tsx scripts/plan-demo.ts
```

Expected: either ranked itineraries with real clock times, or the explicit "No itineraries" message overnight. Both are correct outcomes; a crash is not.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routing/trip.ts scripts/plan-demo.ts package.json
git commit -m "feat: end-to-end itinerary search against live feeds"
```

---

### Task 9: Transfers (objective 2)

**Files:**
- Create: `src/routing/transfers.ts`
- Modify: `src/routing/plan.ts` — call the transfer round when single-ride results are thin
- Test: `test/transfers.test.ts`

**Interfaces:**
- Consumes: `planTrips` internals, `DepartureBoard`, `StaticFeed`
- Produces: `planWithTransfers(opts: PlanOptions & { maxTransfers?: number }): Itinerary[]`

- [ ] **Step 1: Write the failing test `test/transfers.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { planWithTransfers } from "../src/routing/transfers";
import type { StaticFeed, DepartureBoard, Stop, Trip } from "../src/data/types";

const NOW = 1_700_000_000;

/** A->X on route R1, then X->B on route R2. No single ride reaches B. */
function twoLegFixture() {
  const mk = (id: string, lat: number, lng: number): Stop => ({ id, name: id, lat, lng });
  const stops = new Map<string, Stop>([
    ["A", mk("A", 41.830, -71.400)],
    ["X", mk("X", 41.825, -71.404)],
    ["B", mk("B", 41.818, -71.407)],
  ]);
  const t1: Trip = { id: "T1", routeId: "R1", stops: [
    { stopId: "A", seq: 1, time: 0 }, { stopId: "X", seq: 2, time: 300 }] };
  const t2: Trip = { id: "T2", routeId: "R2", stops: [
    { stopId: "X", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 300 }] };
  const feed: StaticFeed = {
    routes: new Map([
      ["R1", { id: "R1", name: "R1", shortName: "1", color: "#111111", shape: [] }],
      ["R2", { id: "R2", name: "R2", shortName: "2", color: "#222222", shape: [] }],
    ]),
    stops, trips: new Map([["T1", t1], ["T2", t2]]), feedEndDate: "20991231",
  };
  const board: DepartureBoard = new Map([
    ["A", [{ stopId: "A", tripId: "T1", routeId: "R1", seq: 1, time: NOW + 120, live: false }]],
    ["X", [{ stopId: "X", tripId: "T2", routeId: "R2", seq: 1, time: NOW + 600, live: false }]],
    ["B", [{ stopId: "B", tripId: "T2", routeId: "R2", seq: 2, time: NOW + 900, live: false }]],
  ]);
  return { feed, board };
}

const opts = (f: ReturnType<typeof twoLegFixture>) => ({
  feed: f.feed, board: f.board,
  origin: { lat: 41.830, lng: -71.400 }, destination: { lat: 41.818, lng: -71.407 },
  walkFromOrigin: new Map([["A", 60]]),
  walkToDestination: new Map([["B", 60]]),
  now: NOW,
});

describe("planWithTransfers", () => {
  it("finds a two-ride trip when no single ride connects origin to destination", () => {
    const f = twoLegFixture();
    const got = planWithTransfers(opts(f));
    expect(got.length).toBeGreaterThan(0);
    expect(got[0]!.transfers).toBe(1);
    expect(got[0]!.rides.map((r) => r.routeId)).toEqual(["R1", "R2"]);
  });

  it("does not offer a transfer the rider cannot physically make", () => {
    // First bus reaches X at NOW+420; make the connection leave at NOW+300.
    const f = twoLegFixture();
    f.board.set("X", [{ stopId: "X", tripId: "T2", routeId: "R2", seq: 1, time: NOW + 300, live: false }]);
    expect(planWithTransfers(opts(f))).toHaveLength(0);
  });

  it("prefers a single ride over a transfer that arrives no earlier", () => {
    // Riders dislike transfers; only offer one when it genuinely arrives sooner.
    const f = twoLegFixture();
    f.feed.trips.set("T3", { id: "T3", routeId: "R3", stops: [
      { stopId: "A", seq: 1, time: 0 }, { stopId: "B", seq: 2, time: 600 }] });
    f.feed.routes.set("R3", { id: "R3", name: "R3", shortName: "3", color: "#333333", shape: [] });
    f.board.get("A")!.push({ stopId: "A", tripId: "T3", routeId: "R3", seq: 1, time: NOW + 120, live: false });
    f.board.get("B")!.push({ stopId: "B", tripId: "T3", routeId: "R3", seq: 2, time: NOW + 720, live: false });
    const got = planWithTransfers(opts(f));
    expect(got[0]!.transfers).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/transfers.test.ts`
Expected: FAIL — cannot resolve `../src/routing/transfers`.

- [ ] **Step 3: Implement `src/routing/transfers.ts`**

Two-round earliest-arrival. Round 1 is `planTrips` unchanged. Round 2 treats every stop reachable in round 1 as a new origin whose "walk time" is zero and whose earliest-departure floor is the round-1 arrival plus `MIN_TRANSFER_SECONDS`.

```ts
import { planTrips, type PlanOptions } from "./plan";
import type { Itinerary, RideLeg } from "../data/types";

/** Slack for stepping off one bus and boarding another at the same stop.
 *  ponytail: flat constant; make it per-stop if a stop turns out to need it. */
const MIN_TRANSFER_SECONDS = 60;

export function planWithTransfers(
  opts: PlanOptions & { maxTransfers?: number },
): Itinerary[] {
  const direct = planTrips(opts);
  const maxTransfers = opts.maxTransfers ?? 1;
  if (maxTransfers < 1) return direct;

  const { feed, board, now } = opts;
  const twoLeg: Itinerary[] = [];

  // Every stop any first bus can reach becomes a candidate transfer point.
  for (const [firstStopId, walkSecs] of opts.walkFromOrigin) {
    const readyAt = now + walkSecs;
    const boardStop = feed.stops.get(firstStopId);
    if (!boardStop) continue;

    for (const dep of board.get(firstStopId) ?? []) {
      if (dep.time < readyAt) continue;
      const trip1 = feed.trips.get(dep.tripId);
      if (!trip1) continue;
      const boardSched = trip1.stops.find((s) => s.seq === dep.seq);
      if (!boardSched) continue;

      for (const mid of trip1.stops) {
        if (mid.seq <= dep.seq) continue;
        // Already covered by a direct ride; a transfer here is pointless.
        if (opts.walkToDestination.has(mid.stopId)) continue;

        const arriveMid = dep.time + (mid.time - boardSched.time);
        const midStop = feed.stops.get(mid.stopId);
        if (!midStop) continue;

        // Second leg: anything leaving this stop after the transfer slack.
        const second = planTrips({
          ...opts,
          origin: midStop,
          walkFromOrigin: new Map([[mid.stopId, 0]]),
          now: arriveMid + MIN_TRANSFER_SECONDS,
          maxResults: 1,
        });
        const best = second[0];
        if (!best) continue;
        if (best.rides[0]!.routeId === dep.routeId) continue;  // same route isn't a transfer

        const leg1: RideLeg = {
          routeId: dep.routeId, tripId: dep.tripId,
          boardStopId: firstStopId, alightStopId: mid.stopId,
          departTime: dep.time, arriveTime: arriveMid,
          live: dep.live, numStops: mid.seq - dep.seq,
        };

        twoLeg.push({
          arriveTime: best.arriveTime,
          departTime: dep.time - walkSecs,
          walkToStop: { from: opts.origin, to: boardStop, seconds: walkSecs },
          rides: [leg1, ...best.rides],
          walkFromStop: best.walkFromStop,
          totalWalkSeconds: walkSecs + best.walkFromStop.seconds,
          transfers: 1,
          allLive: dep.live && best.allLive,
        });
      }
    }
  }

  const bestDirect = direct[0];
  // Only surface a transfer that genuinely arrives earlier than riding straight.
  const worthwhile = twoLeg.filter((t) => !bestDirect || t.arriveTime < bestDirect.arriveTime);

  return [...direct, ...worthwhile]
    .sort((a, b) =>
      a.arriveTime - b.arriveTime ||
      a.transfers - b.transfers ||
      a.totalWalkSeconds - b.totalWalkSeconds)
    .slice(0, opts.maxResults ?? 5);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/transfers.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, all files.

- [ ] **Step 6: Commit**

```bash
git add src/routing/transfers.ts test/transfers.test.ts
git commit -m "feat: two-leg transfer itineraries"
```

---

## Self-Review

**Spec coverage.** Objective 1 (earliest-ETA routing from anywhere to anywhere, walking included) → Tasks 2–8. Objective 2 (multi-shuttle) → Task 9. Objective 3 (Apple-Maps-style UI) → deliberately **not** in this plan; it is a separate plan written after `superpowers:brainstorming`, because the UX has open design questions this plan should not pre-empt.

**Known gaps, accepted deliberately:**
- Ride duration uses the timetable's stop-to-stop offsets applied to the live departure time, rather than per-stop live predictions for downstream stops. Passio's RT feed does carry downstream predictions; using them is a refinement worth making once the ranker is proven correct.
- `walkToDestination` is computed from the destination outward, treating pedestrian walking as symmetric. Valhalla's pedestrian costing is very close to symmetric; elevation asymmetry on College Hill is the known exception and is not modeled.
- Daytime Express has one static trip and Stadium Loop has none, so outside live-prediction range those routes will be absent from results. That is a data limitation upstream, not a bug to fix here — surface it in the UI rather than papering over it.

**Placeholder scan:** none. Every step has runnable content.

**Type consistency:** `planTrips`/`PlanOptions` used identically in Tasks 7, 8, 9. `Itinerary.rides` is `RideLeg[]` throughout. `walkFromOrigin`/`walkToDestination` keep their names across all three.
