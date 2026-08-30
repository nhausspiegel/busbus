/**
 * Put every route on the centreline of the road it actually drives.
 *
 * The app never knew which road a line was on. Passio ships a polyline traced
 * down one side of the road -- two routes on one street arrive 0-9.5m apart,
 * genuinely different streets 47m+ -- with no road identity, so the renderer
 * guessed "same street" per vertex from proximity and angle. Nine mechanisms
 * existed to survive that guess, and each produced a symptom: a lane gap held
 * in METRES that grew from 3.7px at zoom 13 to 13.5px at zoom 18, a corner
 * radius clamped dead by resampling, apexes cut off inside corners.
 *
 * Supply the road and none of them has a job.
 *
 * Each route is emitted as the sequence of OSM nodes it drives, with every
 * coordinate read from ONE shared table. Two routes down one street therefore
 * traverse the SAME nodes and their geometry is identical -- not close,
 * identical -- so the renderer has nothing left to infer and every pixel
 * between them is one it chose.
 *
 *   npx tsx scripts/snap-to-streets.ts
 *
 * The road network is ONE Overpass request, cached in .cache/. It was first
 * built as ~60 rate-limited OSRM calls for data this app already ships a
 * basemap of -- see rule 0 in CLAUDE.md.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { parseStaticFeed } from "../src/data/gtfs";
import { parseRoutePaths, fillMissingShapes } from "../src/data/routePaths";
import type { LatLng } from "../src/data/types";

/** Drivable ways only. A bus is never on a footway, and letting paths in is how
 *  a route gets snapped onto a pedestrian cut-through beside the road. */
const DRIVABLE = "motorway|trunk|primary|secondary|tertiary|unclassified|"
  + "residential|living_street|service|busway|"
  + "motorway_link|trunk_link|primary_link|secondary_link|tertiary_link";

const ACTIVE = new Set(["3302", "3469", "3470", "22427", "62487"]);

/** Trace resampling. Only sets how often the road is sampled; it does not enter
 *  the output geometry, which is the road's own nodes. */
const STEP_M = 20;
/** Candidate SET bounds. Not arbitration -- the chain constraint below decides
 *  which candidate is right, and 98.8% of transitions resolve by connectivity. */
const NEAR_M = 40;
const PARALLEL_DEG = 40;
/** A gap between consecutive matched ways longer than this is not a junction we
 *  failed to notice, it is a bad match. Reported rather than bridged. */
const BRIDGE_M = 100;

interface Way { id: number; nodes: number[]; pts: LatLng[]; name: string }

const K = 111_320;
const KX = K * Math.cos((41.8265 * Math.PI) / 180);
const xy = (p: LatLng) => ({ x: p.lng * KX, y: p.lat * K });
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(b.x - a.x, b.y - a.y);

function bearing(a: LatLng, b: LatLng): number {
  return (Math.atan2(b.lng - a.lng, b.lat - a.lat) * 180) / Math.PI;
}
function parallel(a: number, b: number): boolean {
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return d <= PARALLEL_DEG;
}
/** Distance from p to the segment a-b, in metres. */
function toSeg(p: LatLng, a: LatLng, b: LatLng): number {
  const P = xy(p), A = xy(a), B = xy(b);
  const vx = B.x - A.x, vy = B.y - A.y, L2 = vx * vx + vy * vy;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((P.x - A.x) * vx + (P.y - A.y) * vy) / L2));
  return Math.hypot(P.x - (A.x + t * vx), P.y - (A.y + t * vy));
}

async function roads(bbox: string): Promise<Way[]> {
  const cache = `.cache/overpass-${bbox.replace(/[,.\-]/g, "_")}.json`;
  if (!existsSync(cache)) {
    const q = `[out:json][timeout:90];way["highway"~"^(${DRIVABLE})$"](${bbox});out geom;`;
    const res = await fetch("https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(q),
      { headers: { "User-Agent": "busbus/0.1 (github.com/nhausspiegel/busbus)" } });
    if (!res.ok) throw new Error(`Overpass -> HTTP ${res.status}`);
    mkdirSync(".cache", { recursive: true });
    writeFileSync(cache, await res.text());
  }
  const d = JSON.parse(readFileSync(cache, "utf8")) as {
    elements?: { type: string; id: number; nodes?: number[];
                 tags?: Record<string, string>;
                 geometry?: { lat: number; lon: number }[] }[];
  };
  return (d.elements ?? [])
    .filter((e) => e.type === "way" && (e.geometry?.length ?? 0) >= 2 && e.nodes)
    .map((e) => ({
      id: e.id,
      nodes: e.nodes!,
      pts: e.geometry!.map((g) => ({ lat: g.lat, lng: g.lon })),
      name: e.tags?.["name"] ?? e.tags?.["highway"] ?? "unnamed",
    }))
    // Geometry and node ids must line up or the emitted ids mean nothing.
    .filter((w) => w.nodes.length === w.pts.length);
}

