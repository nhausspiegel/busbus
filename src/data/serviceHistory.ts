/**
 * What service was actually SEEN, so the app can say when buses run.
 *
 * The timetable cannot answer that question here. calendar.txt is a single row
 * marking every route running daily through 2027 and the feed carries no
 * calendar_dates.txt at all, so there is no field in which "not running today"
 * could ever be written -- which is why this app refuses to show a scheduled
 * time. The honest alternative is the one CLAUDE.md names: record when
 * vehicles really report, then state that history and nothing beyond it.
 *
 * Counted in DAYS rather than samples. A recorder running every ten minutes
 * drops six samples into an hour, so "seen in 30 of 36 samples" is a number
 * about the recorder; "seen on 5 of the last 6 Fridays at this hour" is a
 * claim a rider can act on.
 */

/** Providence. Buckets are built in local time because a rider reads them in
 *  local time -- bucketing in UTC would smear the evening across two weekdays
 *  and file the Evening routes under the wrong day. */
const ZONE = "America/New_York";

/** One day-TYPE-and-hour slot, as `wd|sa|su` + `-<00-23>`.
 *
 *  Keyed on the weekday this was `<0-6>-<hh>`, and a bucket could then only
 *  gain one day per WEEK -- so the three-day floor below took three weeks to
 *  clear and the app said nothing about service for most of a month. Grouping
 *  Mon-Fri makes a weekday bucket gain five days a week and clears the same
 *  floor in under one, with MORE evidence behind the sentence rather than less.
 *
 *  The assumption is that weekday service is uniform. That is how GTFS itself
 *  models it -- calendar.txt carries a flag per weekday precisely because they
 *  usually agree -- and Saturday and Sunday stay separate, because they usually
 *  do not. If Brown ever runs a Wednesday-only route this will read it as
 *  "seen on 3 of the 15 weekdays", which is true but blunt; that is the trade,
 *  and it is worth it against saying nothing at all for three weeks. */
export type Bucket = string;

/** `wd`, `sa` or `su` for a weekday index. */
function dayType(dow: number): string {
  return dow === 0 ? "su" : dow === 6 ? "sa" : "wd";
}

interface Tally {
  /** Distinct local dates counted into this bucket. */
  n: number;
  /** The last date counted, so repeated samples in one day count once. */
  last: string;
}

export interface ServiceHistory {
  /** First date any sample was taken, so the app can say how long it has watched. */
  since: string;
  updated: string;
  /** Days this bucket was sampled at all, whether or not anything was running. */
  days: Record<Bucket, Tally>;
  /** Days each route was seen running, per bucket. */
  seen: Record<string, Record<Bucket, Tally>>;
  /** Observed seconds for one stop-to-stop leg, keyed `routeId|from|to`. Kept
   *  here rather than in their own file so the recorder writes once and CI
   *  commits once. See legTimes.ts. */
  legs?: Record<string, number[]>;
  /** Which trip instance contributed each sample in `legs`, same key, same
   *  order, so one bus polled six times cannot fill a leg by itself. */
  legTrips?: Record<string, string[]>;
}

export function emptyHistory(since: string): ServiceHistory {
  return { since, updated: since, days: {}, seen: {} };
}

/** The parts of a moment that matter, in Providence's own clock. */
function local(at: Date): { date: string; dow: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE, weekday: "short", hour: "2-digit", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = get("weekday"), rawHour = get("hour");
  const dow = dows.indexOf(weekday);
  // A weekday this table does not know, or an hour Intl did not give us, is
  // not a reason to invent one -- in the one file whose whole thesis is never
  // claiming more than was observed. `Math.max(0, indexOf)` filed the sample
  // under Sunday and `Number("")` under midnight, so the app could print "on 3
  // of the 8 Sundays watched" on a Tuesday and never say anything was wrong.
  // Same standard as the recorder's loader: not a reason to throw the record
  // away, a reason to stop and be looked at.
  if (dow < 0 || !/^\d{1,2}$/.test(rawHour)) {
    throw new Error("Intl gave a local time this code cannot read: " +
      `weekday=${JSON.stringify(weekday)} hour=${JSON.stringify(rawHour)}`);
  }
  // Intl renders midnight as "24" under hour12:false in some engines.
  const hour = Number(rawHour) % 24;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, dow, hour };
}

export function bucketOf(at: Date): Bucket {
  const { dow, hour } = local(at);
  return `${dayType(dow)}-${String(hour).padStart(2, "0")}`;
}

/**
 * Fold a weekday-keyed record into day types.
 *
 * Called on load by both readers, so an existing record keeps every day it
 * ever counted instead of starting from zero. The counts ADD exactly: a date
 * has exactly one weekday, so no date can appear in two of the buckets being
 * merged, and `n` is a count of distinct dates.
 */
