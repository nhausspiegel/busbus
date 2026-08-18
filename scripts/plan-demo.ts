/** Terminal proof that objective 1 works end to end, before any UI exists.
 *  Usage: npx tsx scripts/plan-demo.ts [fromLat,fromLng] [toLat,toLng] */
import { findItineraries } from "../src/routing/trip";
import { fetchStaticFeed } from "../src/data/gtfs";

const parse = (s: string | undefined, fallback: { lat: number; lng: number }) => {
  if (!s) return fallback;
  const [lat, lng] = s.split(",").map(Number);
  return { lat: lat!, lng: lng! };
};

const from = parse(process.argv[2], { lat: 41.826195, lng: -71.404656 }); // John Hay Library
const to = parse(process.argv[3], { lat: 41.817892, lng: -71.406899 });   // South Street Landing

const fmt = (t: number) =>
  new Date(t * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const mins = (s: number) => `${Math.round(s / 60)} min`;

const feed = await fetchStaticFeed();
const nameOf = (id: string) => feed.stops.get(id)?.name ?? id;
const routeOf = (id: string) => feed.routes.get(id)?.name ?? id;

console.log(`from ${from.lat},${from.lng}  ->  to ${to.lat},${to.lng}`);
console.log(`now  ${new Date().toLocaleString("en-US")}\n`);

const its = await findItineraries(from, to);
if (its.length === 0) {
  console.log("No itineraries. No shuttle currently connects these two points.");
} else {
  console.log(`${its.length} option(s), earliest arrival first:\n`);
  its.forEach((it, n) => {
    console.log(`[${n + 1}] ARRIVE ${fmt(it.arriveTime)}   leave by ${fmt(it.departTime)}   ` +
      `${mins(it.totalWalkSeconds)} walking, ${it.transfers} transfer(s)`);
    console.log(`     walk ${mins(it.walkToStop.seconds)} to ${nameOf(it.rides[0]!.boardStopId)}`);
    for (const r of it.rides) {
      console.log(`     ${fmt(r.departTime)} board ${routeOf(r.routeId)} at ${nameOf(r.boardStopId)}` +
        `${r.live ? "  [live]" : "  [scheduled]"}`);
      console.log(`     ${fmt(r.arriveTime)} alight at ${nameOf(r.alightStopId)} (${r.numStops} stops)`);
    }
    console.log(`     walk ${mins(it.walkFromStop.seconds)} to destination\n`);
  });
}
