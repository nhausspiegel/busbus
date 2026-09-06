/** Which view the sheet is showing.
 *
 *  Pulled out of App so the precedence is stated once and can be tested. Every
 *  entry point into a mode must clear the states above it, or the sheet keeps
 *  rendering the previous view while the rest of the app has moved on. */
export type Mode = "searching" | "nearby" | "results" | "detail" | "route" | "stop";

export interface ViewState {
  stopId: string | null;
  routeId: string | null;
  chosen: boolean;
  dest: boolean;
  /** The rider is typing in the search bar. Highest precedence: tapping the
   *  bar is a request to search whatever else is on screen, and it must not
   *  discard the destination to get there.
   *
   *  This lived inside SearchBar as local state, invisible to App, so `mode`
   *  stayed "nearby" through every keystroke. Everything that reads `mode` to
   *  decide what chrome to show was therefore wrong while searching. */
  searching: boolean;
}

export function resolveMode(s: ViewState): Mode {
  if (s.searching) return "searching";
  if (s.stopId) return "stop";
  if (s.routeId) return "route";
  if (s.chosen) return "detail";
  if (s.dest) return "results";
  return "nearby";
}
