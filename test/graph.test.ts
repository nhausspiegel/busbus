import { describe, it, expect } from "vitest";
import { buildEdges, laneOffsets, drawLanes } from "../src/render/graph";
import type { Pt } from "../src/render/geometry";

/**
 * The corridor graph, checked on the behaviours that were visibly broken.
 *
 * The old renderer decided each vertex's lane on its own, from a distance
 * search over traces that weave, so the answer changed from sample to sample
 * and the line stepped sideways: spurs, acute wedges, and kinks in a straight
 * street. These are the properties that make that impossible rather than
 * merely unlikely.
 */

/** A straight run east, sampled every 10 units. */
const run = (y: number, n = 30): Pt[] =>
  Array.from({ length: n }, (_, i) => ({ x: i * 10, y }));

describe("an offset cannot change inside a corridor", () => {
  it("holds one value for the whole edge", () => {
    // The guarantee the whole design rests on. If this can fail, a straight
    // street can acquire a dogleg.
    const paths = [run(0), run(0)];          // identical: one shared corridor
    const edges = buildEdges(paths);
    const off = laneOffsets(paths, edges, 0);
    for (const e of edges) {
      const inside = off[e.line]!.slice(e.from, e.to + 1);
      expect(new Set(inside).size).toBe(1);
    }
  });

  it("puts two routes on one street into different lanes", () => {
    const paths = [run(0), run(0)];
    const off = laneOffsets(paths, buildEdges(paths), 0);
    expect(off[0]![5]).not.toBe(off[1]![5]);
  });

  it("leaves a route running alone exactly where it was", () => {
    // 61% of Brown's network is a single route. None of it may move.
    const paths = [run(0), run(500)];        // far apart: nothing shared
    const off = laneOffsets(paths, buildEdges(paths), 0);
    expect(off[0]!.every((v) => v === 0)).toBe(true);
    expect(off[1]!.every((v) => v === 0)).toBe(true);

    const drawn = drawLanes(paths, off, 12, 0);
    drawn[0]!.forEach((p, i) => {
      expect(p.x).toBeCloseTo(paths[0]![i]!.x, 6);
      expect(p.y).toBeCloseTo(paths[0]![i]!.y, 6);
    });
  });
});

describe("a route joining a corridor does not shove the others aside", () => {
  it("keeps the incumbent's lane when a third route arrives", () => {
    // Centring the bundle (rank - (n-1)/2) moves EVERY member sideways as
    // soon as another joins: -0.5/+0.5 becomes -1/0/+1, so all of them step
    // across at the junction. That step is the jog in a straight street.
    const a = run(0), b = run(0);
    // `c` only exists for the second half of the street.
    const c = run(0).slice(15);
    const paths = [a, b, c];
    const off = laneOffsets(paths, buildEdges(paths), 0);

    const before = off[0]![5]!;              // where A sits with only B alongside
    const after = off[0]![25]!;              // and once C has joined
    expect(after).toBe(before);
  });
});

describe("short-lived membership is not a corridor", () => {
  it("absorbs an edge too short to be a change of street", () => {
    // `shareCorridors` and the matching both leave the odd unpaired sample, so
    // membership can flicker for a vertex or two. Measured on the real feed
    // before contracting, the median edge was 2 vertices -- 20 metres -- which
    // is a gap in the pairing, not a street.
    const a = run(0);
    // `b` matches `a` except for a single vertex nudged out of coincidence.
    const b = run(0).map((p, i) => (i === 12 ? { x: p.x, y: p.y + 40 } : p));
    const loose = buildEdges([a, b], 1);
    const tight = buildEdges([a, b], 6);
    expect(loose.length).toBeGreaterThan(tight.length);

    // And the offset along A is then a single value, with no one-vertex step.
    const off = laneOffsets([a, b], tight, 0);
    const steps = off[0]!.filter((v, i) => i > 0 && v !== off[0]![i - 1]).length;
    expect(steps).toBe(0);
  });
});

describe("drawing", () => {
  it("moves a lane sideways by the gap, not along the street", () => {
    const paths = [run(0), run(0)];
    const off = laneOffsets(paths, buildEdges(paths), 0);
    const drawn = drawLanes(paths, off, 12, 0);
    // Same x, shifted y: the street runs east, so lanes separate north/south.
    const i = 10;
    expect(drawn[0]![i]!.x).toBeCloseTo(paths[0]![i]!.x, 6);
    expect(Math.abs(drawn[0]![i]!.y - drawn[1]![i]!.y)).toBeCloseTo(12, 6);
  });

  it("keeps a corner parallel instead of pinching it", () => {
    // An L. Offsetting each vertex along its own normal without the miter
    // correction pulls the corner in and the two lines stop being parallel.
    const corner: Pt[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ x: i * 10, y: 0 })),
      ...Array.from({ length: 10 }, (_, i) => ({ x: 90, y: (i + 1) * 10 })),
    ];
    const paths = [corner, corner.map((p) => ({ ...p }))];
    const off = laneOffsets(paths, buildEdges(paths), 0);
    const drawn = drawLanes(paths, off, 12, 0);
    const gapAt = (i: number) =>
      Math.hypot(drawn[0]![i]!.x - drawn[1]![i]!.x, drawn[0]![i]!.y - drawn[1]![i]!.y);
    // The gap on the straight and the gap at the corner agree.
    expect(gapAt(9)).toBeGreaterThan(gapAt(3) * 0.9);
  });
});
