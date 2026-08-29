/**
 * Snap each route's shape onto the streets it actually runs on.
 *
 * Buses are always on streets, and Passio's shapes are only approximately on
 * them: two routes down one street are traced 7-9m apart, and a route's own
 * outbound and return legs are separate geometry a few metres apart (route
 * 3302 has 230 pairs of its own vertices within 20m, at a median of 9.0m).
 *
 * Everything downstream then has to guess whether two lines are "the same
 * street". The bundler guesses per point, and it wobbles: measured on the
 * shipped feed, route 3302 changes its lane assignment every ~30m, 24 times
 * around one loop. Each change moves the line sideways, which is what the
 * kinks, the acute wedges and the spurs on the map are.
 *
 * Matched to the street network, coincident routes share the SAME geometry
 * rather than a nearly-identical one, so there is nothing left to guess and
 * nothing left to wobble. This runs at build time and its output is committed:
 * OSRM is volunteer-run, and the shapes change about as often as the feed.
 *
 *   npx tsx scripts/match-shapes.ts
 *
 * Every match is checked before it is accepted -- map matching's failure mode
 * is snapping confidently onto the wrong parallel street, which would be worse
 * than the few metres it fixes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseStaticFeed } from "../src/data/gtfs";
import { haversineMeters } from "../src/routing/walk";
import type { LatLng } from "../src/data/types";

const OSRM = "https://routing.openstreetmap.de/routed-car";
/** The public instance refuses more than a handful of trace points at once.
 *  Measured: 10 is accepted, 12 and above come back TooBig -- and a rejection
 *  takes ~9.8s to arrive, which is the throttle talking. */
const CHUNK = 10;
/** Points carried into the next chunk so the seams join up. */
const OVERLAP = 2;
/** How far a trace point may be from the road, in metres. */
const RADIUS = 25;
/** Below this, OSRM is not confident it found the right road. */
const MIN_CONFIDENCE = 0.3;
/** A match that moves the shape further than this has found a different
 *  street, not a better fit for this one. */
const MAX_MOVE_M = 45;
/** Be a good guest: this is someone else's server. */
const PAUSE_MS = 350;
/** Give up on a request rather than hanging on it. A throttled response can
 *  take ten seconds or never arrive; without this the whole run stalls with
 *  nothing printed, which is exactly what it did the first time. */
const TIMEOUT_MS = 15_000;
/** How much longer than its source a matched shape may be. Following the road
 *  properly adds a little; anything beyond this is the shape re-covering
 *  ground, which is what a broken seam looks like. */
const MAX_STRETCH = 1.12;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function matchChunk(pts: LatLng[]): Promise<LatLng[] | null> {
  const coords = pts.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  const radiuses = pts.map(() => RADIUS).join(";");
  const url = `${OSRM}/match/v1/driving/${coords}`
    + `?geometries=geojson&overview=full&tidy=true&radiuses=${radiuses}`;
  const ctl = new AbortController();
  const bell = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: ctl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(bell);
  }
  if (!res.ok) return null;
  const data = await res.json() as {
    code?: string;
    matchings?: { confidence?: number; geometry?: { coordinates?: [number, number][] } }[];
  };
  if (data.code !== "Ok") return null;
  const best = data.matchings?.[0];
  if (!best || (best.confidence ?? 0) < MIN_CONFIDENCE) return null;
  return (best.geometry?.coordinates ?? []).map(([lng, lat]) => ({ lat, lng }));
}

