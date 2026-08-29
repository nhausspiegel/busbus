/**
 * Record when shuttles actually report, so the app can say when service runs.
 *
 * This is the one honest answer to "is there a bus at this hour". The
 * timetable cannot give it: calendar.txt is a single row marking every route
 * running daily through 2027 and the feed ships no calendar_dates.txt, so
 * there is no field in which "not running today" could be written. What can be
 * said is what was seen. So look, write down what was there, and let the app
 * state that record and nothing beyond it.
 *
 * Run from CI on a schedule; the output is committed.
 *
 *   npx tsx scripts/record-service.ts
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fetchVehicles } from "../src/data/vehicles";
import { emptyHistory, recordSample, type ServiceHistory } from "../src/data/serviceHistory";

const FILE = "public/service-history.json";

function load(today: string): ServiceHistory {
  if (!existsSync(FILE)) return emptyHistory(today);
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as ServiceHistory;
    // A file that does not have the shape we expect is not a reason to throw
    // away the record; it is a reason to stop and be looked at.
    if (!parsed?.days || !parsed?.seen) throw new Error("unrecognised history file");
    return parsed;
  } catch (e) {
    throw new Error(`${FILE} exists but could not be read: ${(e as Error).message}`);
  }
}

async function main() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const history = load(today);

  const buses = await fetchVehicles();
  // A route counts as running when a vehicle reports itself on it. No
  // inference from the schedule, and none from a bus sitting on another route.
  const running = [...new Set(buses.map((b) => b.routeId).filter(Boolean))];

  const next = recordSample(history, running, now);
  const label = `${buses.length} vehicles, routes running: ` +
    `${running.length ? running.sort().join(" ") : "(none)"}`;

  // Most runs change nothing but the timestamp: a bucket counts a date once,
  // so a sample every fifteen minutes only moves the record on the first run
  // of each hour. Writing anyway would mean a commit every run for no new
  // information, so the file is left alone unless the RECORD moved.
  const same = JSON.stringify([history.days, history.seen])
            === JSON.stringify([next.days, next.seen]);
  if (same) {
    console.log(`${now.toISOString()}  ${label} -- already recorded, file unchanged`);
    return;
  }
  writeFileSync(FILE, JSON.stringify(next));
  console.log(`${now.toISOString()}  ${label} -- recorded`);
}

await main();