/** Box drawn from the routes themselves. Hardcoding it once clipped the
 *  Connector's run into the Jewelry District, leaving it no road to match. */
function bboxOf(shapes: LatLng[][], marginM = 400): string {
  const pts = shapes.flat();
  const dLat = marginM / K, dLng = marginM / KX;
  return [Math.min(...pts.map((p) => p.lat)) - dLat, Math.min(...pts.map((p) => p.lng)) - dLng,
          Math.max(...pts.map((p) => p.lat)) + dLat, Math.max(...pts.map((p) => p.lng)) + dLng]
    .map((v) => v.toFixed(5)).join(",");
}

async function main() {
  const feed = fillMissingShapes(
    parseStaticFeed(new Uint8Array(readFileSync("public/gtfs/google_transit.zip"))),
    parseRoutePaths(JSON.parse(readFileSync("test/fixtures/route-paths.json", "utf8"))));
  const routes = [...feed.routes.values()].filter((r) => ACTIVE.has(r.id) && r.shape.length >= 2);

  const bbox = bboxOf(routes.map((r) => r.shape));
  const ways = await roads(bbox);
  console.log(`road network: ${ways.length} ways, ` +
    `${ways.reduce((n, w) => n + w.pts.length, 0)} points (one Overpass request)\n`);

  const byId = new Map(ways.map((w) => [w.id, w]));
  /** ONE table. Shared nodes give byte-identical coordinates, which is the
   *  entire point: coincident routes stop having any separation to inherit. */
  const nodeAt = new Map<number, LatLng>();
  for (const w of ways) w.nodes.forEach((n, i) => { if (!nodeAt.has(n)) nodeAt.set(n, w.pts[i]!); });

  // Road graph, weighted in METRES, for bridging junctions the trace skipped.
  const adj = new Map<number, { to: number; m: number }[]>();
  for (const w of ways)
    for (let i = 1; i < w.nodes.length; i++) {
      const a = w.nodes[i - 1]!, b = w.nodes[i]!;
      const m = dist(xy(w.pts[i - 1]!), xy(w.pts[i]!));
      (adj.get(a) ?? adj.set(a, []).get(a)!).push({ to: b, m });
      (adj.get(b) ?? adj.set(b, []).get(b)!).push({ to: a, m });
    }

  /** Shortest path in metres between two node sets, or null past the cap. */
  function bridge(from: Set<number>, to: Set<number>): number[] | null {
    const best = new Map<number, number>(), prev = new Map<number, number>();
    const queue: { n: number; d: number }[] = [];
    for (const n of from) { best.set(n, 0); queue.push({ n, d: 0 }); }
    while (queue.length) {
      queue.sort((a, b) => a.d - b.d);
      const { n, d } = queue.shift()!;
      if (d > BRIDGE_M) return null;
      if (to.has(n) && d > 0) {
        const path = [n];
        for (let c = n; prev.has(c); c = prev.get(c)!) path.push(prev.get(c)!);
        return path.reverse();
      }
      for (const e of adj.get(n) ?? []) {
        const nd = d + e.m;
        if (nd < (best.get(e.to) ?? Infinity)) {
          best.set(e.to, nd); prev.set(e.to, n); queue.push({ n: e.to, d: nd });
        }
      }
    }
    return null;
  }

  const out: Record<string, number[]> = {};
  for (const route of routes) {
    // 1. Resample the trace, and take the nearest parallel way at each sample.
    const chain: number[] = [];
    for (let i = 1; i < route.shape.length; i++) {
      const a = route.shape[i - 1]!, b = route.shape[i]!;
      const A = xy(a), B = xy(b);
      const steps = Math.max(1, Math.floor(dist(A, B) / STEP_M));
      const br = bearing(a, b);
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const p: LatLng = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
        let best: { id: number; d: number } | null = null;
        for (const w of ways)
          for (let k = 1; k < w.pts.length; k++) {
            const d = toSeg(p, w.pts[k - 1]!, w.pts[k]!);
            if (d > NEAR_M) continue;
            if (!parallel(br, bearing(w.pts[k - 1]!, w.pts[k]!))) continue;
            if (best === null || d < best.d) best = { id: w.id, d };
          }
        // 2. Compress to a chain of ways.
        if (best && chain[chain.length - 1] !== best.id) chain.push(best.id);
      }
    }

    // 3. Repair: consecutive ways must share a node, or be bridged.
    const repaired: { way: number; via?: number[] }[] = [];
    let bridged = 0, unbridged = 0;
    for (let i = 0; i < chain.length; i++) {
      const w = byId.get(chain[i]!)!;
      if (i === 0) { repaired.push({ way: w.id }); continue; }
      const prev = byId.get(chain[i - 1]!)!;
      const shared = prev.nodes.some((n) => w.nodes.includes(n));
      if (shared) { repaired.push({ way: w.id }); continue; }
      const via = bridge(new Set(prev.nodes), new Set(w.nodes));
      if (via) { bridged++; repaired.push({ way: w.id, via }); }
      else { unbridged++; repaired.push({ way: w.id }); }
    }

    // 4. Materialise: traverse each way from the junction entered to the one
    //    left. Backtracking is inexpressible here -- a way is walked once,
    //    between two of its own nodes, in one direction.
    const seq: number[] = [];
    const push = (n: number) => { if (seq[seq.length - 1] !== n) seq.push(n); };
    const start = xy(route.shape[0]!);
    for (let i = 0; i < repaired.length; i++) {
      const w = byId.get(repaired[i]!.way)!;
      const next = repaired[i + 1] ? byId.get(repaired[i + 1]!.way)! : null;

      // Entry: where we already are, or the end nearest the route's start.
      let entry: number;
      if (seq.length) {
        const here = seq[seq.length - 1]!;
        entry = w.nodes.includes(here)
          ? here
          : w.nodes.reduce((bestN, n) =>
              dist(xy(nodeAt.get(n)!), xy(nodeAt.get(here)!))
                < dist(xy(nodeAt.get(bestN)!), xy(nodeAt.get(here)!)) ? n : bestN, w.nodes[0]!);
      } else {
        entry = w.nodes.reduce((bestN, n) =>
          dist(xy(nodeAt.get(n)!), start) < dist(xy(nodeAt.get(bestN)!), start) ? n : bestN,
          w.nodes[0]!);
      }
      // Exit: the junction shared with the next way. For the LAST way there is
      // no junction to aim at, and guessing "the far end" walked whole streets
      // the route never drives -- 555m of invented road on the Evening CW, all
      // of it in the final 20 nodes. The trace's own last point says where the
      // route actually stops.
      const shared = next ? w.nodes.filter((n) => next.nodes.includes(n)) : [];
      const finish = xy(route.shape[route.shape.length - 1]!);
      const exit = shared.length
        ? shared.reduce((bestN, n) =>
            Math.abs(w.nodes.indexOf(n) - w.nodes.indexOf(entry))
              > Math.abs(w.nodes.indexOf(bestN) - w.nodes.indexOf(entry)) ? bestN : n, shared[0]!)
        : w.nodes.reduce((bestN, n) =>
            dist(xy(nodeAt.get(n)!), finish) < dist(xy(nodeAt.get(bestN)!), finish)
              ? n : bestN, w.nodes[0]!);

      const from = w.nodes.indexOf(entry), to = w.nodes.indexOf(exit);
      if (from < 0 || to < 0) continue;
      const stepDir = to >= from ? 1 : -1;
      for (let k = from; k !== to + stepDir; k += stepDir) push(w.nodes[k]!);

      // A bridge belonging to the NEXT way is walked before entering it.
      const via = repaired[i + 1]?.via;
      if (via) for (const n of via) push(n);
    }

    // 5. Close the loop. Every Brown route is one.
    const first = seq[0], last = seq[seq.length - 1];
    if (first !== undefined && last !== undefined && first !== last) {
      const via = bridge(new Set([last]), new Set([first]));
      if (via) for (const n of via) push(n);
    }

    const streets: string[] = [];
    for (const r of repaired) {
      const n = byId.get(r.way)!.name;
      if (streets[streets.length - 1] !== n) streets.push(n);
    }
    const len = seq.slice(1).reduce((t, n, i) =>
      t + dist(xy(nodeAt.get(seq[i]!)!), xy(nodeAt.get(n)!)), 0);
    const trace = route.shape.slice(1).reduce((t, p, i) =>
      t + dist(xy(route.shape[i]!), xy(p)), 0);
    console.log(`${route.id.padEnd(6)} ${route.name.slice(0, 20).padEnd(22)}` +
      ` ways=${String(repaired.length).padStart(3)} nodes=${String(seq.length).padStart(4)}` +
      ` bridged=${bridged} unbridged=${unbridged}` +
      ` length=${(len / 1000).toFixed(2)}km vs trace ${(trace / 1000).toFixed(2)}km` +
      ` (${(len / trace).toFixed(2)}x)`);
    console.log(`       ${streets.join(" -> ")}`);
    out[route.id] = seq;
  }

  const table: Record<string, [number, number]> = {};
  for (const n of new Set(Object.values(out).flat())) {
    const c = nodeAt.get(n)!;
    table[String(n)] = [c.lng, c.lat];
  }
  writeFileSync("public/gtfs/shapes-snapped.json", JSON.stringify({ nodes: table, routes: out }));
  console.log(`\nwrote public/gtfs/shapes-snapped.json -- ` +
    `${Object.keys(out).length} routes, ${Object.keys(table).length} nodes`);
}

await main();