/**
 * Join a chunk onto the route, cutting the ground it has already covered.
 *
 * Chunks overlap by OVERLAP source points on purpose, so a chunk's matched
 * geometry starts some way BEHIND where the previous one ended. The first
 * version of this only skipped points within a metre of the one just appended,
 * which does nothing about an overlap whose points are a few metres from the
 * previous match rather than on top of it -- so every seam re-traversed the
 * overlap and the shape doubled back on itself.
 *
 * That is not a subtle defect. Measured on route 3469's output, turn angle
 * came out with a 90th percentile of 47 degrees and a 99th of 180 -- a full
 * reversal -- against a median of 0.5. Corner rounding then turned those
 * reversals into a visible wobble down Thayer Street rather than into spikes,
 * which is exactly why a "sharp turns" check read clean while the map looked
 * wrong.
 *
 * The cut is made where the new chunk passes closest to the point already
 * reached: everything before that is the overlap, and only what comes after
 * advances the route.
 */
function stitch(into: LatLng[], pts: LatLng[]): void {
  if (pts.length === 0) return;
  if (into.length === 0) { into.push(...pts); return; }

  const last = into[into.length - 1]!;
  let cut = 0, best = Infinity;
  pts.forEach((p, i) => {
    const d = haversineMeters(p, last);
    if (d < best) { best = d; cut = i; }
  });

  for (const p of pts.slice(cut + 1)) {
    const tail = into[into.length - 1]!;
    if (haversineMeters(tail, p) < 1) continue;
    into.push(p);
  }
}

/** Total length of a polyline, metres. */
function pathLength(pts: LatLng[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversineMeters(pts[i - 1]!, pts[i]!);
  return d;
}

/** How far each source point ended up from the matched line. */
function deviation(source: LatLng[], matched: LatLng[]): number[] {
  return source
    .map((p) => Math.min(...matched.map((q) => haversineMeters(p, q))))
    .sort((a, b) => a - b);
}

async function main() {
  const feed = parseStaticFeed(new Uint8Array(readFileSync("public/gtfs/google_transit.zip")));
  const out: Record<string, [number, number][]> = {};
  let kept = 0, rejected = 0;

  for (const route of feed.routes.values()) {
    if (route.shape.length < 2) continue;
    const matched: LatLng[] = [];
    let failedChunks = 0, chunks = 0;

    for (let i = 0; i < route.shape.length - 1; i += CHUNK - OVERLAP) {
      const slice = route.shape.slice(i, i + CHUNK);
      if (slice.length < 2) break;
      chunks++;
      const got = await matchChunk(slice);
      if (got && got.length) stitch(matched, got);
      else { failedChunks++; stitch(matched, slice); }   // keep the source here
      process.stdout.write(got ? "." : "x");
      await sleep(PAUSE_MS);
    }

    process.stdout.write("\n");
    const dev = deviation(route.shape, matched);
    const median = dev[Math.floor(dev.length / 2)] ?? 0;
    const max = dev[dev.length - 1] ?? 0;

    // A shape that re-traverses ground is LONGER than the one it matched.
    // This is the check the first version needed and did not have: the seams
    // were doubling back, every per-point measure looked fine, and the defect
    // only showed up as a wobble on the map. Length cannot be fooled by it.
    const stretch = pathLength(matched) / Math.max(1, pathLength(route.shape));
    const ok = matched.length > route.shape.length / 2
      && max <= MAX_MOVE_M
      && stretch <= MAX_STRETCH;

    console.log(
      `${route.id.padEnd(6)} ${route.name.slice(0, 20).padEnd(22)}` +
      ` src=${String(route.shape.length).padStart(4)} matched=${String(matched.length).padStart(5)}` +
      ` chunks=${chunks} failed=${failedChunks}` +
      ` moved median=${median.toFixed(1)}m max=${max.toFixed(1)}m` +
      ` length=${(stretch * 100).toFixed(0)}%` +
      (ok ? "  KEPT" : "  REJECTED"));

    if (ok) { out[route.id] = matched.map((p) => [p.lng, p.lat]); kept++; }
    else rejected++;
  }

  writeFileSync("public/gtfs/shapes-matched.json", JSON.stringify(out));
  console.log(`\nwrote public/gtfs/shapes-matched.json -- ${kept} kept, ${rejected} rejected`);
}

await main();
