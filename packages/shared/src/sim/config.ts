/**
 * Simulator-side vehicle configuration.
 *
 * GTFS has no field for vehicle capacity, and GTFS-Realtime reports occupancy as
 * a percentage rather than a headcount -- so this is producer-side data only. A
 * consumer never needs it, which is why it lives next to the simulator rather
 * than in the feed loader.
 *
 * In Phase 2 this is replaced by a `vehicles` table keyed by registration, which
 * is also where make, model, fuel type, wheelchair access and depot assignment
 * belong.
 */

export const CAPACITY_BY_ROUTE: Record<string, number> = {
  R1: 52, R2: 48, R3: 56, R4: 50, R5: 44,
  R6: 46, R7: 54, R8: 50, R9: 46, R10: 52,
};

export const DEFAULT_CAPACITY = 50;
