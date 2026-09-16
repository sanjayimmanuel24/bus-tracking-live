/**
 * Vehicle identity.
 *
 * The prototype used bus-stop names as vehicle identifiers -- a bus called
 * "Gandhipuram Bus Stand". A vehicle needs an identity independent of where it
 * happens to be, because it moves, serves several routes over a day, and is what
 * a depot, a maintenance log and a rider complaint all refer to.
 *
 * Registration format follows Tamil Nadu plates: TN <RTO> <series> <number>.
 * 37, 38, 66 and 99 are Coimbatore-district RTO codes.
 */

import { hashString, mulberry32 } from './rng.ts';

const RTO_CODES = ['37', '38', '66', '99'] as const;
const SERIES_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // I and O omitted -- they read as 1 and 0.

export interface VehicleIdentity {
  /** Stable internal ID, matching the GTFS block the bus is working. */
  id: string;
  /** Registration plate as displayed to riders and depot staff. */
  label: string;
  /** Seated capacity. Standing load can exceed this. */
  capacity: number;
}

/**
 * Derive a stable vehicle identity for a block. The same block always yields the
 * same plate, so reloading the page does not reshuffle the fleet.
 */
export function vehicleForBlock(blockId: string, capacity: number): VehicleIdentity {
  const rng = mulberry32(hashString(blockId));
  const rto = RTO_CODES[Math.floor(rng() * RTO_CODES.length)]!;
  const a = SERIES_LETTERS[Math.floor(rng() * SERIES_LETTERS.length)]!;
  const b = SERIES_LETTERS[Math.floor(rng() * SERIES_LETTERS.length)]!;
  const number = String(1000 + Math.floor(rng() * 9000));
  return { id: blockId, label: `TN ${rto} ${a}${b} ${number}`, capacity };
}
