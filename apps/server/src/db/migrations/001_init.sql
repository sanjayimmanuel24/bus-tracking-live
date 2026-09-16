-- Position history and the vehicle registry.
--
-- The realtime path never reads from these tables: live state lives in Redis and
-- is served from there. This is the record of what happened, which is what the
-- Phase 3 travel-time model will be trained on.

CREATE EXTENSION IF NOT EXISTS postgis;

-- The physical fleet. GTFS has no concept of a vehicle, so this is ours: a bus
-- exists independently of the route it happens to be working today.
CREATE TABLE IF NOT EXISTS vehicles (
  vehicle_id      TEXT PRIMARY KEY,
  registration    TEXT NOT NULL,
  seated_capacity INTEGER NOT NULL CHECK (seated_capacity > 0),
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per position report. This is an append-only time series and will be by
-- far the largest table: 48 buses at 2 Hz is ~8.3 million rows a day.
CREATE TABLE IF NOT EXISTS vehicle_positions (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vehicle_id       TEXT        NOT NULL,
  trip_id          TEXT        NOT NULL,
  route_id         TEXT        NOT NULL,
  recorded_at      TIMESTAMPTZ NOT NULL,
  -- geography(Point,4326) measures in metres on the spheroid, so ST_DWithin and
  -- ST_Distance take and return metres with no projection step at query time.
  position         geography(Point, 4326) NOT NULL,
  bearing_deg      REAL,
  speed_mps        REAL,
  -- Derived server-side by projecting the reported point onto the trip shape.
  distance_along_m DOUBLE PRECISION,
  offset_m         REAL,
  delay_sec        INTEGER,
  stop_sequence    INTEGER,
  occupancy_pct    SMALLINT
);

-- Time-ordered lookups for one vehicle: "replay this bus's afternoon".
CREATE INDEX IF NOT EXISTS vehicle_positions_vehicle_time_idx
  ON vehicle_positions (vehicle_id, recorded_at DESC);

-- Segment travel times for a route over a period — the Phase 3 training query.
CREATE INDEX IF NOT EXISTS vehicle_positions_route_time_idx
  ON vehicle_positions (route_id, recorded_at DESC);

-- "What was near this point" — spatial queries over history.
CREATE INDEX IF NOT EXISTS vehicle_positions_geo_idx
  ON vehicle_positions USING GIST (position);

-- Stops, mirrored from GTFS so spatial queries ("stops within 500 m of me") can
-- run in the database rather than by scanning the feed in application memory.
CREATE TABLE IF NOT EXISTS stops (
  stop_id   TEXT PRIMARY KEY,
  stop_name TEXT NOT NULL,
  position  geography(Point, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS stops_geo_idx ON stops USING GIST (position);

-- Recorded arrivals: the actual time a bus reached a stop, against the scheduled
-- time. This is the ground truth the arrival model is scored on, and without it
-- there is no way to say whether a prediction was any good.
CREATE TABLE IF NOT EXISTS stop_arrivals (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vehicle_id     TEXT        NOT NULL,
  trip_id        TEXT        NOT NULL,
  route_id       TEXT        NOT NULL,
  stop_id        TEXT        NOT NULL,
  stop_sequence  INTEGER     NOT NULL,
  scheduled_at   TIMESTAMPTZ NOT NULL,
  observed_at    TIMESTAMPTZ NOT NULL,
  delay_sec      INTEGER     NOT NULL,
  UNIQUE (trip_id, vehicle_id, stop_sequence, observed_at)
);

CREATE INDEX IF NOT EXISTS stop_arrivals_stop_time_idx
  ON stop_arrivals (stop_id, observed_at DESC);
