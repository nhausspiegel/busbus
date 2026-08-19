import { IS_NODE, PRIVATE_BASE, SYSTEM_ID, USER_AGENT } from "./passio";
import type { Bus } from "./vehicles";

/** Exact passenger counts for one bus. */
export interface Occupancy { busId: string; paxLoad: number; totalCap: number }

/** Rider-facing summary of how full a bus is. */
export interface Fullness { pct: number | null; label: string }

/** GTFS-RT only carries a coarse enum (MANY_SEATS_AVAILABLE …). Passio's own
 *  endpoint carries the real numbers -- 1/11, 3/20 -- which is what a rider
 *  deciding whether to wait for the next one actually wants. */
export async function fetchOccupancy(): Promise<Map<string, Occupancy>> {
  const res = await fetch(`${PRIVATE_BASE}/mapGetData.php?getBuses=2`, {
    method: "POST",
    // User-Agent only under Node: in a browser it is a forbidden header, and
    // asking for it turns this into a preflight passiogo.com does not answer.
    headers: { "Content-Type": "application/json", ...(IS_NODE ? { "User-Agent": USER_AGENT } : {}) },
    body: JSON.stringify({ s0: SYSTEM_ID, sA: 1 }),
  });
  if (!res.ok) throw new Error(`getBuses -> HTTP ${res.status}`);
  return parseOccupancy(await res.json());
}

/** Pull exact counts out of Passio's getBuses payload.
 *
 *  Shape is `{"buses": {"<deviceId>": [ {...} ]}}` -- one array per device,
 *  and the fields arrive as a mix of strings and numbers. */
export function parseOccupancy(payload: unknown): Map<string, Occupancy> {
  const out = new Map<string, Occupancy>();
  const buses = (payload as { buses?: Record<string, unknown[]> })?.buses;
  if (!buses || typeof buses !== "object") return out;

  for (const entry of Object.values(buses)) {
    const b = Array.isArray(entry) ? entry[0] : entry;
    if (!b || typeof b !== "object") continue;
    const r = b as Record<string, unknown>;
    const busId = r["busId"];
    const pax = Number(r["paxLoad"]);
    const cap = Number(r["totalCap"]);
    if (busId === undefined || busId === null) continue;
    if (!Number.isFinite(pax)) continue;
    out.set(String(busId), {
      busId: String(busId),
      paxLoad: pax,
      totalCap: Number.isFinite(cap) ? cap : 0,
    });
  }
  return out;
}

/** Attach exact counts to vehicles. A bus with no match keeps whatever it had;
 *  a bus present only in the private feed is not invented into existence. */
export function mergeOccupancy(buses: Bus[], counts: Map<string, Occupancy>): Bus[] {
  if (counts.size === 0) return buses;
  return buses.map((b) => {
    const o = counts.get(String(b.id));
    return o ? { ...b, paxLoad: o.paxLoad, totalCap: o.totalCap } : b;
  });
}

/** How full, in words a rider can act on.
 *
 *  Thresholds describe what boarding feels like, not evenly-spaced quarters:
 *  a bus at 80% of a 14-seat shuttle still has seats, and one over capacity
 *  means standing. `totalCap` of 0 means Passio did not report a capacity, so
 *  the honest answer is a count without a proportion. */
export function fullness(paxLoad?: number, totalCap?: number): Fullness | null {
  if (paxLoad === undefined || !Number.isFinite(paxLoad)) return null;
  if (!totalCap || !Number.isFinite(totalCap) || totalCap <= 0) {
    return { pct: null, label: `${paxLoad} aboard` };
  }
  const pct = Math.round((paxLoad / totalCap) * 100);
  const label =
    pct >= 100 ? "Full" :
    pct >= 75 ? "Standing room" :
    pct >= 40 ? "Filling up" :
    "Seats free";
  return { pct, label };
}
