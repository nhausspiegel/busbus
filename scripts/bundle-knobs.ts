/**
 * Render the two cases that the tuning knobs actually affect, at several
 * settings, side by side. For choosing values by eye rather than by argument.
 *
 *   npx tsx scripts/bundle-knobs.ts        -> docs/bundle-knobs.svg
 *
 * The knob that matters is `taperM`: how far a line takes to ease into its
 * lane. Short tapers kink where a bundle starts; long ones are smooth but on a
 * short shared stretch the ramp never finishes, so the lines never reach the
 * full gap. Everything else here is held fixed.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { laneProfiles, applyLanes, DEFAULT_OPTIONS, type Pt } from "../src/render/bundle";
import { CASES } from "../test/fixtures/bundleCases";

/**
 * NOTE: this exercises the bundler ALONE -- `applyLanes` here is called without
 * the screen-space lane hold the map applies (`LANE_HOLD_PX` in TransitMap).
 * That is deliberate: the hold suppresses separation over short runs, which is
 * exactly what these cases exist to check, so applying it would hide the thing
 * being measured.
 *
 * The consequence is that this is NOT a picture of what the app draws. Judging
 * the real map from it is the trap that cost this project a lot of time --
 * `test/squiggle.test.ts` is the production check, in screen pixels.
 */

const RADII = [0, 8, 16, 28];
const SHOW = ["y-merge", "antiparallel-loop"];
const COLOURS = ["#C8102E", "#1F6FEB"];

const PANEL_W = 400, PANEL_H = 220, PAD = 14, HEADER = 56, LABEL = 40;

const path = (pts: Pt[]) =>
  pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");

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

/** Worst extra turn the output makes that its own source does not. */
function kink(src: Pt[], out: Pt[]): number {
  const turn = (pts: Pt[], i: number) => {
    const a = pts[i - 1]!, b = pts[i]!, c = pts[i + 1]!;
    const v1 = { x: b.x - a.x, y: b.y - a.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const n1 = Math.hypot(v1.x, v1.y), n2 = Math.hypot(v2.x, v2.y);
    if (!n1 || !n2) return 0;
    return Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (n1 * n2)))) * 180 / Math.PI;
  };
  let worst = 0;
  for (let i = 1; i < Math.min(src.length, out.length) - 1; i++)
    worst = Math.max(worst, turn(out, i) - turn(src, i));
  return worst;
}

const rowsOut: string[] = [];
SHOW.forEach((name, row) => {
  const c = CASES.find((x) => x.name === name)!;
  RADII.forEach((radius, col) => {
    const profiles = laneProfiles(c.lines, DEFAULT_OPTIONS);
    const drawn = profiles.map((p) => ({ id: p.id, src: p.path, pts: applyLanes(p, c.minGap, radius) }));

    let gap = Infinity;
    for (let i = 0; i < drawn.length; i++)
      for (let j = i + 1; j < drawn.length; j++)
        gap = Math.min(gap, closest(drawn[i]!.pts, drawn[j]!.pts));
    const worstKink = Math.max(...drawn.map((d) => kink(d.src, d.pts)));

    const ox = PAD + col * (PANEL_W + PAD);
    const oy = HEADER + row * (PANEL_H + LABEL + PAD);
    const source = c.lines.map((l) =>
      `<path d="${path(l.points)}" fill="none" stroke="#DDD6CF" stroke-width="7"
         stroke-linejoin="round" stroke-linecap="round"/>`).join("");
    const result = drawn.map((d, i) =>
      `<path d="${path(d.pts)}" fill="none" stroke="${COLOURS[i % COLOURS.length]}"
         stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`).join("");

    rowsOut.push(`
  <g transform="translate(${ox} ${oy})">
    <rect width="${PANEL_W}" height="${PANEL_H}" rx="10" fill="#FBF8F5" stroke="#E4DDD6"/>
    <g transform="translate(0 8) scale(0.95)">${source}${result}</g>
    <text x="12" y="${PANEL_H + 17}" font-size="13" font-weight="700" fill="#241C17">corner radius ${radius}</text>
    <text x="12" y="${PANEL_H + 32}" font-size="11" fill="#6F625A">
      gap reached ${gap === Infinity ? "n/a" : gap.toFixed(1)} of ${c.minGap}
      · kink ${worstKink.toFixed(1)}&#176;
    </text>
  </g>`);
  });
});

const width = PAD + RADII.length * (PANEL_W + PAD);
const height = HEADER + SHOW.length * (PANEL_H + LABEL + PAD);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"
     viewBox="0 0 ${width} ${height}" font-family="ui-sans-serif,system-ui">
  <rect width="${width}" height="${height}" fill="#FFFFFF"/>
  <text x="${PAD}" y="26" font-size="17" font-weight="700" fill="#241C17">Corner radius — pick one</text>
  <text x="${PAD}" y="44" font-size="12" fill="#6F625A">top row: Y-merge (short shared trunk) · bottom row: loop both ways · lower kink is smoother, but too long a taper never reaches the gap</text>
${rowsOut.join("\n")}
</svg>
`;

mkdirSync("docs", { recursive: true });
writeFileSync("docs/bundle-knobs.svg", svg);
console.log(`wrote docs/bundle-knobs.svg (radii ${RADII.join(", ")})`);
