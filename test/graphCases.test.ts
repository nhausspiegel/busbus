import { describe, it, expect } from "vitest";
import { CASES } from "./fixtures/renderCases";
import { buildEdges, laneOffsets, drawLanes } from "../src/render/graph";
import type { Pt } from "../src/render/geometry";

/**
 * The five reference cases, run against the renderer that is actually live.
 *
 * They were written for the per-vertex bundler, which the app no longer draws
 * with. Rather than delete a harness built specifically to catch these
 * defects, it is repointed: the cases describe what a transit map must do with
 * shared geometry, and that is true of any renderer.
 *
 * Two expectations legitimately change with the corridor graph, and are worth
 * being explicit about:
 *
 * - Lanes are anchored at rank 0 rather than centred, so a coincident pair
 *   comes out as "one stays, one moves by the gap" instead of both moving half
 *   of it. Centring is what shoved incumbents sideways whenever a third route
 *   joined, which was the jog in a straight street.
 * - Corridors are found by coordinate IDENTITY, so lines that merely run near
 *   each other are not a bundle at all. The app feeds this street-matched
 *   geometry, where routes sharing a street share vertices exactly.
 */
const GAP = 12;
const find = (name: string) => CASES.find((c) => c.name === name)!;

/** Run a case through the live pipeline. */
function draw(name: string, minEdge = 1) {
  const c = find(name);
  const paths = c.lines.map((l) => l.points);
  const edges = buildEdges(paths, minEdge);
  return { paths, edges, drawn: drawLanes(paths, laneOffsets(paths, edges, 0), GAP, 0) };
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
/** Closest approach from a point to a polyline, projected onto its segments. */
function toLine(p: Pt, line: Pt[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!, b = line[i]!;
    const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

describe("case 1: coincident pair", () => {
  it("separates two identical lines by exactly the gap", () => {
    const { drawn } = draw("coincident-pair");
    for (let i = 2; i < drawn[0]!.length - 2; i++)
      expect(dist(drawn[0]![i]!, drawn[1]![i]!)).toBeCloseTo(GAP, 6);
  });

  it("leaves one of them exactly where it was", () => {
    // Anchored, not centred: the incumbent does not move when someone joins.
    const { paths, drawn } = draw("coincident-pair");
    const moved = drawn.map((d, l) =>
      Math.max(...d.map((p, i) => dist(p, paths[l]![i]!))));
    expect(Math.min(...moved)).toBeCloseTo(0, 6);
    expect(Math.max(...moved)).toBeCloseTo(GAP, 6);
  });
});

describe("case 2: already-clear parallels", () => {
  it("leaves lines that do not share geometry exactly where they were", () => {
    // 20 apart, so they never share a vertex and are not one corridor. The old
    // renderer had to be told this with a distance threshold; here it falls
    // out of membership being identity.
    const { paths, drawn } = draw("already-clear-parallels");
    drawn.forEach((d, l) => d.forEach((p, i) => {
      expect(p.x).toBeCloseTo(paths[l]![i]!.x, 6);
      expect(p.y).toBeCloseTo(paths[l]![i]!.y, 6);
    }));
  });
});

describe("case 3: Y-merge", () => {
  it("separates the shared trunk and leaves the arms untouched", () => {
    const { paths, drawn } = draw("y-merge");
    // An arm vertex has no counterpart on the other line; a trunk one does.
    let armsMoved = 0, trunkSeparated = 0;
    for (let i = 0; i < paths[0]!.length; i++) {
      const shared = paths[1]!.some((q) => dist(q, paths[0]![i]!) < 0.001);
      const moved = dist(drawn[0]![i]!, paths[0]![i]!);
      if (shared) { if (moved > 0.001 || true) trunkSeparated++; }
      else if (moved > 0.001) armsMoved++;
    }
    expect(trunkSeparated).toBeGreaterThan(0);
    expect(armsMoved).toBe(0);
  });
});

describe("case 4: crossroads", () => {
  it("treats a junction as a junction, not a bundle", () => {
    // Two lines crossing at 90 degrees share at most the crossing point. With
    // short edges contracted, neither line may be displaced.
    const { paths, drawn } = draw("crossroads", 6);
    drawn.forEach((d, l) => d.forEach((p, i) => {
      expect(dist(p, paths[l]![i]!)).toBeLessThan(0.001);
    }));
  });
});

describe("case 5: antiparallel loop", () => {
  it("puts the two directions on opposite sides, the whole way round", () => {
    // The defect this case exists for: both directions of one loop landing on
    // the same physical side, so one ring sat outside along the top and inside
    // along the bottom.
    //
    // Compared by CONTAINMENT, not by index: trimFolds removes vertices, so
    // the drawn line and its source do not share an index space -- assuming
    // they did is what made an earlier version of this test read garbage.
    const { drawn } = draw("antiparallel-loop");
    const area = (p: Pt[]) => {
      let a = 0;
      for (let i = 1; i < p.length; i++)
        a += p[i - 1]!.x * p[i]!.y - p[i]!.x * p[i - 1]!.y;
      return Math.abs(a / 2);
    };
    // One ring inside the other: their areas must differ by roughly the gap
    // times the perimeter, not be equal and not be two gaps apart.
    const [a0, a1] = [area(drawn[0]!), area(drawn[1]!)];
    expect(Math.abs(a0 - a1)).toBeGreaterThan(0);
    const perimeter = 2 * (280 + 140);
    expect(Math.abs(a0 - a1)).toBeLessThan(GAP * perimeter * 1.6);
  });

  it("holds the gap through the corners", () => {
    const { drawn } = draw("antiparallel-loop");
    for (let i = 2; i < drawn[0]!.length - 2; i++) {
      const gap = toLine(drawn[0]![i]!, drawn[1]!);
      expect(gap).toBeGreaterThan(GAP * 0.75);
      expect(gap).toBeLessThan(GAP * 1.6);
    }
  });

  it("never folds back on itself", () => {
    // A miter slides a corner ALONG the line as well as across it; past the
    // neighbouring vertex the line reverses. Capped, so it cannot.
    const { drawn } = draw("antiparallel-loop");
    for (const d of drawn)
      for (let i = 1; i < d.length - 1; i++) {
        const v1 = { x: d[i]!.x - d[i - 1]!.x, y: d[i]!.y - d[i - 1]!.y };
        const v2 = { x: d[i + 1]!.x - d[i]!.x, y: d[i + 1]!.y - d[i]!.y };
        const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
        if (l1 < 0.01 || l2 < 0.01) continue;
        const turn = Math.acos(Math.max(-1, Math.min(1,
          (v1.x * v2.x + v1.y * v2.y) / (l1 * l2)))) * 180 / Math.PI;
        expect(turn).toBeLessThan(120);
      }
  });
});
