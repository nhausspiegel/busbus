/** Which view the sheet is showing.
 *
 *  Pulled out of App so the precedence is stated once and can be tested. Every
 *  entry point into a mode must clear the states above it, or the sheet keeps
 *  rendering the previous view while the rest of the app has moved on. */
export type Mode = "nearby" | "results" | "detail" | "route" | "stop";

export interface ViewState {
  stopId: string | null;
  routeId: string | null;
  chosen: boolean;
  dest: boolean;
}

export function resolveMode(s: ViewState): Mode {
  if (s.stopId) return "stop";
  if (s.routeId) return "route";
  if (s.chosen) return "detail";
  if (s.dest) return "results";
  return "nearby";
}
