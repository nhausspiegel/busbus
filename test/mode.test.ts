import { describe, it, expect } from "vitest";
import { resolveMode, type ViewState } from "../src/ui/mode";

/** The sheet shows exactly one view, chosen by precedence. Setting a
 *  destination while a stop card was open used to leave the stop card on
 *  screen with the itineraries reachable only via Back, because
 *  pickDestination set `dest` without clearing the states above it. */
const base: ViewState = { stopId: null, routeId: null, chosen: false, dest: false,
                          searching: false };

describe("resolveMode", () => {
  it("falls back to the nearby board", () => {
    expect(resolveMode(base)).toBe("nearby");
  });

  it("shows results once a destination is set", () => {
    expect(resolveMode({ ...base, dest: true })).toBe("results");
  });

  it("shows the chosen itinerary over the results list", () => {
    expect(resolveMode({ ...base, dest: true, chosen: true })).toBe("detail");
  });

  it("shows a route page over an itinerary", () => {
    expect(resolveMode({ ...base, dest: true, chosen: true, routeId: "3302" })).toBe("route");
  });

  it("shows a stop card over everything", () => {
    expect(resolveMode({ ...base, stopId: "7865", routeId: "3302", chosen: true, dest: true }))
      .toBe("stop");
  });

  /** Typing is a view in its own right. It used to be invisible here: the
   *  search bar kept `open` in its own state, so `mode` stayed "nearby"
   *  through every keystroke. That one omission is why the when-controls
   *  showed while searching, why the sheet never rose for the keyboard, and
   *  why the suggestion list could not be part of the sheet body. */
  it("shows the search view while the rider is typing", () => {
    expect(resolveMode({ ...base, searching: true })).toBe("searching");
  });

  it("keeps showing search over a destination already picked", () => {
    // Tapping the bar with a route on screen must return to search without
    // throwing the destination away.
    expect(resolveMode({ ...base, dest: true, searching: true })).toBe("searching");
  });

  it("shows search over a stop card, a route page and a chosen itinerary", () => {
    expect(resolveMode({ stopId: "7865", routeId: "3302", chosen: true, dest: true,
                         searching: true })).toBe("searching");
  });
});

describe("clearing for a new view", () => {
  it("picking a destination clears every higher-priority view", () => {
    // This is the assertion that would have caught the bug: after choosing a
    // destination the rider must see results, not whatever was open before.
    const after: ViewState = { ...base, dest: true };
    expect(resolveMode(after)).toBe("results");
  });

  it("clearing the destination returns to the nearby board", () => {
    const after: ViewState = { ...base };
    expect(resolveMode(after)).toBe("nearby");
  });
});
