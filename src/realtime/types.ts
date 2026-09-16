/**
 * GTFS-Realtime entity shapes.
 *
 * These mirror the GTFS-Realtime protobuf schema, in JSON form:
 * https://gtfs.org/documentation/realtime/reference/
 *
 * The UI consumes *only* these types. It has no access to the simulator's internal
 * state, and no knowledge of whether a position came from a simulated bus, a real
 * driver's phone, or an agency's public feed. That boundary is the point: in
 * Phase 2 the in-browser simulator is replaced by a WebSocket carrying the same
 * entities, and nothing in `src/ui/` changes.
 */

export type ScheduleRelationship = 'SCHEDULED' | 'ADDED' | 'UNSCHEDULED' | 'CANCELED';

export type VehicleStopStatus = 'INCOMING_AT' | 'STOPPED_AT' | 'IN_TRANSIT_TO';

export type OccupancyStatus =
  | 'EMPTY'
  | 'MANY_SEATS_AVAILABLE'
  | 'FEW_SEATS_AVAILABLE'
  | 'STANDING_ROOM_ONLY'
  | 'CRUSHED_STANDING_ROOM_ONLY'
  | 'FULL'
  | 'NOT_ACCEPTING_PASSENGERS';

export interface TripDescriptor {
  tripId: string;
  routeId: string;
  directionId: number;
  /** Trip start time as GTFS `HH:MM:SS`. */
  startTime: string;
  scheduleRelationship: ScheduleRelationship;
}

export interface VehicleDescriptor {
  /** Stable internal identifier. */
  id: string;
  /** Public-facing label -- the registration plate riders actually see. */
  label: string;
}

export interface Position {
  latitude: number;
  longitude: number;
  /** Degrees clockwise from true north. */
  bearing: number;
  /** Metres per second, per the GTFS-RT spec -- NOT km/h. */
  speed: number;
}

export interface VehiclePosition {
  trip: TripDescriptor;
  vehicle: VehicleDescriptor;
  position: Position;
  currentStopSequence: number;
  currentStatus: VehicleStopStatus;
  /** POSIX seconds. */
  timestamp: number;
  occupancyStatus: OccupancyStatus;
  occupancyPercentage: number;
}

export interface StopTimeEvent {
  /** POSIX seconds. */
  time: number;
  /** Seconds behind schedule; negative means running early. */
  delay: number;
  /** Confidence interval in seconds. 0 means "exact". */
  uncertainty: number;
}

export interface StopTimeUpdate {
  stopSequence: number;
  stopId: string;
  arrival: StopTimeEvent;
  departure?: StopTimeEvent;
  scheduleRelationship: 'SCHEDULED' | 'SKIPPED' | 'NO_DATA';
}

export interface TripUpdate {
  trip: TripDescriptor;
  vehicle: VehicleDescriptor;
  stopTimeUpdate: StopTimeUpdate[];
  /** Current delay at the vehicle's position, in seconds. */
  delay: number;
  timestamp: number;
}

export type AlertCause = 'TRAFFIC_JAM' | 'CONSTRUCTION' | 'ACCIDENT' | 'OTHER_CAUSE' | 'DEMONSTRATION';
export type AlertEffect = 'SIGNIFICANT_DELAYS' | 'REDUCED_SERVICE' | 'DETOUR' | 'OTHER_EFFECT';
export type AlertSeverity = 'INFO' | 'WARNING' | 'SEVERE';

export interface ServiceAlert {
  id: string;
  cause: AlertCause;
  effect: AlertEffect;
  severityLevel: AlertSeverity;
  headerText: string;
  informedEntity: { routeId?: string; stopId?: string; tripId?: string }[];
  activePeriodStart: number;
}

/** A GTFS-RT FeedMessage: one complete snapshot of the network. */
export interface RealtimeSnapshot {
  header: {
    gtfsRealtimeVersion: string;
    incrementality: 'FULL_DATASET' | 'DIFFERENTIAL';
    /** POSIX seconds. */
    timestamp: number;
  };
  vehiclePositions: VehiclePosition[];
  tripUpdates: TripUpdate[];
  alerts: ServiceAlert[];
}

/**
 * A source of realtime data.
 *
 * Phase 1 ships `SimulatedFeedSource`. Phase 2 adds a `WebSocketFeedSource`
 * against a real ingest backend; both satisfy this interface.
 */
export interface FeedSource {
  subscribe(listener: (snapshot: RealtimeSnapshot) => void): () => void;
  start(): void;
  stop(): void;
}

const OCCUPANCY_THRESHOLDS: [number, OccupancyStatus][] = [
  [0, 'EMPTY'],
  [0.35, 'MANY_SEATS_AVAILABLE'],
  [0.7, 'FEW_SEATS_AVAILABLE'],
  [1.0, 'STANDING_ROOM_ONLY'],
  [1.25, 'CRUSHED_STANDING_ROOM_ONLY'],
  [1.5, 'FULL'],
];

/**
 * Map a load factor (passengers / seated capacity) to a GTFS-RT occupancy status.
 * Values above 1.0 represent standing passengers, which is normal on Indian city
 * buses -- seated capacity is not a hard ceiling.
 */
export function occupancyStatusFor(loadFactor: number): OccupancyStatus {
  let status: OccupancyStatus = 'EMPTY';
  for (const [threshold, value] of OCCUPANCY_THRESHOLDS) {
    if (loadFactor >= threshold) status = value;
  }
  return status;
}
