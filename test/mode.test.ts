import { describe, it, expect } from "vitest";
import { resolveMode, type ViewState } from "../src/ui/mode";

/** The sheet shows exactly one view, chosen by precedence. Setting a
 *  destination while a stop card was open used to leave the stop card on
 *  screen with the itineraries reachable only via Back, because
 *  pickDestination set `dest` without clearing the states above it. */
const base: ViewState = { stopId: null, routeId: null, chosen: false, dest: false };

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
    expect(resolveMode({ stopId: "7865", routeId: "3302", chosen: true, dest: true })).toBe("stop");
  });
});

describe("clearing for a new view", () => {
  it("picking a destination clears every higher-priority view", () => {
    // This is the assertion that would have caught the bug: after choosing a
    // destination the rider must see results, not whatever was open before.
    const after: ViewState = { stopId: null, routeId: null, chosen: false, dest: true };
    expect(resolveMode(after)).toBe("results");
  });

  it("clearing the destination returns to the nearby board", () => {
    const after: ViewState = { stopId: null, routeId: null, chosen: false, dest: false };
    expect(resolveMode(after)).toBe("nearby");
  });
});
