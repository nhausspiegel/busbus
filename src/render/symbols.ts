/**
 * What every map symbol looks like, in one place, as a function of state.
 *
 * The paint used to be written twice: once where the layer is added and again
 * in the selection effect, which re-set several properties on every change.
 * The two drifted, silently. Measured at z14.2, an interchange dot evaluated to
 * 3.5 and a lone stop's to 2.5 -- while the white shapes under them agreed
 * exactly at 14.2px -- because the effect was still carrying an `interchange`
 * branch the layer had dropped. Nothing announced it; the map just looked
 * slightly wrong in a way nobody could name.
 *
 * A symbol has one definition here. The layer is created from it and the
 * selection effect re-applies the same function with different state, so the
 * two cannot disagree about anything, ever.
 */
import type { ExpressionSpecification } from "maplibre-gl";

/** Recessive, not invisible. At 0.15 an unselected stop was indistinguishable
 *  from the basemap, so picking a route did not narrow the map so much as
 *  erase most of it. */
export const DIM = 0.38;

/** How long any emphasis change takes to settle. */
export const EMPHASIS_MS = 220;

export interface MapState {
  dark: boolean;
  /** The stop the rider has tapped, if any. */
  stopFocus: string | null;
  /** The route the rider has selected, if any. */
  routeFocus: string | null;
  /** Routes the chosen itinerary rides. */
  ridden: string[];
  /** Stops the itinerary boards and alights at, by their bead id. */
  ends: string[];
  /** How far the selected stop has grown into place, 0 to 1. */
  grow: number;
}

export const IDLE: MapState = {
  dark: false, stopFocus: null, routeFocus: null, ridden: [], ends: [], grow: 0,
};

/** True for a feature carrying any of `routes` in its pipe-delimited list. */
function servesAny(routes: string[]): ExpressionSpecification | null {
  if (routes.length === 0) return null;
  return ["any", ...routes.map((r): ExpressionSpecification =>
    ["in", `|${r}|`, ["get", "routes"]])];
}

/** How strongly a stop is drawn: the tapped one, then the selected route's,
 *  then the ridden ones. Everything else recedes. */
function stopEmphasis(s: MapState): ExpressionSpecification | number {
  if (s.stopFocus) return ["case", ["==", ["get", "id"], s.stopFocus], 1, DIM];
  const lit = servesAny(s.routeFocus ? [s.routeFocus] : s.ridden);
  return lit ? ["case", lit, 1, DIM] : 1;
}

/** The dot: solid, in its line's colour, sitting on the lozenge.
 *
 *  No `interchange` branch. The dot is the same size in both cases -- what
 *  differs is the lozenge underneath it. */
export function stopRadius(s: MapState): ExpressionSpecification {
  const at = (base: number, big: number) => base + (big - base) * s.grow;
  // The ride's ends are drawn LARGER, not drawn again: an earlier version
  // added its own circles for them, in their own sizes, so the ends of a ride
  // were a different symbol from every other stop beside them on the line.
  const isEnd: ExpressionSpecification = ["in", ["get", "id"], ["literal", s.ends]];
  return ["interpolate", ["linear"], ["zoom"],
    13, ["case", ["==", ["get", "id"], s.stopFocus ?? ""], at(2.5, 4), isEnd, 4, 2.5],
    16, ["case", ["==", ["get", "id"], s.stopFocus ?? ""], at(4.5, 6.5), isEnd, 6.5, 4.5]];
}

/** Paint for the coloured dot at every stop. */
export function stopPaint(s: MapState): Record<string, unknown> {
  return {
    "circle-radius-transition": { duration: EMPHASIS_MS, delay: 0 },
    "circle-opacity-transition": { duration: EMPHASIS_MS, delay: 0 },
    "circle-stroke-opacity-transition": { duration: EMPHASIS_MS, delay: 0 },
    "circle-radius": stopRadius(s),
    "circle-color": ["get", "color"],
    "circle-stroke-color": s.dark ? "#F0E9E3" : "#FFFFFF",
    "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 13, 0.6, 16, 1.2],
    "circle-opacity": stopEmphasis(s),
    "circle-stroke-opacity": stopEmphasis(s),
  };
}

/** The lozenge under a lone stop -- the circular case of the interchange bar.
 *  Its sizes are shared with the bar so the two cannot drift apart. */
export function stopBasePaint(s: MapState): Record<string, unknown> {
  return {
    "circle-opacity-transition": { duration: EMPHASIS_MS, delay: 0 },
    "circle-radius-transition": { duration: EMPHASIS_MS, delay: 0 },
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 4.5, 16, 8],
    "circle-color": s.dark ? "#F0E9E3" : "#FFFFFF",
    "circle-stroke-color": s.dark ? "#0B0908" : "#241C17",
    "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 13, 1, 16, 1.5],
    "circle-opacity": stopEmphasis(s),
    "circle-stroke-opacity": stopEmphasis(s),
  };
}

/** The interchange bar, and its edge. Widths match the lone stop's lozenge:
 *  body = 2 x radius, case = body + 2 x stroke. */
export function tickPaint(s: MapState, edge: boolean): Record<string, unknown> {
  return {
    "line-opacity-transition": { duration: EMPHASIS_MS, delay: 0 },
    "line-color": edge
      ? (s.dark ? "#0B0908" : "#241C17")
      : (s.dark ? "#F0E9E3" : "#FFFFFF"),
    "line-width": edge
      ? ["interpolate", ["linear"], ["zoom"], 13, 11, 16, 19]
      : ["interpolate", ["linear"], ["zoom"], 13, 9, 16, 16],
    "line-opacity": stopEmphasis(s),
  };
}

/** The route lines. During a trip EVERY route fades, the ridden one included:
 *  the segment being ridden is drawn brightly on top by the itinerary layer,
 *  and leaving the whole loop lit made the two impossible to tell apart. */
export function routeLinePaint(s: MapState): Record<string, unknown> {
  // Full weight at zoom 16, not 14. A phone opens the app fitted to the whole
  // network, which lands about 14.2 -- so the old ramp hit its heaviest stroke
  // at exactly the scale where all five routes overlap each other, and a block
  // loop twenty metres across became one blob under six pixels of line.
  const width: ExpressionSpecification =
    ["interpolate", ["linear"], ["zoom"], 11, 1.5, 14, 3, 16, 4.5];
  let opacity: ExpressionSpecification | number = 1;
  if (s.routeFocus)
    opacity = ["case", ["==", ["get", "routeId"], s.routeFocus], 1, DIM];
  else if (s.stopFocus === null && s.ridden.length) opacity = DIM;
  return {
    "line-opacity-transition": { duration: EMPHASIS_MS, delay: 0 },
    "line-width-transition": { duration: EMPHASIS_MS, delay: 0 },
    "line-color": ["get", "color"],
    // The lane. In PIXELS, applied by the GPU, so the gap between two routes
    // sharing a street is the same width at every zoom -- which is the whole
    // reason none of this is computed as geometry any more.
    "line-offset": ["get", "laneOffset"],
    "line-width": s.routeFocus
      ? ["case", ["==", ["get", "routeId"], s.routeFocus], 6, 3] as ExpressionSpecification
      : width,
    "line-opacity": opacity,
  };
}
