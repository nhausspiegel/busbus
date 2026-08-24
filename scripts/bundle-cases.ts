/**
 * Draw the five bundler reference cases to an SVG you can actually look at.
 *
 * Grey dashes are the input; solid colour is what the bundler produced. Each
 * panel prints the measured minimum separation next to the one it was asked
 * for, so a wrong result is readable without counting pixels.
 *
 * The same cases drive test/bundle.test.ts, so the picture and the assertions
 * cannot drift apart.
 *
 *   npx tsx scripts/bundle-cases.ts       -> docs/bundle-cases.svg
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { laneProfiles, applyLanes, DEFAULT_OPTIONS, type Pt } from "../src/render/bundle";
import { CASES } from "../test/fixtures/bundleCases";

const OPTS = DEFAULT_OPTIONS;
const COLOURS = ["#C8102E", "#1F6FEB", "#2E7D32", "#B15B2E"];

const PANEL_W = 420, PANEL_H = 230, PAD = 16, HEADER = 52;
const COLS = 2;

const path = (pts: Pt[]) =>
  pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");

/** Closest approach between two polylines, sampled at their vertices. */
function closest(a: Pt[], b: Pt[]): number {
  let best = Infinity;
  for (const p of a)
    for (let i = 1; i < b.length; i++) {
      const s = b[i - 1]!, e = b[i]!;
      const dx = e.x - s.x, dy = e.y - s.y, len = dx * dx + dy * dy;
      const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / len));
      best = Math.min(best, Math.hypot(p.x - (s.x + dx * t), p.y - (s.y + dy * t)));
    }
  return best;
}

const panels = CASES.map((c, idx) => {
  const CORNER_RADIUS = 14;
  const drawn = laneProfiles(c.lines, OPTS).map((p) => ({ id: p.id, pts: applyLanes(p, c.minGap, CORNER_RADIUS) }));

  // Where the lines actually run together, how far apart did they end up?
  let measured = Infinity;
  for (let i = 0; i < drawn.length; i++)
    for (let j = i + 1; j < drawn.length; j++)
      measured = Math.min(measured, closest(drawn[i]!.pts, drawn[j]!.pts));

  const col = idx % COLS, row = Math.floor(idx / COLS);
  const ox = PAD + col * (PANEL_W + PAD), oy = HEADER + PAD + row * (PANEL_H + PAD + 46);

  // The input is a wide pale halo and the output a thin bright line on top, so
  // a line that did not move reads as colour centred in grey, and one that did
  // reads as colour that has left its halo. Dashes-under-solid made cases that
  // correctly changed nothing look like empty panels.
  const source = c.lines.map((l) =>
    `<path d="${path(l.points)}" fill="none" stroke="#DDD6CF" stroke-width="7"
       stroke-linejoin="round" stroke-linecap="round"/>`).join("\n      ");
  const result = drawn.map((d, i) =>
    `<path d="${path(d.pts)}" fill="none" stroke="${COLOURS[i % COLOURS.length]}"
       stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`).join("\n      ");
  const key = drawn.map((d, i) =>
    `<tspan fill="${COLOURS[i % COLOURS.length]}">${d.id}</tspan>`).join(`<tspan fill="#8A817A"> · </tspan>`);

  // How far the line WORST moved, not how close it still comes to its source.
  // Closest-approach is 0 wherever a line is partly unmoved, which reported the
  // Y-merge as "left alone" when its trunk had correctly shifted.
  const moved = Math.max(...c.lines.map((l, i) =>
    Math.max(...drawn[i]!.pts.map((p) => closest([p], l.points)))));
  const untouched = moved < 0.01;
  const ok = untouched || measured >= c.minGap - 0.5;

  return `
  <g transform="translate(${ox} ${oy})">
    <rect x="0" y="0" width="${PANEL_W}" height="${PANEL_H}" rx="10" fill="#FBF8F5" stroke="#E4DDD6"/>
    <g transform="translate(6 14)">
      ${source}
      ${result}
    </g>
    <text x="12" y="${PANEL_H + 18}" font-family="ui-sans-serif,system-ui" font-size="13" font-weight="600" fill="#241C17">
      ${idx + 1}. ${c.name} <tspan font-weight="400" fill="#6F625A">— ${key}</tspan>
    </text>
    <text x="12" y="${PANEL_H + 35}" font-family="ui-sans-serif,system-ui" font-size="11" fill="#6F625A">
      minimum ${c.minGap} · closest ${measured === Infinity ? "n/a" : measured.toFixed(1)}
      · moved at most ${moved.toFixed(1)}
      · <tspan fill="${ok ? "#2E7D32" : "#C8102E"}" font-weight="600">${untouched ? "left alone" : ok ? "cleared" : "TOO CLOSE"}</tspan>
    </text>
  </g>`;
}).join("\n");

const rows = Math.ceil(CASES.length / COLS);
const width = PAD + COLS * (PANEL_W + PAD);
const height = HEADER + PAD + rows * (PANEL_H + PAD + 46);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"
     viewBox="0 0 ${width} ${height}" font-family="ui-sans-serif,system-ui">
  <rect width="${width}" height="${height}" fill="#FFFFFF"/>
  <text x="${PAD}" y="30" font-size="17" font-weight="700" fill="#241C17">Polyline bundler — reference cases</text>
  <text x="${PAD}" y="46" font-size="12" fill="#6F625A">grey dashes: input · solid: bundled output · same cases as test/bundle.test.ts</text>
${panels}
</svg>
`;

mkdirSync("docs", { recursive: true });
writeFileSync("docs/bundle-cases.svg", svg);
console.log(`wrote docs/bundle-cases.svg (${CASES.length} cases, ${width}x${height})`);
for (const c of CASES) console.log(`  ${c.name}: ${c.what}`);
