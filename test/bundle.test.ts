import { describe, it, expect } from "vitest";
import { laneProfiles, applyLanes, DEFAULT_OPTIONS, type Line, type Pt } from "../src/render/bundle";
import { CASES } from "./fixtures/bundleCases";

const OPTS = DEFAULT_OPTIONS;

const caseNamed = (name: string) => {
  const c = CASES.find((x) => x.name === name);
  if (!c) throw new Error(`no case ${name}`);
  return c;
};

/** Run one reference case, returning the drawn geometry per line id. */
function bundle(lines: Line[], minGap: number): Map<string, Pt[]> {
  return new Map(laneProfiles(lines, OPTS).map((p) => [p.id, applyLanes(p, minGap)]));
}

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/** Closest approach from a point to a polyline. */
function toLine(p: Pt, line: Pt[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!, b = line[i]!;
    const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

describe("case 1: coincident pair", () => {
  const c = caseNamed("coincident-pair");
  const out = bundle(c.lines, c.minGap);

  it("separates them to exactly the minimum", () => {
    const a = out.get("A")!, b = out.get("B")!;
    const mid = Math.floor(a.length / 2);
    expect(toLine(a[mid]!, b)).toBeCloseTo(c.minGap, 1);
  });

  it("moves both the same distance, so the pair straddles where it was", () => {
    const a = out.get("A")!, b = out.get("B")!;
    const mid = Math.floor(a.length / 2);
    const src = c.lines[0]!.points[mid]!;
    expect(dist(a[mid]!, src)).toBeCloseTo(dist(b[mid]!, src), 1);
    expect(dist(a[mid]!, src)).toBeCloseTo(c.minGap / 2, 1);
  });
});

describe("case 2: already-clear parallels", () => {
  const c = caseNamed("already-clear-parallels");
  const out = bundle(c.lines, c.minGap);

  it("leaves lines that already clear the minimum exactly where they were", () => {
    // The "two different parallel streets" case. Any exact-gap rule drags these
    // together and off their own roads; a minimum-gap rule must not touch them.
    // Measured as distance to the SOURCE polyline, so densifying does not
    // matter -- an unmoved line stays on the line it came from.
    for (const line of c.lines)
      for (const p of out.get(line.id)!)
        expect(toLine(p, line.points)).toBeLessThan(0.01);
  });
});

describe("case 3: Y-merge", () => {
  const c = caseNamed("y-merge");
  const out = bundle(c.lines, c.minGap);

  it("reaches the minimum along the shared trunk", () => {
    const a = out.get("A")!, b = out.get("B")!;
    const mid = Math.floor(a.length / 2);
    expect(toLine(a[mid]!, b)).toBeGreaterThan(c.minGap - 1);
  });

  it("leaves the arms alone", () => {
    // Where a line runs by itself it must not move. Four earlier attempts
    // displaced every line everywhere, which floated the whole network off its
    // streets.
    //
    // "Alone" means far from the bundle: a line does begin easing across
    // slightly BEFORE it meets its neighbour, which is deliberate -- a ramp
    // that starts only once the two are already too close makes them visibly
    // pinch. So the far end of the arm is exact, and the approach is held to a
    // fraction of the gap rather than to zero.
    const a = out.get("A")!, src = c.lines[0]!.points;
    expect(toLine(a[0]!, src)).toBeLessThan(0.01);
    const arm = { x: 0, y: 40 };
    const nearArm = a.filter((p) => Math.hypot(p.x - arm.x, p.y - arm.y) < 40);
    expect(nearArm.length).toBeGreaterThan(2);
    for (const p of nearArm) expect(toLine(p, src)).toBeLessThan(c.minGap / 20);
  });

  it("ramps in rather than stepping", () => {
    const a = out.get("A")!, src = c.lines[0]!.points;
    let worst = 0;
    for (let i = 1; i < a.length; i++)
      worst = Math.max(worst, Math.abs(toLine(a[i]!, src) - toLine(a[i - 1]!, src)));
    expect(worst).toBeLessThan(c.minGap / 4);
  });
});

describe("case 4: crossroads", () => {
  const c = caseNamed("crossroads");
  const out = bundle(c.lines, c.minGap);

  it("treats a junction as a junction, not a bundle", () => {
    for (const line of c.lines)
      for (const p of out.get(line.id)!)
        expect(toLine(p, line.points)).toBeLessThan(0.01);
  });
});

describe("case 5: antiparallel loop", () => {
  const c = caseNamed("antiparallel-loop");
  const out = bundle(c.lines, c.minGap);
  const cw = out.get("CW")!, ccw = out.get("CCW")!;
  const src = c.lines[0]!.points;

  it("puts the two directions on opposite sides, the whole way round", () => {
    // Resolving the lane in each line's own "right of travel" frame sends both
    // directions to the same side: -0.5 and +0.5 cancel out. Measured on the
    // real feed that moved the two Evening loops from 1.27px apart to 1.55px.
    let together = 0;
    for (let i = 0; i < src.length; i++)
      if (toLine(cw[i]!, ccw) < c.minGap * 0.6) together++;
    expect(together / src.length).toBeLessThan(0.1);
  });

  it("holds the gap through the corners", () => {
    // Without a miter every corner pinches: moving a vertex along the averaged
    // normal under-shoots a true parallel by 1/sin(t/2), which at these right
    // angles is a factor of 1.41 and dragged the 12 gap down to 7.2.
    let worst = Infinity;
    for (const p of cw) worst = Math.min(worst, toLine(p, ccw));
    expect(worst).toBeGreaterThan(c.minGap - 0.5);
  });

  it("caps the miter, so a corner can never grow a spike", () => {
    // The spike test. A true parallel needs offset/sin(t/2), unbounded as a
    // corner closes -- that is what made MapLibre's line-offset unusable, at
    // ~2px of whisker per px of offset on Brown's sharpest corner. Capped at
    // MITER_LIMIT nothing can travel more than twice the gap it is opening.
    // 90 degrees needs 1.41, which is under the cap and therefore exact.
    for (const [id, drawn] of [["CW", cw], ["CCW", ccw]] as const) {
      const source = c.lines.find((l) => l.id === id)!.points;
      for (const p of drawn)
        expect(toLine(p, source)).toBeLessThanOrEqual((c.minGap / 2) * 2 + 0.01);
    }
  });
});

describe("never folds back on itself, at any sampling density", () => {
  // A miter slides the corner ALONG the line as well as across it. Once that
  // slide passes the neighbouring vertex the line reverses -- a full 180
  // degrees. It appeared only on the inner ring of the loop case and only once
  // the step dropped below the offset, which is exactly the kind of defect a
  // single fixture density hides.
  const turn = (pts: Pt[], i: number) => {
    const a = pts[i - 1]!, b = pts[i]!, c = pts[i + 1]!;
    const v1 = { x: b.x - a.x, y: b.y - a.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const n1 = Math.hypot(v1.x, v1.y), n2 = Math.hypot(v2.x, v2.y);
    if (!n1 || !n2) return 0;
    return Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (n1 * n2))))
      * 180 / Math.PI;
  };

  for (const stepM of [10, 20]) {
    it(`holds every corner within 90 degrees of its source at step ${stepM}`, () => {
      for (const c of CASES) {
        const profiles = laneProfiles(c.lines, { ...OPTS, stepM });
        for (const p of profiles) {
          const out = applyLanes(p, c.minGap);
          for (let i = 1; i < out.length - 1; i++)
            expect(turn(out, i) - turn(p.path, i)).toBeLessThan(90);
        }
      }
    });
  }
});

