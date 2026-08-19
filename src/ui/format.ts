/** Shared time and distance formatting. One place, so "8 min" never renders
 *  as "8 mins" three components over. */

export const clock = (epochSeconds: number) =>
  new Date(epochSeconds * 1000).toLocaleTimeString("en-US",
    { hour: "numeric", minute: "2-digit" });

export const minsUntil = (epochSeconds: number, now: number) =>
  Math.max(0, Math.round((epochSeconds - now) / 60));

/** Average walking pace on foot, in metres per minute. College Hill is steep
 *  enough that this under-reads uphill; Valhalla is used for real itineraries
 *  and this is only for the rough "how far is that stop" label. */
const WALK_M_PER_MIN = 78;
export const walkMins = (meters: number) => Math.max(1, Math.round(meters / WALK_M_PER_MIN));

export const durationMins = (seconds: number) => Math.max(1, Math.round(seconds / 60));
