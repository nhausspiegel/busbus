import { describe, it, expect } from "vitest";
import {
  stopPaint, stopBasePaint, tickPaint, routeLinePaint, stopRadius,
  DIM, IDLE, type MapState,
} from "../src/render/symbols";

/**
 * A symbol has one definition, and these are the properties of it that broke
 * when it had two.
 */
const state = (over: Partial<MapState> = {}): MapState => ({ ...IDLE, ...over });

/** Pull the value of the "selected" and "otherwise" branches out of a
 *  zoom interpolate whose stops are `case` expressions. */
function branchesAt(expr: unknown, zoomStop: number): unknown[] {
  const e = expr as unknown[];
  for (let i = 3; i < e.length; i += 2)
    if (e[i] === zoomStop) return e[i + 1] as unknown[];
  throw new Error(`no stop at zoom ${zoomStop}`);
}

describe("stop sizing", () => {
  it("draws every unselected stop's dot at one size", () => {
    // The bug: the layer dropped its `interchange` branch and the selection
    // effect kept it, so an interchange dot evaluated to 3.5 and a lone stop's
    // to 2.5 at z14.2 -- while the white shapes under them agreed exactly.
    const at16 = branchesAt(stopRadius(state()), 16);
    expect(JSON.stringify(at16)).not.toContain("interchange");
    // ["case", <isFocus>, focusR, <isEnd>, endR, defaultR]
    expect(at16[at16.length - 1]).toBe(4.5);
  });

  it("grows the tapped stop, and only it", () => {
    const small = branchesAt(stopRadius(state({ stopFocus: "s9", grow: 0 })), 16);
    const full = branchesAt(stopRadius(state({ stopFocus: "s9", grow: 1 })), 16);
    expect(small[2]).toBe(4.5);           // starts at the ordinary size
    expect(full[2]).toBe(6.5);            // ends bigger
    expect(full[full.length - 1]).toBe(4.5);   // everything else unchanged
  });

  it("marks a ride's ends without inventing a second symbol", () => {
    const r = JSON.stringify(stopRadius(state({ ends: ["a", "b"] })));
    expect(r).toContain('"a"');
    expect(r).toContain('"b"');
  });
});

describe("emphasis", () => {
  it("recedes rather than erases", () => {
    // At 0.15 an unselected stop was indistinguishable from the basemap, so
    // picking a route did not narrow the map so much as erase most of it.
    expect(DIM).toBeGreaterThan(0.3);
    expect(DIM).toBeLessThan(0.6);
  });

  it("leaves everything at full strength when nothing is picked", () => {
    expect(stopPaint(state())["circle-opacity"]).toBe(1);
    expect(routeLinePaint(state())["line-opacity"]).toBe(1);
  });

  it("dims a stop's dot and its lozenge together", () => {
    // They are one symbol in two layers; fading one without the other leaves a
    // bright ring around a faint dot.
    const s = state({ routeFocus: "R1" });
    expect(JSON.stringify(stopPaint(s)["circle-opacity"]))
      .toBe(JSON.stringify(stopBasePaint(s)["circle-opacity"]));
    expect(JSON.stringify(tickPaint(s, false)["line-opacity"]))
      .toBe(JSON.stringify(stopPaint(s)["circle-opacity"]));
  });

  it("fades every route during a trip, the ridden one included", () => {
    // The ridden SEGMENT is drawn brightly on top by the itinerary layer;
    // leaving the whole loop lit made the two impossible to tell apart.
    expect(routeLinePaint(state({ ridden: ["62487"] }))["line-opacity"]).toBe(DIM);
  });
});

describe("the lozenge and the bar are one shape", () => {
  it("sizes the bar to the circle it degenerates into", () => {
    // A lone stop is the circular case of the interchange bar. The bar's body
    // is 2 x the circle's radius and its edge adds the circle's stroke, so the
    // two cannot look like different symbols.
    const s = state();
    const radius = stopBasePaint(s)["circle-radius"] as unknown[];
    const stroke = stopBasePaint(s)["circle-stroke-width"] as unknown[];
    const body = tickPaint(s, false)["line-width"] as unknown[];
    const edge = tickPaint(s, true)["line-width"] as unknown[];
    for (const [i, zoom] of [[3, 13], [5, 16]] as const) {
      expect(radius[i + 1]).toBe(zoom === 13 ? 4.5 : 8);
      expect(body[i + 1]).toBe(2 * (radius[i + 1] as number));
      expect(edge[i + 1]).toBe((body[i + 1] as number) + 2 * (stroke[i + 1] as number));
    }
  });

  it("keeps the bar light in both themes", () => {
    // Painted the map's own background colour it was a background-coloured
    // shape behind a 2px rim: invisible by construction, at any width.
    expect(tickPaint(state({ dark: true }), false)["line-color"]).not.toBe("#15110F");
    expect(tickPaint(state({ dark: false }), false)["line-color"]).toBe("#FFFFFF");
  });
});
