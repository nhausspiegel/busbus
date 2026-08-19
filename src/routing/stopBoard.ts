import type { DepartureBoard, Departure } from "../data/types";

/** Upcoming departures at one stop, soonest first, one entry per route.
 *
 *  A stop card answers "what can I catch from here", so listing the same route
 *  three times crowds out the other routes that also serve the stop. */
export function stopBoard(
  board: DepartureBoard, stopId: string, now: number, perRoute = 2,
): Departure[] {
  const byRoute = new Map<string, Departure[]>();
  for (const d of (board.get(stopId) ?? []).filter((x) => x.time >= now).sort((a, b) => a.time - b.time)) {
    const list = byRoute.get(d.routeId) ?? [];
    if (list.length < perRoute) { list.push(d); byRoute.set(d.routeId, list); }
  }
  return [...byRoute.values()].flat().sort((a, b) => a.time - b.time);
}
