import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStaticFeed } from "../src/data/gtfs";
import { parseRoutePaths, fillMissingShapes } from "../src/data/routePaths";
import { laneProfiles, applyLanes, DEFAULT_OPTIONS, type Line, type Pt } from "../src/render/bundle";

/**
 * The squiggle, pinned in the units a rider sees it in.
 *
 * This defect outlived a dozen attempts because every measure taken of it was
 * in metres, and the offsets that cause it are in device PIXELS -- so a number
 * could improve while the map got worse, and three separate proxies I invented
 * counted a successful merge as a defect, since merged points coincide. What
 * finally worked was measuring the drawn line against its own source polyline,
 * by geometry rather than by index, at the zoom the app actually opens at.
 *
 * So it lives here now. Anything that moves the bundler or the map's pixel
 * constants fails this rather than getting argued about from a screenshot.
 */

// The map's own constants. Duplicated rather than exported because importing
// TransitMap drags MapLibre into a node test; network.test.ts does the same
// with the projection. If these change there, change them here.
const LANE_GAP_PX = 5;
const CORNER_RADIUS_PX = 10;
const LANE_HOLD_PX = 80;
/** A phone opening the app fits the whole network and lands about here. */
const OPENING_ZOOM = 14.2;

const feed = fillMissingShapes(
  parseStaticFeed(new Uint8Array(readFileSync("public/gtfs/google_transit.zip"))),
  parseRoutePaths(JSON.parse(readFileSync("test/fixtures/route-paths.json", "utf8"))));
const ACTIVE = new Set(["3302", "3469", "3470", "22427", "62487"]);

const M_PER_DEG_LAT = 111_320;
const mPerDegLng = M_PER_DEG_LAT * Math.cos((41.8265 * Math.PI) / 180);
const toPlane = (p: { lat: number; lng: number }): Pt =>
  ({ x: p.lng * mPerDegLng, y: p.lat * M_PER_DEG_LAT });
const mpp = (156_543.03392 * Math.cos((41.8265 * Math.PI) / 180)) / 2 ** OPENING_ZOOM;

/** Signed perpendicular offset of a drawn point from its own source line, in
 *  PIXELS. Found against the nearest segment -- never by index, which breaks
 *  the moment the drawn line gains or loses a vertex. */
function offsetPx(d: Pt, path: Pt[]): number {
  let best = Infinity, sign = 1;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!;
    const vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy;
    if (!L2) continue;
    let t = ((d.x - a.x) * vx + (d.y - a.y) * vy) / L2;
    t = Math.max(0, Math.min(1, t));
    const dist = Math.hypot(d.x - (a.x + t * vx), d.y - (a.y + t * vy));
    if (dist < best) { best = dist; sign = Math.sign(vx * (d.y - a.y) - vy * (d.x - a.x)) || 1; }
  }
  return (best * sign) / mpp;
}

function measure(routeId: string): { wigglesPer1000: number; offStreetPx: number } {
  const lines: Line[] = [...feed.routes.values()]
    .filter((r) => ACTIVE.has(r.id) && r.shape.length >= 2)
    .map((r) => ({ id: r.id, points: r.shape.map(toPlane) }));
  const hold = Math.round((LANE_HOLD_PX * mpp) / DEFAULT_OPTIONS.stepM);
  const p = laneProfiles(lines, DEFAULT_OPTIONS).find((x) => x.id === routeId)!;
  const drawn = applyLanes(p, LANE_GAP_PX * mpp, CORNER_RADIUS_PX * mpp, hold);

  const off = drawn.map((q) => offsetPx(q, p.path));
  let lenPx = 0;
  for (let i = 1; i < drawn.length; i++)
    lenPx += Math.hypot(drawn[i]!.x - drawn[i - 1]!.x, drawn[i]!.y - drawn[i - 1]!.y) / mpp;

  // A wiggle is the sideways offset turning back on itself by more than 1.5
  // pixels -- the smallest jog that shows on a line drawn six wide.
  let wiggles = 0, run = off[0]!, dir = 0;
  for (let i = 1; i < off.length; i++) {
    const delta = off[i]! - run;
    if (dir === 0) { if (Math.abs(delta) > 0.2) dir = Math.sign(delta); continue; }
    if (Math.sign(delta) === dir) { run = off[i]!; continue; }
    if (Math.abs(delta) > 1.5) { wiggles++; dir = -dir; run = off[i]!; }
  }
  return {
    wigglesPer1000: (1000 * wiggles) / lenPx,
    offStreetPx: Math.max(...off.map(Math.abs)),
  };
}

describe("routes drawn at the zoom the app opens at", () => {
  // Measured at the renderer-checkpoint tag. Caps sit above those readings
  // with room for honest movement, and far below what the map looked like
  // before: 8.4, 8.6, 25.6, 18.3 and 23.0 reversals per 1000px.
  const CAPS: Record<string, { wiggles: number; offStreet: number }> = {
    "22427": { wiggles: 2, offStreet: 2 },     // measured 0.0 / 0.1
    "62487": { wiggles: 5, offStreet: 4 },     // measured 2.4 / 2.6
    "3302": { wiggles: 5, offStreet: 4 },      // measured 2.0 / 2.2
    "3470": { wiggles: 5, offStreet: 6 },      // measured 1.7 / 4.8
    // Evening CW keeps one real 5px step near Brook/Power, where a third route
    // leaves the bundle and the remaining lanes close ranks. That is a
    // sustained change, so the hold cannot remove it, and closing ranks is
    // defensible. Capped where it is so it cannot quietly get worse.
    "3469": { wiggles: 16, offStreet: 6 },     // measured 14.1 / 5.1
  };

  for (const [routeId, cap] of Object.entries(CAPS)) {
    it(`${routeId} stays straight enough to read`, () => {
      const { wigglesPer1000, offStreetPx } = measure(routeId);
      expect(wigglesPer1000).toBeLessThanOrEqual(cap.wiggles);
      // Straightness bought by shoving the line off its street is not a win,
      // so both are pinned. The fix that earned these numbers improved BOTH.
      expect(offStreetPx).toBeLessThanOrEqual(cap.offStreet);
    });
  }
});
