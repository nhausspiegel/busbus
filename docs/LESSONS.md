# Lessons

The full record behind the six patterns in `CLAUDE.md` section 0. Each bullet
is one instance, kept verbatim, because they are evidence: the pattern is the
summary, this is what it was summarised from. The measured findings behind the
non-negotiables are at the bottom.

New instance? Add it here under its pattern. Only a NEW root pattern goes in
`CLAUDE.md`.

---

## 1. A cheap proxy stood in for the expensive real thing, then got trusted

- Inventing a metric instead of measuring the thing complained about. Three
  proxies for the map "squiggle" each moved the wrong way, and one counted a
  successful fix as the defect. Same trap, second victim: the sign of a lane's
  `line-offset` must flip where the canonical frame opposes travel, so counting
  those flips measures the correction, not the defect.
- Filing a dead end when the measurement answered a different question.
  Street-matching was recorded as "does not pay" because the matched line sat
  within 7.4m of the traced one -- true, and beside the point: matching exists
  to give segments a shared IDENTITY, not to move them. It is now the
  architecture that ships. Before recording a dead end, check that the question
  measured was the one that mattered.
- Treating "no defect I can measure" as "it looks right". Three rendering
  attempts in one day measured clean -- boundary count, fold count, gap in
  pixels -- and all three were called awful on sight. Those numbers only detect
  defects already hypothesised. They cannot answer whether it LOOKS correct,
  and no number found so far can.
- Reporting what a screenshot shows. I have twice stated the opposite of what
  was on screen, including which side of a road a line sat on. Screenshots
  spot that something is wrong; they never decide what is right.
- Reporting a derived number without sanity-checking it. Three routes on one
  street must have bearings 0 or 180 apart; mine came out 20 and 97 apart and
  were reported as fact, because the helper had grabbed the wrong segment of a
  loop. A number that contradicts something structurally obvious is wrong.
- Running experiments against the code instead of reading it. A day of probing
  from the outside; the defect was plain in five lines once actually READ.
  Measurement says something is broken, reading says why.
- Reporting a count taken from a sample. Four stations were measured by name and
  "three are broken" was reported as the total; it was nine of twelve. If a
  sentence has a number in it, the number covers the whole population.
- Measuring a zoom-dependent quantity at one zoom. The stop check ran at z16,
  where the worst case looks perfect; it is 67 degrees off at the zoom the app
  opens at. One sample of a parameter is not a measurement of it.
- Treating existing code as a specification. `laneIndex` had been wrong since it
  was written and six sessions built on top of it rather than reading it.
  "Reuse before writing" is about helpers, not a reason to keep bad
  infrastructure.
- Treating a note in these docs as law, or as licence. "Do not offset in
  geometry" was obeyed without reading why, then ignored entirely once told the
  docs are not gospel. Both wrong: it was right, for a reason nobody had
  checked. Ask what a note is EVIDENCE OF, then whether that still applies.
- Trusting a green suite. The one test guarding "every bead sits on its line"
  reads a property the beads have never carried, so it skips every iteration and
  asserts 0 < 6 at three zooms. Any loop that can `continue` on a lookup miss
  must assert it examined something.
- Taking a subagent's finding as a result. One report held a critical truth and
  a confident falsehood, both with quoted code. Verify any claim about a
  MECHANISM by measuring it -- and check first for the error you are yourself
  prone to, because that is what the false one was.
- Calling data plausible because it passed the check I wrote. The guard was
  `seconds <= 0`, so a two-second bus leg passed and got pushed. Ask what value
  would be ABSURD, not whether it survived the one filter already there.
- Copying a unit constant from another system's conventions. `metresPerPixel`
  used the 256px-tile constant in an app that renders with 512px tiles: off by
  exactly 2, uniformly, so it never looked like a zoom bug and survived a whole
  rewrite. Invisible to review and to unit tests, obvious to one measurement
  against the live map.
- Designing a fix that already exists. `laneSnap` does the correct thing, has
  zero callers, and `docs/RENDERING.md` describes it as in use. Grep first; a
  doc saying code is live is not evidence anything calls it.
- Discarding data because it is longer. A station merged the stop ids Passio
  splits by direction and named itself by keeping the SHORTEST name, on the
  reasoning that a direction suffix makes a name longer. That is string length
  standing in for meaning: "Pembroke Campus" (15) and "Cushing & Thayer" (16)
  are two different stops 11m apart, so one of them vanished from the app.
  Strip the suffix you actually mean to strip, and keep every name that survives.

- Measuring a file in the working tree instead of the one the app serves. The
  observed-leg record is written by CI onto `main` every fifteen minutes; the
  branch I was on had not been fetched for five days. I reported "the recorder
  is dead, 0 of 22 legs usable, the observed-durations architecture has never
  produced a value" as measured fact. The live file had been written four
  minutes earlier and carried 21 usable legs of 39, with 8 of the Express's 9 at
  twenty samples each. `git fetch` before any claim about data CI maintains, and
  say which ref a number came from.
- Probing for a symptom with a selector that matches something else. Verifying a
  panel had taken the sheet over, I tested the sheet's text against
  `/TO FAUNCE ARCH/i` -- which the search bar above it also matches -- and again
  read a destination as "lost" because the field replaces its label by design.
  Twice in one session a green or red probe was measuring the wrong element.
  Assert on the element, not on text that several elements can produce.