describe("the minimum is a floor, not a target", () => {
  it("closes a 7 gap up to 12 by moving each line 2.5, not by adding 12", () => {
    const a: Line = { id: "A", points: [{ x: 0, y: 96.5 }, { x: 400, y: 96.5 }] };
    const b: Line = { id: "B", points: [{ x: 0, y: 103.5 }, { x: 400, y: 103.5 }] };
    const out = bundle([a, b], 12);
    const mid = Math.floor(out.get("A")!.length / 2);
    expect(toLine(out.get("A")![mid]!, out.get("B")!)).toBeCloseTo(12, 1);
    // 2.5 each, not 7 + 12 = 19 apart.
    expect(Math.abs(out.get("A")![mid]!.y - 96.5)).toBeCloseTo(2.5, 1);
  });

  it("spreads three coincident lines evenly and centres them", () => {
    const pts = [{ x: 0, y: 100 }, { x: 400, y: 100 }];
    const out = bundle(
      [{ id: "A", points: pts }, { id: "B", points: pts }, { id: "C", points: pts }], 12);
    const mid = Math.floor(out.get("A")!.length / 2);
    const ys = ["A", "B", "C"].map((id) => out.get(id)![mid]!.y).sort((x, y) => x - y);
    expect(ys[1]! - ys[0]!).toBeCloseTo(12, 1);
    expect(ys[2]! - ys[1]!).toBeCloseTo(12, 1);
    expect((ys[0]! + ys[2]!) / 2).toBeCloseTo(100, 1);   // centred on the original
  });
});
