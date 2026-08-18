export interface LatLng { lat: number; lng: number }

export interface Stop { id: string; name: string; lat: number; lng: number }

export interface Route {
  id: string;          // GTFS route_id == Passio `myid`. Never Passio `id`.
  name: string;
  shortName: string;
  color: string;       // "#RRGGBB"
  shape: LatLng[];     // drawable polyline from shapes.txt
}

/** One stop on one trip. `time` is seconds after that service day's midnight,
 *  so post-midnight trips legitimately exceed 86400. */
export interface TripStop { stopId: string; seq: number; time: number }

export interface Trip { id: string; routeId: string; stops: TripStop[] }

export interface StaticFeed {
  routes: Map<string, Route>;
  stops: Map<string, Stop>;
  trips: Map<string, Trip>;
  feedEndDate: string;   // YYYYMMDD
}

/** A bus leaving a specific stop at a specific absolute time.
 *  `live` distinguishes a real-time prediction from a timetable entry. */
export interface Departure {
  stopId: string;
  tripId: string;
  routeId: string;
  seq: number;
  time: number;     // absolute epoch SECONDS
  live: boolean;
}

/** All known departures, grouped by stop, each list sorted ascending by time. */
export type DepartureBoard = Map<string, Departure[]>;

export interface WalkLeg { from: LatLng; to: LatLng; seconds: number; geometry?: LatLng[] }

export interface RideLeg {
  routeId: string;
  tripId: string;
  boardStopId: string;
  alightStopId: string;
  departTime: number;   // epoch seconds
  arriveTime: number;   // epoch seconds
  live: boolean;
  numStops: number;
}

export interface Itinerary {
  arriveTime: number;      // epoch seconds at the DESTINATION -- the ranking key
  departTime: number;      // when the user must leave their current position
  walkToStop: WalkLeg;
  rides: RideLeg[];        // length 1 today; >1 once transfers land
  walkFromStop: WalkLeg;
  totalWalkSeconds: number;
  transfers: number;
  allLive: boolean;        // false if any leg came from the timetable
}
