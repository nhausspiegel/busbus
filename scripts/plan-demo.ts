/** Terminal check that routefinding works end to end.
 *
 *  Default case is 129 Angell Street <-> Trader Joe's on South Main, run in
 *  both directions: the trip is downhill one way and up College Hill the
 *  other, so the two directions are genuinely different problems.
 *
 *  Usage: npx tsx scripts/plan-demo.ts [fromLat,fromLng] [toLat,toLng] */
import { findItineraries } from "../src/routing/trip";
import { fetchStaticFeed } from "../src/data/gtfs";

const ANGELL = { lat: 41.8278062, lng: -71.4024241, label: "129 Angell St" };
const TRADER_JOES = { lat: 41.8182465, lng: -71.4004397, label: "Trader Joe's" };

const parse = (s: string | undefined) => {
  if (!s) return null;
  const [lat, lng] = s.split(",").map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng)
    ? { lat: lat!, lng: lng!, label: s } : null;
};

const a = parse(process.argv[2]);
const b = parse(process.argv[3]);
const pairs = a && b ? [[a, b]] : [[ANGELL, TRADER_JOES], [TRADER_JOES, ANGELL]];

const fmt = (t: number) =>
  new Date(t * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const mins = (s: number) => `${Math.round(s / 60)} min`;

const feed = await fetchStaticFeed();
const stopName = (id: string) => feed.stops.get(id)?.name ?? id;
const routeName = (id: string) => feed.routes.get(id)?.name ?? id;

console.log(`now ${new Date().toLocaleString("en-US")}\n`);

for (const [from, to] of pairs) {
  console.log(`${"=".repeat(62)}\n${from!.label}  ->  ${to!.label}\n`);
  const its = await findItineraries(from!, to!);
  if (its.length === 0) {
    console.log("  No option: no shuttle connects these points and it is too far to walk.\n");
    continue;
  }
  its.forEach((it, n) => {
    const kind = it.rides.length === 0 ? "WALK" : `${it.rides.length} ride(s)`;
    console.log(`  [${n + 1}] arrive ${fmt(it.arriveTime)}  (${kind}, ${mins(it.totalWalkSeconds)} walking)`);
    if (it.rides.length === 0) {
      console.log(`      walk the whole way -- no waiting\n`);
      return;
    }
    console.log(`      walk ${mins(it.walkToStop.seconds)} to ${stopName(it.rides[0]!.boardStopId)}`);
    for (const r of it.rides)
      console.log(`      ${fmt(r.departTime)} ${routeName(r.routeId)} -> ${fmt(r.arriveTime)} ` +
        `${stopName(r.alightStopId)} (${r.numStops} stops${r.live ? ", live" : ", scheduled"})`);
    console.log(`      walk ${mins(it.walkFromStop.seconds)} to destination\n`);
  });
}
