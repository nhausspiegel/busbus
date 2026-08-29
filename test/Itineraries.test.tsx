/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ItineraryDetail, ItineraryList } from "../src/ui/Itineraries";
import { parseWalkRoute, type WalkStep } from "../src/routing/walk";
import type { Itinerary, RideLeg, StaticFeed, Stop } from "../src/data/types";

afterEach(cleanup);

const NOW = 1_700_000_000;
const at = (lat: number, lng: number) => ({ lat, lng });
const mk = (id: string, name: string): Stop => ({ id, name, lat: 41.82, lng: -71.40 });

/** One looping trip, the shape of a real shuttle: A -> B -> C -> D -> A. */
const feed: StaticFeed = {
  routes: new Map([["R1", { id: "R1", name: "Brown Line", shortName: "BL", color: "#B15B2E", shape: [] }]]),
  stops: new Map([
    ["A", mk("A", "Thayer & Waterman")],
    ["B", mk("B", "Barus & Holley")],
    ["C", mk("C", "Hope & Olney")],
    ["D", mk("D", "Trader Joe's")],
  ]),
  trips: new Map([["T1", { id: "T1", routeId: "R1", stops: [
    { stopId: "A", seq: 1, time: 0 },
    { stopId: "B", seq: 2, time: 120 },
    { stopId: "C", seq: 3, time: 300 },
    { stopId: "D", seq: 4, time: 480 },
    { stopId: "A", seq: 5, time: 600 },
  ] }]]),
  feedEndDate: "20991231",
};

const ride = (o: Partial<RideLeg> = {}): RideLeg => ({
  routeId: "R1", tripId: "T1", boardStopId: "A", alightStopId: "D",
  departTime: NOW + 300, arriveTime: NOW + 780, live: true, numStops: 3, boardSeq: 1, ...o,
});

const itinerary = (r: RideLeg): Itinerary => ({
  arriveTime: r.arriveTime + 120,
  departTime: NOW,
  walkToStop: { from: at(41.82, -71.40), to: at(41.82, -71.40), seconds: 180 },
  rides: [r],
  walkFromStop: { from: at(41.82, -71.40), to: at(41.82, -71.40), seconds: 120 },
  totalWalkSeconds: 300,
  transfers: 0,
  allLive: r.live,
});

const show = (
  r: RideLeg = ride(), f: StaticFeed | null = feed,
  directions?: { toStop: WalkStep[]; fromStop: WalkStep[] },
) =>
  render(<ItineraryDetail itinerary={itinerary(r)} feed={f} now={NOW}
                          directions={directions} onBack={() => {}} />);

const toggle = () => screen.getByRole("button", { name: /stops/i });

