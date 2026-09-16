/**
 * The two shapes either side of the ingest boundary.
 *
 * `VehicleReport` is what a *device* sends: where it is, how fast, which trip it
 * is working. It carries no schedule knowledge, because a bus does not have any --
 * a driver's phone knows its GPS fix and its assigned trip, nothing more.
 *
 * `ResolvedPosition` is what the server derives from that by consulting the
 * timetable: distance along the shape, how far off-route the fix is, and how late
 * the bus is running. Keeping the two distinct is what makes the simulator
 * substitutable for a real vehicle: both can produce the former, and neither can
 * produce the latter.
 */

export interface VehicleReport {
  vehicleId: string;
  /** Registration plate, sent so the server can keep its vehicle registry current. */
  label?: string;
  tripId: string;
  latitude: number;
  longitude: number;
  bearing: number;
  /** Metres per second, as reported by the device. */
  speedMps: number;
  /** Passengers aboard, if the vehicle can count them. */
  occupancy?: number;
  /** Seated capacity, for occupancy percentage. */
  capacity?: number;
  /** POSIX seconds at which the fix was taken, not when it was received. */
  timestamp: number;
}

export interface ResolvedPosition {
  vehicleId: string;
  label: string;
  tripId: string;
  routeId: string;
  directionId: number;
  latitude: number;
  longitude: number;
  bearing: number;
  speedMps: number;
  timestamp: number;

  /** Derived: distance travelled along the trip shape, in metres. */
  distanceAlongM: number;
  /** Derived: perpendicular distance from the shape. High values mean off-route. */
  offsetM: number;
  /** Derived: seconds behind schedule; negative is early. */
  delaySec: number;
  /** Derived: stop_sequence of the next stop. */
  stopSequence: number;
  /** Derived: index into the trip's stopTimes for the next stop. */
  stopIndex: number;

  occupancyPercentage: number;
  /** True when the fix is implausibly far from the route shape. */
  offRoute: boolean;
  /**
   * True when the vehicle is standing at its trip's origin and the scheduled
   * departure has not yet arrived -- a bus on layover between workings.
   */
  awaitingDeparture: boolean;
}
