/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StopCard } from "../src/ui/StopCard";
import { emptyHistory, recordSample } from "../src/data/serviceHistory";
import type { StaticFeed, Stop, Trip } from "../src/data/types";

const NOW = 1_700_000_000;                       // a Tuesday afternoon
const mk = (id: string, name: string): Stop => ({ id, name, lat: 41.82, lng: -71.40 });

/** A stop two routes call at, so stopRoutes() has something to report. */
const feed: StaticFeed = {
  routes: new Map([
    ["R1", { id: "R1", name: "Connector", shortName: "C", color: "#4F9BD9", shape: [] }],
    ["R2", { id: "R2", name: "Evening CW", shortName: "E", color: "#6A477C", shape: [] }],
  ]),
  stops: new Map([["S", mk("S", "Sciences Library")]]),
  trips: new Map<string, Trip>([
    ["T1", { id: "T1", routeId: "R1", stops: [{ stopId: "S", seq: 1, time: 0 }] }],
    ["T2", { id: "T2", routeId: "R2", stops: [{ stopId: "S", seq: 1, time: 0 }] }],
  ]),
  feedEndDate: "20991231",
};

const noop = () => {};
const show = (history?: Parameters<typeof StopCard>[0]["history"]) =>
  render(<StopCard stop={feed.stops.get("S")!} feed={feed} board={new Map()} now={NOW}
                   history={history} onBack={noop} onRouteClick={noop} onSetDestination={noop} />);

afterEach(cleanup);

describe("StopCard with nothing reporting", () => {
  it("says nothing about other days without a record", () => {
    show();
    expect(screen.getByText(/No shuttle is reporting/)).toBeTruthy();
    expect(screen.queryByText(/has been seen here/)).toBeNull();
  });

  it("reports the best-served route once enough has been watched", () => {
    // Four Tuesdays at this hour; the Connector ran on three, Evening CW on
    // one. A rider deciding whether to wait cares about the better one.
    let h = emptyHistory("2026-07-01");
    for (let i = 0; i < 4; i++) {
      const at = new Date((NOW + i * 7 * 86_400) * 1000);
      h = recordSample(h, i < 3 ? ["R1"] : ["R2"], at);
    }
    show(h);
    expect(screen.getByText(/Connector has been seen here/)).toBeTruthy();
    expect(screen.getByText(/3 of the 4 days/)).toBeTruthy();
  });

  it("still says so when a route has never been seen at this hour", () => {
    // Worth telling someone before they wait.
    let h = emptyHistory("2026-07-01");
    for (let i = 0; i < 4; i++)
      h = recordSample(h, [], new Date((NOW + i * 7 * 86_400) * 1000));
    show(h);
    expect(screen.getByText(/0 of the 4 days/)).toBeTruthy();
  });
});
