import type { LatLng, StaticFeed } from "./types";

/**
 * Route geometry taken from the street network itself.
 *
 * Passio traces each pass down its own side of the road, so two routes on one
 * street arrive 0-9m apart and a route's own two passes about 9m. The renderer
 * fans coincident lines into lanes, but only up to a FLOOR -- wherever the
 * traced separation already exceeded the lane gap, the source's METRES survived
 * into the drawing, and a gap that is meant to be purely visual grew as the
 * rider zoomed in. Measured on the traced shapes, the two Evening routes sat
 * 3.7px apart at zoom 13 and 13.5px at zoom 18 for a "5px" lane.
 *
 * `scripts/snap-to-streets.ts` puts every route on the OSM centreline of the
 * road it actually drives and emits the sequence of node ids it traverses. All
 * coordinates come from ONE shared table, so two routes down one street have
 * identical geometry -- not close, identical. Their separation is therefore
 * zero, the floor becomes an exact gap, and every pixel between them is one the
 * renderer chose rather than one Passio's tracing left behind. Measured after:
 * exactly 5.00px at zoom 15 and above.
 *
 * The renderer is unchanged. This is a data fix, which is what it always was.
 */
export interface SnappedShapes {
  /** OSM node id -> [lng, lat]. Shared, which is the whole point. */
  nodes: Record<string, [number, number]>;
  /** Route id -> the node ids it drives, in order. */
  routes: Record<string, number[]>;
}

/** Turn the node sequences into polylines. Pure, so a test can check that two
 *  routes sharing a street really do come out with identical coordinates. */
export function parseSnapped(payload: unknown): Map<string, LatLng[]> {
  const out = new Map<string, LatLng[]>();
  const p = payload as SnappedShapes | null;
  if (!p?.nodes || !p?.routes) return out;
  for (const [routeId, ids] of Object.entries(p.routes)) {
    if (!Array.isArray(ids)) continue;
    const pts: LatLng[] = [];
    for (const id of ids) {
      const c = p.nodes[String(id)];
      if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
      pts.push({ lat: c[1], lng: c[0] });
    }
    if (pts.length >= 2) out.set(routeId, pts);
  }
  return out;
}

/** Replace a route's traced shape with its snapped one.
 *
 *  Unlike fillMissingShapes this DOES overwrite what the GTFS carries, on
 *  purpose: the traced shape is not wrong about where the route goes, it is
 *  wrong about which side of the road it goes down, and that is the defect. A
 *  route with no snapped geometry keeps its trace. */
export function withSnappedShapes(feed: StaticFeed, snapped: Map<string, LatLng[]>): StaticFeed {
  for (const route of feed.routes.values()) {
    const pts = snapped.get(route.id);
    if (pts) route.shape = pts;
  }
  return feed;
}
