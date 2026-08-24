/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RouteDetail } from "../src/ui/RouteDetail";
import type { StaticFeed, DepartureBoard, Stop } from "../src/data/types";
import type { Bus } from "../src/data/vehicles";

afterEach(cleanup);

const NOW = 1_700_000_000;

// A square loop with a stop at each corner, the shape of every Brown route.
const corners = [
  { lat: 41.820, lng: -71.400 }, { lat: 41.820, lng: -71.395 },
  { lat: 41.825, lng: -71.395 }, { lat: 41.825, lng: -71.400 },
];
const names = ["Thayer & Waterman", "Barus & Holley", "Hope & Olney", "Trader Joe's"];
const stops = new Map<string, Stop>(
  corners.map((c, i) => [`S${i}`, { id: `S${i}`, name: names[i]!, ...c }]));

const feed: StaticFeed = {
  routes: new Map([
    ["R1", { id: "R1", name: "Evening CW Route", shortName: "E", color: "#6A477C",
             shape: [...corners, corners[0]!] }],
    ["R2", { id: "R2", name: "Connector Route", shortName: "", color: "#FF7F0E", shape: [] }],
  ]),
  stops,
  trips: new Map([
    ["T1", { id: "T1", routeId: "R1", stops: corners.map((_, i) => ({ stopId: `S${i}`, seq: i + 1, time: i * 120 })) }],
    // A second route also calling at one stop, so it can appear as a connection.
    ["T2", { id: "T2", routeId: "R2", stops: [{ stopId: "S2", seq: 1, time: 0 }] }],
  ]),
  feedEndDate: "20991231",
};

const board: DepartureBoard = new Map(corners.map((_, i) => [`S${i}`, [
  { stopId: `S${i}`, tripId: "T1", routeId: "R1", seq: i + 1, time: NOW + (i + 1) * 120, live: false },
  { stopId: `S${i}`, tripId: "T9", routeId: "R1", seq: i + 1, time: NOW + (i + 1) * 120 + 900, live: false },
]]));

const active = new Set(["R1", "R2"]);
const noop = () => {};

/** A bus halfway up the leg from the second stop towards the third. */
const bus: Bus = {
  id: "b1", label: "105", routeId: "R1",
  lat: 41.8225, lng: -71.395, bearing: 0, occupancy: "MANY_SEATS_AVAILABLE",
};

const view = (buses: Bus[]) => render(
  <RouteDetail feed={feed} board={board} routeId="R1" buses={buses}
               now={NOW} activeRouteIds={active} onBack={noop} />);

describe("RouteDetail", () => {
  it("puts the bus in the list where it actually is, not at the top", () => {
    // Apple Maps draws the vehicle into the stop list so a rider can see at a
    // glance whether it has been past yet. The bus above is on the leg from
    // "Barus & Holley" towards "Hope & Olney", so it belongs between them.
    view([bus]);
    const items = [...document.querySelectorAll("li")].map((li) => li.textContent ?? "");
    const withBus = items.findIndex((t) => t.includes("Bus 105"));
    expect(withBus).toBeGreaterThan(-1);
    expect(items[withBus]).toContain("Hope & Olney");     // drawn above the stop it approaches
    expect(items[withBus]).not.toContain("Barus & Holley");
  });

  it("dims the stops the bus has already served", () => {
    view([bus]);
    const opacity = (name: string) => {
      const row = [...document.querySelectorAll("li")]
        .find((li) => li.textContent?.includes(name))!
        .querySelector<HTMLElement>("div:last-of-type")!;
      return row.style.opacity;
    };
    // Behind the bus, so faded; ahead of it, so at full strength.
    expect(Number(opacity("Thayer & Waterman") || "1")).toBeLessThan(1);
    expect(Number(opacity("Trader Joe's") || "1")).toBe(1);
  });

  it("leaves every stop at full strength when nothing is running", () => {
    view([]);
    for (const li of document.querySelectorAll("li")) {
      const row = li.querySelector<HTMLElement>("div:last-of-type");
      if (row) expect(Number(row.style.opacity || "1")).toBe(1);
    }
  });

  it("badges the other routes a rider can change to, but not this one", () => {
    view([]);
    // S2 is served by the Connector as well, so that stop carries its badge.
    expect(screen.getAllByText("Connector Route").length).toBeGreaterThan(0);
    // The route being viewed is not a connection from its own stops.
    expect(screen.queryByText("E")).toBeNull();
  });

  it("shows the typical gap between departures, not the next one", () => {
    // Departures at +2 and +17 minutes from the first stop: a 15 minute gap.
    view([]);
    expect(screen.getByText("Every 15 min")).toBeTruthy();
  });

  it("marks a timetable departure as scheduled, never as live", () => {
    // The rule this project is built on: a scheduled time is a weaker claim
    // and has to keep saying so.
    view([]);
    expect(screen.getAllByText("· Scheduled").length).toBeGreaterThan(0);
    expect(screen.queryByText("· Live")).toBeNull();
  });
});
