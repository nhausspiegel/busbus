import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { parseStaticFeed } from "../src/data/gtfs";
import { parseTripUpdates } from "../src/data/realtime";
import { serviceDayStart, scheduledDepartures, buildBoard } from "../src/data/departures";
import { nearbyDepartures } from "../src/routing/nearby";
import { planTrips } from "../src/routing/plan";

/** The live path has never run against real service: Brown's Evening routes
 *  are suspended for the summer and the Daytime routes stop at 7pm, so every
 *  frozen fixture captured so far has zero vehicles reporting. These tests
 *  synthesise a feed where buses ARE running, using the same protobuf library
 *  that decodes the real one, so the live-overrides-timetable path is actually
 *  exercised rather than assumed. */

const feed = parseStaticFeed(new Uint8Array(readFileSync("test/fixtures/gtfs.zip")));
const EVENING_CW = "3469";

/** Pick a real trip from the static feed so stop ids and sequences are genuine. */
function aRealTrip() {
  for (const t of feed.trips.values())
    if (t.routeId === EVENING_CW && t.stops.length >= 4) return t;
  throw new Error("fixture has no usable Evening CW trip");
}

function encodeTripUpdates(tripId: string, routeId: string,
                           stops: { stopId: string; seq: number; time: number }[]) {
  const msg = GtfsRealtimeBindings.transit_realtime.FeedMessage.create({
    header: { gtfsRealtimeVersion: "2.0" },
    entity: [{
      id: "1",
      tripUpdate: {
        trip: { tripId, routeId },
        stopTimeUpdate: stops.map((s) => ({
          stopId: s.stopId, stopSequence: s.seq,
          arrival: { time: s.time }, departure: { time: s.time },
        })),
      },
    }],
  });
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.encode(msg).finish();
}

describe("with buses actually reporting", () => {
  const trip = aRealTrip();
  const dayStart = serviceDayStart(new Date(2026, 7, 18, 20, 0, 0));
  const scheduled = scheduledDepartures(feed, dayStart);
  // Run this bus four minutes behind its timetable.
  const LATE = 240;
  const liveStops = trip.stops.slice(0, 4).map((s) => ({
    stopId: s.stopId, seq: s.seq, time: dayStart + s.time + LATE,
  }));
  const live = parseTripUpdates(encodeTripUpdates(trip.id, trip.routeId, liveStops));
  const board = buildBoard(live, scheduled);
  const now = dayStart + trip.stops[0]!.time - 600;   // ten minutes before it departs

  it("decodes live departures as live", () => {
    expect(live.length).toBe(4);
    expect(live.every((d) => d.live)).toBe(true);
  });

  it("replaces the scheduled time for the same trip and stop", () => {
    const stopId = trip.stops[0]!.stopId;
    const forTrip = (board.get(stopId) ?? []).filter((d) => d.tripId === trip.id);
    expect(forTrip).toHaveLength(1);
    expect(forTrip[0]!.live).toBe(true);
    expect(forTrip[0]!.time).toBe(dayStart + trip.stops[0]!.time + LATE);
  });

  it("shows the late time to a rider, not the timetable time", () => {
    const stop = feed.stops.get(trip.stops[0]!.stopId)!;
    const rows = nearbyDepartures(feed, board, { lat: stop.lat, lng: stop.lng }, now, 3);
    const row = rows.find((r) => r.stop.id === stop.id);
    const dep = row?.departures.find((d) => d.tripId === trip.id);
    expect(dep?.live).toBe(true);
    expect(dep?.time).toBe(dayStart + trip.stops[0]!.time + LATE);
  });

  it("marks an itinerary fully live when it rides a reporting bus", () => {
    const boardStop = feed.stops.get(trip.stops[0]!.stopId)!;
    const alightStop = feed.stops.get(trip.stops[2]!.stopId)!;
    const got = planTrips({
      feed, board,
      origin: { lat: boardStop.lat, lng: boardStop.lng },
      destination: { lat: alightStop.lat, lng: alightStop.lng },
      walkFromOrigin: new Map([[boardStop.id, 60]]),
      walkToDestination: new Map([[alightStop.id, 60]]),
      now,
    });
    const onThisTrip = got.find((i) => i.rides[0]?.tripId === trip.id);
    expect(onThisTrip).toBeDefined();
    expect(onThisTrip!.allLive).toBe(true);
    expect(onThisTrip!.rides[0]!.live).toBe(true);
  });

  it("delays arrival by the same amount the bus is running late", () => {
    // The whole leg shifts with the bus; arrival must not stay on the
    // timetable while departure moves.
    const boardStop = feed.stops.get(trip.stops[0]!.stopId)!;
    const alightStop = feed.stops.get(trip.stops[2]!.stopId)!;
    const opts = {
      feed, origin: { lat: boardStop.lat, lng: boardStop.lng },
      destination: { lat: alightStop.lat, lng: alightStop.lng },
      walkFromOrigin: new Map([[boardStop.id, 60]]),
      walkToDestination: new Map([[alightStop.id, 60]]),
      now,
    };
    const withLive = planTrips({ ...opts, board })
      .find((i) => i.rides[0]?.tripId === trip.id);
    const timetableOnly = planTrips({ ...opts, board: buildBoard([], scheduled) })
      .find((i) => i.rides[0]?.tripId === trip.id);
    expect(withLive).toBeDefined();
    expect(timetableOnly).toBeDefined();
    expect(withLive!.arriveTime - timetableOnly!.arriveTime).toBe(LATE);
  });

  it("keeps scheduled departures for trips with no live data", () => {
    // Only one trip is reporting; the rest of the evening must still be there.
    const other = [...board.values()].flat().filter((d) => d.tripId !== trip.id);
    expect(other.length).toBeGreaterThan(50);
    expect(other.every((d) => !d.live)).toBe(true);
  });
});