export function migrateBuckets(history: ServiceHistory): ServiceHistory {
  const isOld = (k: string) => /^[0-6]-\d{2}$/.test(k);
  const fold = (rec: Record<Bucket, Tally>): Record<Bucket, Tally> => {
    if (!Object.keys(rec).some(isOld)) return rec;
    const out: Record<Bucket, Tally> = {};
    for (const [k, t] of Object.entries(rec)) {
      const key = isOld(k)
        ? `${dayType(Number(k.split("-")[0]))}-${k.split("-")[1]}`
        : k;
      const prev = out[key];
      out[key] = prev
        ? { n: prev.n + t.n, last: prev.last > t.last ? prev.last : t.last }
        : { ...t };
    }
    return out;
  };
  const seen: Record<string, Record<Bucket, Tally>> = {};
  for (const [routeId, rec] of Object.entries(history.seen)) seen[routeId] = fold(rec);
  return { ...history, days: fold(history.days), seen };
}

/** Count one date into a tally, but only once per date. */
function bump(t: Tally | undefined, date: string): Tally {
  if (t && t.last === date) return t;
  return { n: (t?.n ?? 0) + 1, last: date };
}

/**
 * Fold one observation into the history.
 *
 * `running` is the routes with a vehicle reporting right now. An EMPTY list is
 * still a sample and still counted: the days total is what gives the seen
 * count a denominator, and without it a single sighting would read as "every
 * time".
 */
export function recordSample(
  history: ServiceHistory, running: string[], at: Date,
): ServiceHistory {
  const { date } = local(at);
  const bucket = bucketOf(at);
  const seen = { ...history.seen };
  for (const routeId of running) {
    seen[routeId] = { ...seen[routeId], [bucket]: bump(seen[routeId]?.[bucket], date) };
  }
  return {
    ...history,
    updated: at.toISOString(),
    days: { ...history.days, [bucket]: bump(history.days[bucket], date) },
    seen,
  };
}

/** How often this route was seen at this weekday and hour. */
export function observed(
  history: ServiceHistory, routeId: string, at: Date,
): { seen: number; days: number } {
  const bucket = bucketOf(at);
  return {
    seen: history.seen[routeId]?.[bucket]?.n ?? 0,
    days: history.days[bucket]?.n ?? 0,
  };
}

/** Enough days to be a record rather than an anecdote. Two Fridays is not a
 *  pattern, and printing "seen on 1 of 1" invites a rider to read one sighting
 *  as a schedule -- the exact mistake this exists to avoid. */
const MIN_DAYS = 3;

/** How to name a day-type bucket in a sentence. */
const DAY_LABEL: Record<string, string> = { wd: "weekdays", sa: "Saturdays", su: "Sundays" };

/**
 * What was actually seen, in a sentence, or null when too little is known.
 *
 * Deliberately past tense and deliberately bare. It is a record of
 * observations, not a forecast, so it never says a bus will come -- only how
 * often one has.
 */
export function describeService(
  history: ServiceHistory, routeId: string, at: Date,
): string | null {
  const { seen, days } = observed(history, routeId, at);
  if (days < MIN_DAYS) return null;
  const label = DAY_LABEL[bucketOf(at).split("-")[0]!] ?? "days";
  return `Seen running around this time on ${seen} of the ${days} ${label} watched so far.`;
}

/**
 * Why there is no bus, when the record can actually say.
 *
 * A rider handed a walk is owed the reason, and this is the only one the app
 * is allowed to give: not that nothing WILL run, but that across enough days
 * of watching, nothing ever HAS at this hour. Same standard as every other
 * sentence here -- observed, counted in days, past tense.
 *
 * Silent in the two cases where it would be overclaiming: too few days
 * watched, and any sighting at all on any of the routes offered. One running
 * shuttle makes "nothing runs now" false.
 */
export function describeAbsence(
  history: ServiceHistory, routeIds: string[], at: Date,
): string | null {
  const label = DAY_LABEL[bucketOf(at).split("-")[0]!] ?? "days";
  let watched = 0;
  for (const routeId of routeIds) {
    const { seen, days } = observed(history, routeId, at);
    if (seen > 0) return null;
    if (days > watched) watched = days;
  }
  if (watched < MIN_DAYS) return null;
  return `No shuttle has been seen running around this time on any of the `
       + `${watched} ${label} watched so far.`;
}

/** The record the site publishes, or null when there is not one to read.
 *  Never throws: a missing record just means the app says nothing about when
 *  service has run, which is where it started. */
export async function fetchServiceHistory(): Promise<ServiceHistory | null> {
  if (typeof window === "undefined") return null;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}service-history.json`);
    if (!res.ok) return null;
    const parsed = await res.json() as ServiceHistory;
    return parsed?.days && parsed?.seen ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The route seen most often at this weekday and hour, among those given.
 *
 * A rider standing at a stop is asking "will one come?". Averaging over every
 * route that calls there answers a question nobody asked -- a route that
 * barely serves the stop drags the number down. The best-served route is the
 * one their wait actually depends on.
 *
 * Null when too little has been watched to say anything, on the same floor as
 * describeService. A route seen ZERO times out of a well-watched hour is not
 * nothing, though: that is worth telling someone before they wait.
 */
export function bestObserved(
  history: ServiceHistory, routeIds: string[], at: Date,
): { routeId: string; seen: number; days: number } | null {
  let best: { routeId: string; seen: number; days: number } | null = null;
  for (const routeId of routeIds) {
    const { seen, days } = observed(history, routeId, at);
    if (days < MIN_DAYS) continue;
    if (!best || seen > best.seen) best = { routeId, seen, days };
  }
  return best;
}
