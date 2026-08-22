import type { Line, Pt } from "../../src/render/bundle";

/**
 * Five hand-built cases for the polyline bundler, in a bare metric plane.
 *
 * Nothing here is a street in Providence. The bundler is a general piece of
 * geometry and every defect it has shipped so far reproduces on shapes this
 * simple -- lines pulled off their own path, a gap that changed with scale,
 * spikes at corners, and two directions of one loop landing on the same side.
 *
 * Used by BOTH test/bundle.test.ts and scripts/bundle-cases.ts, so the
 * assertions and the picture can never drift apart.
 */
export interface BundleCase {
  name: string;
  what: string;
  lines: Line[];
  /** Minimum separation to enforce, in the same units as the coordinates. */
  minGap: number;
}

/** Points every `step` along a straight run. */
function run(from: Pt, to: Pt, step = 10): Pt[] {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const n = Math.max(1, Math.round(len / step));
  return Array.from({ length: n + 1 }, (_, i) => ({
    x: from.x + ((to.x - from.x) * i) / n,
    y: from.y + ((to.y - from.y) * i) / n,
  }));
}

/** A closed rectangle with hard corners, walked in order. */
function rectangle(x0: number, y0: number, x1: number, y1: number, step = 10): Pt[] {
  return [
    ...run({ x: x0, y: y0 }, { x: x1, y: y0 }, step),
    ...run({ x: x1, y: y0 }, { x: x1, y: y1 }, step).slice(1),
    ...run({ x: x1, y: y1 }, { x: x0, y: y1 }, step).slice(1),
    ...run({ x: x0, y: y1 }, { x: x0, y: y0 }, step).slice(1),
  ];
}

export const CASES: BundleCase[] = [
  {
    name: "coincident-pair",
    what: "Two identical straight lines. The basic spread.",
    minGap: 12,
    lines: [
      { id: "A", points: run({ x: 0, y: 100 }, { x: 400, y: 100 }) },
      { id: "B", points: run({ x: 0, y: 100 }, { x: 400, y: 100 }) },
    ],
  },
  {
    name: "already-clear-parallels",
    what: "Two straight lines 20 apart, minimum 12. Close enough to be seen as "
      + "one bundle, but already further apart than the minimum -- two "
      + "genuinely parallel streets. They must be left exactly alone.",
    // 20 apart is deliberately INSIDE the 25 detection threshold. Put them
    // outside it and they are never bundled, so the case proves nothing: an
    // exact-gap rule passes it too. This is the only case that separates
    // "minimum" from "exact".
    minGap: 12,
    lines: [
      { id: "A", points: run({ x: 0, y: 90 }, { x: 400, y: 90 }) },
      { id: "B", points: run({ x: 0, y: 110 }, { x: 400, y: 110 }) },
    ],
  },
  {
    name: "y-merge",
    what: "Two lines that run apart, share a trunk, then diverge. The arms must "
      + "not move at all; the trunk must reach the minimum, ramped into.",
    minGap: 12,
    lines: [
      { id: "A", points: [
        ...run({ x: 0, y: 40 }, { x: 120, y: 100 }),
        ...run({ x: 120, y: 100 }, { x: 280, y: 100 }).slice(1),
        ...run({ x: 280, y: 100 }, { x: 400, y: 40 }).slice(1),
      ] },
      { id: "B", points: [
        ...run({ x: 0, y: 160 }, { x: 120, y: 100 }),
        ...run({ x: 120, y: 100 }, { x: 280, y: 100 }).slice(1),
        ...run({ x: 280, y: 100 }, { x: 400, y: 160 }).slice(1),
      ] },
    ],
  },
  {
    name: "crossroads",
    what: "Two lines meeting at 90 degrees. Crossing is not sharing -- a "
      + "junction is not a bundle and neither line may move.",
    minGap: 12,
    lines: [
      { id: "A", points: run({ x: 0, y: 100 }, { x: 400, y: 100 }) },
      { id: "B", points: run({ x: 200, y: 0 }, { x: 200, y: 200 }) },
    ],
  },
  {
    name: "antiparallel-loop",
    what: "One closed loop with hard corners, walked clockwise and "
      + "anticlockwise. Catches the direction bug and the spike bug at once.",
    minGap: 12,
    lines: [
      { id: "CW", points: rectangle(60, 40, 340, 180) },
      { id: "CCW", points: [...rectangle(60, 40, 340, 180)].reverse() },
    ],
  },
];
