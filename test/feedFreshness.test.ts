import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStaticFeed } from "../src/data/gtfs";

/**
 * The shipped feed must not have expired.
 *
 * `public/gtfs/google_transit.zip` is committed, not fetched: the static zip is
 * the one Passio feed that sends no CORS header, so a browser cannot read it
 * from passio3.com at all. That makes it the one piece of data here that can go
 * stale silently -- and `feed_info.txt` states the date it stops being valid,
 * which nothing was reading.
 *
 * Failing here is not a bug in the code, it is the feed asking to be refreshed:
 *
 *     ./scripts/refresh-fixtures.sh
 *
 * which updates both the test fixture and the shipped copy. Inspect the diff
 * before committing it -- that script is also how a test that fails BECAUSE the
 * data changed gets fixed, and never how a failing test gets silenced.
 */
const feed = parseStaticFeed(new Uint8Array(readFileSync("public/gtfs/google_transit.zip")));

/** `YYYYMMDD` as it appears in feed_info.txt, in local time. */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};

describe("the shipped GTFS feed", () => {
  it("states when it stops being valid", () => {
    expect(feed.feedEndDate).toMatch(/^\d{8}$/);
  });

  it("has not expired", () => {
    // String compare is correct for YYYYMMDD and needs no date parsing.
    expect(feed.feedEndDate >= today()).toBe(true);
  });
});