describe("ItineraryDetail ride stops", () => {
  it("stays collapsed by default -- this is read standing at a stop", () => {
    show();
    expect(screen.queryByText("Barus & Holley")).toBeNull();
    expect(screen.queryByText("Hope & Olney")).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("names the intermediate stops, in order, once expanded", () => {
    show();
    fireEvent.click(toggle());
    const b = screen.getByText("Barus & Holley");
    const c = screen.getByText("Hope & Olney");
    // Riding order matters more than the names: C is three stops after B on
    // the loop, and a rider watching out of the window needs them that way up.
    expect(b.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reports its own state, and collapses again", () => {
    show();
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Barus & Holley")).toBeNull();
  });

  it("times the intermediate stops from when the bus actually leaves", () => {
    // Boarding is at NOW+300, and B is 120s past A in the timetable, so B is
    // NOW+420 -- not the timetable's own clock time.
    show();
    fireEvent.click(toggle());
    const row = screen.getByText("Barus & Holley").closest("li");
    const expected = new Date((NOW + 420) * 1000)
      .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    expect(row?.textContent).toContain(expected);
  });

  it("does not repeat the boarding and alighting stops the step already names", () => {
    show();
    fireEvent.click(toggle());
    const list = document.querySelector("ol ol");   // the disclosed list, not the step list
    expect(list).not.toBeNull();
    expect(list?.textContent).not.toContain("Thayer & Waterman");
    expect(list?.textContent).not.toContain("Trader Joe's");
  });

  it("says what the disclosed list is, so the ride length is not counted as rows", () => {
    // "3 stops" is the length of the ride, the same thing Apple Maps means by
    // it. The list below is what you pass ON the way, which is one fewer. Both
    // numbers are right; without a label the reader counts rows and concludes
    // one of them is wrong.
    show();
    fireEvent.click(toggle());
    expect(screen.getByText(/3 stops/)).toBeTruthy();
    expect(screen.getByText(/on the way/i)).toBeTruthy();
  });

  it("offers no control when there is nothing between the two stops", () => {
    show(ride({ alightStopId: "B", arriveTime: NOW + 420, numStops: 1 }));
    expect(screen.queryByRole("button", { name: /stops/i })).toBeNull();
    expect(screen.getByText(/1 stop/)).toBeTruthy();
  });

  it("offers no control before the feed has loaded", () => {
    show(ride(), null);
    expect(screen.queryByRole("button", { name: /stops/i })).toBeNull();
  });
});

/** The maneuvers of a real Valhalla pedestrian response, parsed by the same
 *  function the app uses -- so these assertions are against Valhalla's own
 *  wording and its kilometres, not a hand-written idea of them. */
const REAL = parseWalkRoute(
  JSON.parse(readFileSync("test/fixtures/valhalla-walk-route.json", "utf8"))).steps;

/** A second, distinguishable leg. 119.8 m is deliberately unrounded. */
const IVES: WalkStep[] = [
  { instruction: "Turn right onto Ives Street.", metres: 119.8, seconds: 91 },
  { instruction: "You have arrived at your destination.", metres: 0, seconds: 0 },
];

const dirs = { toStop: REAL, fromStop: IVES };
const openers = () => screen.getAllByRole("button", { name: /directions/i });

describe("ItineraryDetail walking directions", () => {
  it("stays collapsed by default -- this is read standing at a stop", () => {
    show(ride(), feed, dirs);
    expect(screen.queryByText(/Walk west on the walkway/)).toBeNull();
    expect(screen.queryByText(/Turn right onto Ives Street/)).toBeNull();
    expect(openers()).toHaveLength(2);
    expect(openers()[0]!.getAttribute("aria-expanded")).toBe("false");
  });

  it("lists the maneuvers in walking order once expanded", () => {
    show(ride(), feed, dirs);
    fireEvent.click(openers()[0]!);
    const first = screen.getByText(/Walk west on the walkway/);
    const tenth = screen.getByText(/Turn right onto the crosswalk/);
    expect(first.compareDocumentPosition(tenth) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(openers()[0]!.getAttribute("aria-expanded")).toBe("true");
  });

  it("rounds distances to something a walker can act on", () => {
    show(ride(), feed, dirs);
    fireEvent.click(openers()[1]!);
    const row = screen.getByText(/Turn right onto Ives Street/).closest("li");
    expect(row?.textContent).toContain("120 m");
    expect(row?.textContent).not.toContain("119.8");
  });

  it("prints no distance for the arrival maneuver", () => {
    // Valhalla's last maneuver is zero-length. "You have arrived · 0 m" is noise.
    show(ride(), feed, dirs);
    fireEvent.click(openers()[1]!);
    const row = screen.getByText(/You have arrived/).closest("li");
    expect(row?.textContent).not.toContain("0 m");
  });

  it("puts each leg's directions under its own step", () => {
    // Both legs are fetched in one Promise.all and are trivially swappable;
    // the walk to the bus is not the walk from it.
    show(ride(), feed, dirs);
    fireEvent.click(openers()[1]!);
    expect(screen.queryByText(/Walk west on the walkway/)).toBeNull();
    expect(screen.getByText(/Turn right onto Ives Street/)).toBeTruthy();
  });

  it("gives the walk-only trip its directions too", () => {
    render(<ItineraryDetail feed={feed} now={NOW} directions={dirs} onBack={() => {}}
                            itinerary={{ ...itinerary(ride()), rides: [], totalWalkSeconds: 920 }} />);
    expect(openers()).toHaveLength(1);
    fireEvent.click(openers()[0]!);
    expect(screen.getByText(/Walk west on the walkway/)).toBeTruthy();
  });

  it("offers no control before Valhalla has answered", () => {
    show();
    expect(screen.queryByRole("button", { name: /directions/i })).toBeNull();
  });
});

describe("ItineraryList, in the shape Apple uses", () => {
  const list = (its: Itinerary[]) =>
    render(<ItineraryList itineraries={its} feed={feed} now={NOW}
                          selected={null} onSelect={() => {}} />);

  it("leads with how long the trip takes, not when it ends", () => {
    // The old headline was the arrival clock time, which makes two options
    // impossible to compare at a glance -- the rider has to subtract.
    // 3 min walk + 8 min ride + 2 min walk = 13.
    list([itinerary(ride())]);
    expect(screen.getByText("13 min")).toBeTruthy();
  });

  it("does not count the wait for the bus in that number", () => {
    // Otherwise a trip looks worse the earlier you look it up, which is
    // backwards. The wait is stated separately as a departure time.
    const soon = itinerary(ride({ departTime: NOW + 300, arriveTime: NOW + 780 }));
    const later = {
      ...soon,
      rides: [ride({ departTime: NOW + 3000, arriveTime: NOW + 3480 })],
      arriveTime: NOW + 3600,
    };
    list([soon]);
    const a = screen.getByText("13 min");
    cleanup();
    list([later]);
    expect(screen.getByText("13 min")).toBeTruthy();
    expect(a).toBeTruthy();
  });

  it("says when the bus leaves, and when you arrive", () => {
    list([itinerary(ride())]);
    expect(screen.getByText(/Bus departs at/)).toBeTruthy();
    expect(screen.getByText(/ETA/)).toBeTruthy();
  });

  it("drops 'leave in N min' and the aggregate walk time", () => {
    // Both were summaries of the journey that matched no part of it.
    list([itinerary(ride())]);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Leave in \d+ min/);
    expect(text).not.toMatch(/\d+ min walking/);
    expect(text).not.toMatch(/direct|transfer/);
  });

  it("shows each walk with its own time, in order", () => {
    // 3 minutes to the stop and 2 from it, not one "5 min walking".
    list([itinerary(ride())]);
    expect(screen.getByText("Walk 3 min")).toBeTruthy();
    expect(screen.getByText("Walk 2 min")).toBeTruthy();
  });

  it("shows a walk-only trip as a single walk", () => {
    const walkOnly: Itinerary = {
      ...itinerary(ride()), rides: [], arriveTime: NOW + 900, totalWalkSeconds: 900,
    };
    list([walkOnly]);
    expect(screen.getByText("Walk 15 min")).toBeTruthy();
    expect(screen.queryByText(/Bus departs/)).toBeNull();
  });

  it("says when to leave for a walk that does not start now", () => {
    // Arrive-by anchors the walk on the DEADLINE, so its departure can be
    // hours away. The row said "Leave now" regardless and printed the deadline
    // beside it as the ETA -- "Leave now, 6:30 PM ETA" for a twenty minute
    // walk at two in the afternoon, which is two contradictory instructions in
    // one line.
    const later: Itinerary = {
      ...itinerary(ride()), rides: [],
      departTime: NOW + 4 * 3600, arriveTime: NOW + 4 * 3600 + 900,
      totalWalkSeconds: 900,
    };
    list([later]);
    expect(screen.queryByText(/Leave now/)).toBeNull();
    expect(screen.getByText(/Leave at/)).toBeTruthy();
  });

  it("does not say leave now for a trip planned hours ahead", () => {
    // Planning to leave at 6:30pm makes the PLANNING clock 6:30pm, so a walk
    // departing then is "now" by that clock. At two in the afternoon the row
    // said "Leave now" and the rider would have left immediately.
    const evening: Itinerary = {
      ...itinerary(ride()), rides: [],
      departTime: NOW + 4 * 3600, arriveTime: NOW + 4 * 3600 + 900,
      totalWalkSeconds: 900,
    };
    render(<ItineraryList itineraries={[evening]} feed={feed}
                          now={NOW + 4 * 3600} realNow={NOW} onSelect={() => {}} />);
    expect(screen.queryByText(/Leave now/)).toBeNull();
    expect(screen.getByText(/Leave at/)).toBeTruthy();
  });

  it("still says leave now when the walk starts now", () => {
    const soon: Itinerary = {
      ...itinerary(ride()), rides: [],
      departTime: NOW, arriveTime: NOW + 900, totalWalkSeconds: 900,
    };
    list([soon]);
    expect(screen.getByText(/Leave now/)).toBeTruthy();
  });
});

describe("ItineraryDetail's departure line", () => {
  const walk = (departIn: number): Itinerary => ({
    ...itinerary(ride()), rides: [],
    departTime: NOW + departIn, arriveTime: NOW + departIn + 900, totalWalkSeconds: 900,
  });

  it("counts down while the countdown is short", () => {
    render(<ItineraryDetail itinerary={walk(600)} feed={feed} now={NOW} onBack={() => {}} />);
    expect(screen.getByText(/Leave in 10 min/)).toBeTruthy();
  });

  it("gives a clock time once counting down stops helping", () => {
    // "Leave in 289 min" is arithmetic homework, not an instruction.
    render(<ItineraryDetail itinerary={walk(4 * 3600)} feed={feed} now={NOW} onBack={() => {}} />);
    expect(screen.queryByText(/Leave in/)).toBeNull();
    expect(screen.getByText(/Leave at/)).toBeTruthy();
  });
});
