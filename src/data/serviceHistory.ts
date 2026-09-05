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

/** One weekday-and-hour slot, as `<0-6>-<00-23>`. */
export type Bucket = string;

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
  return `${dow}-${String(hour).padStart(2, "0")}`;
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

const WEEKDAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays",
                  "Thursdays", "Fridays", "Saturdays"];

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
  const dow = Number(bucketOf(at).split("-")[0]);
  return `Seen running around this time on ${seen} of the ${days} ${WEEKDAYS[dow]} watched so far.`;
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
