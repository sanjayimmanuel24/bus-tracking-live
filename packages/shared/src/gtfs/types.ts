/**
 * GTFS static types.
 *
 * Field names deliberately match the GTFS specification's snake_case column names
 * so that a row parsed straight out of a `.txt` file is already a valid object.
 * Reference: https://gtfs.org/documentation/schedule/reference/
 */

export interface GtfsAgency {
  agency_id: string;
  agency_name: string;
  agency_url: string;
  agency_timezone: string;
  agency_lang?: string;
}

export interface GtfsStop {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  location_type?: number;
}

/** GTFS route_type 3 = Bus. */
export interface GtfsRoute {
  route_id: string;
  agency_id: string;
  route_short_name: string;
  route_long_name: string;
  route_type: number;
  route_color: string;
  route_text_color: string;
}

export interface GtfsTrip {
  route_id: string;
  service_id: string;
  trip_id: string;
  trip_headsign: string;
  /** 0 = outbound, 1 = inbound. */
  direction_id: number;
  /** Trips sharing a block_id are served consecutively by the same vehicle. */
  block_id: string;
  shape_id: string;
}

export interface GtfsStopTime {
  trip_id: string;
  /** Seconds after midnight. GTFS allows values >= 86400 for after-midnight trips. */
  arrival_time: number;
  departure_time: number;
  stop_id: string;
  stop_sequence: number;
  /** Distance travelled along the shape to reach this stop, in metres. */
  shape_dist_traveled: number;
}

export interface GtfsShapePoint {
  shape_id: string;
  shape_pt_lat: number;
  shape_pt_lon: number;
  shape_pt_sequence: number;
  shape_dist_traveled: number;
}

export interface GtfsCalendar {
  service_id: string;
  monday: number;
  tuesday: number;
  wednesday: number;
  thursday: number;
  friday: number;
  saturday: number;
  sunday: number;
  start_date: string;
  end_date: string;
}
