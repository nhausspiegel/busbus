/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ItineraryDetail } from "../src/ui/Itineraries";
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
  departTime: NOW + 300, arriveTime: NOW + 780, live: true, numStops: 3, ...o,
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

const show = (r: RideLeg = ride(), f: StaticFeed | null = feed) =>
  render(<ItineraryDetail itinerary={itinerary(r)} feed={f} now={NOW} onBack={() => {}} />);

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
