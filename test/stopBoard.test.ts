import { describe, it, expect } from "vitest";
import { stopBoard } from "../src/routing/stopBoard";
import type { DepartureBoard, Departure } from "../src/data/types";

const NOW = 1_700_000_000;
const d = (routeId: string, time: number): Departure =>
  ({ stopId: "S", tripId: `${routeId}-${time}`, routeId, seq: 1, time, live: false });

describe("stopBoard", () => {
  const board: DepartureBoard = new Map([["S", [
    d("A", NOW - 30), d("A", NOW + 60), d("A", NOW + 300), d("A", NOW + 900),
    d("B", NOW + 120),
  ]]]);

  it("drops departures that already left", () => {
    expect(stopBoard(board, "S", NOW).every((x) => x.time >= NOW)).toBe(true);
  });

  it("caps each route so one frequent route cannot crowd out the others", () => {
    const got = stopBoard(board, "S", NOW);
    expect(got.filter((x) => x.routeId === "A")).toHaveLength(2);
    expect(got.some((x) => x.routeId === "B")).toBe(true);
  });

  it("returns everything in time order across routes", () => {
    const times = stopBoard(board, "S", NOW).map((x) => x.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("returns empty for a stop with no service", () => {
    expect(stopBoard(board, "nope", NOW)).toEqual([]);
  });
});