## 2. "Do not stop" means do not stop WORKING -- a diff is not evidence of progress

- Shipping a run of "fixes" each measured against something other than the
  complaint. Five rendering changes in one day each improved the number they
  aimed at -- side-jumps, stub length, nubs -- and the owner said the map looked
  worse after every one. All five were reverted to `renderer-checkpoint`. The
  number that tracked how it LOOKED was the count of visible feature boundaries,
  and not one of the five was measured against it. Find the number that moves
  with the complaint before changing anything.
- Judging a half-wired rewrite by how it looks. The one-feature-per-route
  rendering was abandoned as "looks awful" while its stop and bus snapping were
  still unported and two tests were red. That is not evidence about the design.
  Finish wiring, or do not look.
- Adding a lot of code. `3fa88f8` deleted the bundler, 546 lines to 82, and
  every deleted line propped up a guess that should not have been made. A big
  net addition means the problem was framed wrong.

## 3. Treat the cause, not the shape of the symptom

- Treating what a defect looks like instead of what causes it. Route corners
  grew nubs under round line caps; switching to butt caps replaced them with
  notches. Both are the same defect -- a boundary between two features, which
  MapLibre cannot join -- and the cap only chose which artefact appeared. When
  a fix changes the shape of a symptom without reducing it, the cause is
  somewhere else.

## 4. The owner is ground truth

- Shipping rendering the owner had no chance to intercept. The dev server is
  hot-reloaded, so every edit is instantly on their screen; committing a
  rendering rewrite while they were away meant they returned to a broken map
  three hours old. Rendering experiments belong on a branch or a worktree, and
  never land while they are gone.
- Not asking the owner when they are right there. A whole network was measured
  to work out which stop looked wrong and which way its marker should point;
  they could say both in one line, and did. When they are at the keyboard, ask.
- Explaining a report away. "It may just not be visible at that zoom" is not an
  answer to "it doesn't work". The owner is the only one who can see the
  window, so their observation is the starting point, not a claim to triage.

## 5. One fix, one commit; deleting a file re-trues every doc that names it

- Leaving docs pointing at deleted files. `HANDOFF.md` sent the next session to
  `src/render/bundle.ts` and `test/squiggle.test.ts` for weeks after both were
  gone. Deleting a file means re-truing every doc that names it, in the same
  commit.
- Letting an unrelated fix ride along with a rendering change. The z-order fix
  and the hospital-loop fix had nothing to do with lane geometry, shared a
  working tree with it, and were reverted twice as collateral. One fix, one
  commit, verifiable alone.

## 6. Data already in the repo beats an API you have to call

- Reaching for a remote API for data the project already has (see Working
  style). ~60 rate-limited requests for a road network that is one query.

---

# The measurements behind the non-negotiables

## Never show a timetable time

The "render it as a weaker claim" rule was superseded on 2026-08-23 by the
project owner's decision, after measuring at 22:22 that night:

- `calendar.txt` is ONE row: service 3302, all seven days, 20250101-20271231.
  There is no `calendar_dates.txt` in the feed at all, so the data has no field
  in which "not running today" could ever be written.
- GTFS-RT returned 0 vehicles AND 0 predictions.
- Passio's own private endpoint returned an empty bus list, so their app cannot
  show a time either. We are not missing a source they have.
- The app was nonetheless offering "10:06 PM" for four routes.

A scheduled time is therefore not a weaker claim than a live one, it is an
unfounded one, and styling cannot fix that. The board is built from live
departures only (`buildBoard(live, [])` in App). The timetable keeps the one
job it is honest at: which stops a route serves, in what order -- from
`feed.trips`, and from `feed.routeStops` where the export drops them -- which
never touches the board.

Telling a rider when service actually runs is done the only honest way there
is: observation. `scripts/record-service.ts` samples the vehicle feed every 15
minutes from CI and commits what it saw to `public/service-history.json`; the
route page and the stop card state that record and nothing beyond it.

The same recording gives the one thing GTFS cannot: how long a leg actually
takes (`src/data/legTimes.ts`). Realtime publishes an absolute time per stop,
so the gap between two of them on one trip is a measured duration, which is
what lets a route be ridden past the stops its GTFS trip omits.

## Volunteer infrastructure goes down

Measured 2026-08-23/24:

- `valhalla1.openstreetmap.de` returned HTTP 000 -- accepted the connection,
  never replied -- for 20s on every attempt, and directions died with it.
  There are now TWO routers: FOSSGIS OSRM `routed-foot` first, Valhalla second.
  Never let this app depend on one host for its whole purpose again.
- A throttled response has no CORS headers, so it reaches the browser as
  `TypeError: Failed to fetch` rather than a 429. It looks like an outage and
  is not one.
- Requests are cached, de-duplicated, deadlined at 8s and backed off in
  `src/routing/walk.ts`. Retrying into a throttle is what keeps you throttled.

## Geocoding is Photon, not Nominatim

Nominatim matches whole words, so "trad" found nothing while "trader" found
Trader Joe's, and the app wrongly told the rider the place did not exist.
Debounced AND floored at one request per 1.2s -- a trailing debounce alone
still fires per keystroke for a slow typist.
