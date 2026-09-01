/**
 * Draw the junctions, with no map involved.
 *
 *   npx tsx scripts/junction-cases.ts   ->   docs/junction-cases.svg
 *
 * Everything is computed at the true pixel geometry of a given zoom and then
 * magnified -- geometry and stroke together, so the stroke-to-offset ratio,
 * which is the whole subject, is preserved. Re-scaling instead would shrink the
 * defect out of the picture while leaving it on the map.
 *
 * Left:  what ships today. One feature per run of constant lane offset, each
 *        displaced by MapLibre on the GPU. The features cannot be joined, so
 *        every boundary is drawn as two separate strokes -- reproduced here by
 *        stroking each run on its own, exactly as the GPU does.
 * Right: the runs pulled back from the junction, with the connection drawn.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { parseSnapped } from "../src/data/snappedShapes";
import { laneRuns, type LaneRun } from "../src/render/lanes";
import { laneLinks } from "../src/render/links";
import type { LatLng } from "../src/data/types";

const ZOOM = 16;
const STROKE = 4.5;                        // the app's stroke at zoom 16
const GAP = 5;
const CW = 430, CH = 330, MAG = 7;

const K = 111_320, KX = K * Math.cos((41.8265 * Math.PI) / 180);
const MPP = (78_271.51696 * Math.cos((41.8265 * Math.PI) / 180)) / 2 ** ZOOM;

const snapped = parseSnapped(
  JSON.parse(readFileSync("public/gtfs/shapes-snapped.json", "utf8")));

const COLOUR: Record<string, string> = {
  "3302": "#347F3D", "3469": "#7B5EA7", "3470": "#4FA3E3",
  "22427": "#C0392B", "62487": "#FF7F0E",
};

const px = (p: LatLng) => ({ x: (p.lng * KX) / MPP, y: -(p.lat * K) / MPP });

/** Every run and link whose geometry comes near `at`, in true pixels. */
function near(at: LatLng, radiusPx: number) {
  const runs = laneRuns(snapped, GAP);
  const { runs: trimmed, links } = laneLinks(runs, MPP);
  const c = px(at);
  const hit = (path: LatLng[]) =>
    path.some((p) => Math.hypot(px(p).x - c.x, px(p).y - c.y) < radiusPx);
  return {
    before: runs.filter((r) => hit(r.path)),
    after: trimmed.filter((r) => hit(r.path)),
    links: links.filter((l) => hit(l.path)),
    c,
  };
}

/** A run, stroked the way the GPU strokes it: displaced by its own offset. */
function offsetPath(run: LaneRun): { x: number; y: number }[] {
  const p = run.path.map(px);
  return p.map((v, i) => {
    const a = p[Math.max(0, i - 1)]!, b = p[Math.min(p.length - 1, i + 1)]!;
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    return { x: v.x + (dy / L) * run.offsetPx, y: v.y - (dx / L) * run.offsetPx };
  });
}

const CASES: { name: string; at: LatLng; note: string }[] = [
  { name: "Bowen x Prospect", at: { lat: 41.83060, lng: -71.40560 },
    note: "reported: the line looks discontinuous here" },
  { name: "Angell", at: { lat: 41.82788, lng: -71.40317 },
    note: "reported: lines swap sides here" },
  { name: "Fones Alley", at: { lat: 41.82692, lng: -71.40472 },
    note: "reported: lines bend and are not gapped correctly" },
  { name: "near the State Library", at: { lat: 41.82613, lng: -71.40462 },
    note: "reported: corners have nubs" },
];

const d = (p: { x: number; y: number }[]) =>
  p.map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(3)} ${q.y.toFixed(3)}`).join(" ");

const rows = CASES.map((cse, r) => {
  const { before, after, links, c } = near(cse.at, 26);
  const cells = [
    before.map((run) =>
      `<path d="${d(offsetPath(run))}" fill="none" stroke="${COLOUR[run.routeId] ?? "#888"}"
         stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>`).join(""),
    after.map((run) =>
      `<path d="${d(offsetPath(run))}" fill="none" stroke="${COLOUR[run.routeId] ?? "#888"}"
         stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>`).join("")
    + links.map((l) =>
      `<path d="${d(l.path.map(px))}" fill="none" stroke="${COLOUR[l.routeId] ?? "#888"}"
         stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>`).join(""),
  ];
  const cols = ["TODAY: one feature per run, unjoined", "PROPOSED: pulled back, connected"];
  return `<g transform="translate(0 ${r * CH})">
    <text x="12" y="20" font-size="13" font-weight="600" fill="#111">${cse.name}</text>
    <text x="12" y="35" font-size="10.5" fill="#777">${cse.note}</text>
    ${cells.map((body, i) => `<g transform="translate(${i * CW} 42)">
       <rect width="${CW - 10}" height="${CH - 58}" fill="#fbfbfb" stroke="#e8e8e8"/>
       <text x="10" y="16" font-size="9.5" fill="#999">${cols[i]}</text>
       <g transform="translate(${(CW - 10) / 2} ${(CH - 58) / 2}) scale(${MAG}) translate(${-c.x} ${-c.y})">
         ${body}
       </g></g>`).join("")}
  </g>`;
}).join("");

writeFileSync("docs/junction-cases.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" width="${2 * CW}" height="${CASES.length * CH}"
     font-family="ui-sans-serif, system-ui, sans-serif">
   <rect width="100%" height="100%" fill="#fff"/>${rows}</svg>`);

for (const cse of CASES) {
  const { before, after, links } = near(cse.at, 26);
  console.log(`${cse.name.padEnd(24)} runs ${String(before.length).padStart(2)} -> ` +
    `${String(after.length).padStart(2)} + ${links.length} connector(s)`);
}
console.log("\nwrote docs/junction-cases.svg");
