/**
 * Source network definition for the Coimbatore city bus network.
 *
 * This is the *authoring* format — a compact, human-editable description of the
 * network. `scripts/build-gtfs.ts` compiles it into a standards-compliant GTFS
 * static feed under `public/gtfs/`, which is what the application actually reads.
 *
 * Real agencies work the same way: an internal schedule database is exported to
 * GTFS for public consumption. Keeping that separation here means swapping in a
 * real agency feed is a drop-in replacement — nothing in `src/` imports this file.
 *
 * DATA PROVENANCE — READ BEFORE TRUSTING THESE COORDINATES
 * Stop positions are hand-placed approximations carried over from the original
 * prototype, not surveyed locations. Route stop-sequences are plausible but
 * unverified against actual TNSTC / Coimbatore City Municipal Corporation
 * services. See README "Data provenance" for what needs real survey work.
 */

export interface StopDef {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface RouteDef {
  id: string;
  /** Public-facing route number, e.g. "1A". */
  shortName: string;
  longName: string;
  color: string;
  /** Ordered stop IDs, outbound (direction_id = 0). Inbound is this reversed. */
  stops: string[];
  /** Scheduled headway in minutes, by service period. */
  headwayMin: { peak: number; offPeak: number };
  /** Average scheduled running speed in km/h, used to derive segment times. */
  avgSpeedKph: number;
  /** Scheduled dwell at intermediate stops, in seconds. */
  dwellSec: number;
  /** Minimum layover at a terminus before the next trip, in seconds. */
  layoverSec: number;
  /** Seated capacity of vehicles assigned to this route. */
  capacity: number;
}

/**
 * 59 unique stops. Three name variants in the original prototype data referred to
 * the same physical location and have been merged:
 *   - "Gandhipuram Bus Stand" (route 1A, 44A) and "Gandhipuram" (route 18) -> CBE001
 *   - "Ukkadam Bus Terminus" (route 1A) and "Ukkadam" (route 6)            -> CBE007
 * Merging matters: a shared stop is what makes interchange, transfer search and
 * per-stop departure boards possible at all.
 */
export const STOPS: StopDef[] = [
  { id: 'CBE001', name: 'Gandhipuram Bus Stand',  lat: 11.0168, lng: 76.9758 },
  { id: 'CBE002', name: 'Town Hall',              lat: 11.0140, lng: 76.9720 },
  { id: 'CBE003', name: 'Katcheri Road',          lat: 11.0110, lng: 76.9685 },
  { id: 'CBE004', name: 'R.S. Puram',             lat: 11.0075, lng: 76.9640 },
  { id: 'CBE005', name: 'Peelamedu Road',         lat: 11.0040, lng: 76.9600 },
  { id: 'CBE006', name: 'Kavundampalayam',        lat: 11.0010, lng: 76.9560 },
  { id: 'CBE007', name: 'Ukkadam Bus Terminus',   lat: 10.9980, lng: 76.9530 },
  { id: 'CBE008', name: 'Singanallur',            lat: 11.0020, lng: 77.0220 },
  { id: 'CBE009', name: 'Airport Road',           lat: 11.0050, lng: 77.0100 },
  { id: 'CBE010', name: 'Avinashi Road Junction', lat: 11.0080, lng: 76.9980 },
  { id: 'CBE011', name: 'PSG College',            lat: 11.0120, lng: 76.9890 },
  { id: 'CBE012', name: 'Hopes College',          lat: 11.0150, lng: 76.9820 },
  { id: 'CBE013', name: 'Peelamedu',              lat: 11.0200, lng: 76.9760 },
  { id: 'CBE014', name: 'Podanur Junction',       lat: 10.9870, lng: 76.9760 },
  { id: 'CBE015', name: 'Nehru Nagar',            lat: 10.9920, lng: 76.9730 },
  { id: 'CBE016', name: 'Collectorate',           lat: 10.9970, lng: 76.9700 },
  { id: 'CBE017', name: 'Town Bus Stand',         lat: 11.0010, lng: 76.9670 },
  { id: 'CBE018', name: 'Ganapathy',              lat: 11.0140, lng: 76.9620 },
  { id: 'CBE019', name: 'Bharathiyar University', lat: 11.0270, lng: 76.9580 },
  { id: 'CBE020', name: 'Saibaba Colony',         lat: 11.0230, lng: 76.9700 },
  { id: 'CBE021', name: 'Race Course',            lat: 11.0200, lng: 76.9660 },
  { id: 'CBE022', name: 'Raj Bhavan',             lat: 11.0170, lng: 76.9630 },
  { id: 'CBE023', name: 'Puliakulam',             lat: 11.0130, lng: 76.9580 },
  { id: 'CBE024', name: 'Vilankurichi',           lat: 11.0080, lng: 76.9500 },
  { id: 'CBE025', name: 'Vadavalli',              lat: 11.0020, lng: 76.9420 },
  { id: 'CBE026', name: 'Coimbatore Junction',    lat: 11.0024, lng: 76.9659 },
  { id: 'CBE027', name: 'Tatabad',                lat: 10.9990, lng: 76.9620 },
  { id: 'CBE028', name: 'Gandhipuram West',       lat: 10.9960, lng: 76.9580 },
  { id: 'CBE029', name: 'DB Road',                lat: 10.9920, lng: 76.9540 },
  { id: 'CBE030', name: 'Kovaipudur',             lat: 10.9870, lng: 76.9490 },
  { id: 'CBE031', name: 'Kuniyamuthur',           lat: 10.9820, lng: 76.9440 },
  { id: 'CBE032', name: 'Kalapatti',              lat: 11.0480, lng: 77.0200 },
  { id: 'CBE033', name: 'TNAU Gate',              lat: 11.0420, lng: 77.0080 },
  { id: 'CBE034', name: 'Codissia Trade Fair',    lat: 11.0360, lng: 76.9960 },
  { id: 'CBE035', name: 'Neel Kamal',             lat: 11.0290, lng: 76.9850 },
  { id: 'CBE036', name: 'Lakshmi Mills',          lat: 11.0200, lng: 76.9750 },
  { id: 'CBE037', name: 'R.S. Puram West',        lat: 11.0100, lng: 76.9660 },
  { id: 'CBE038', name: 'Sulur Bus Stop',         lat: 11.0290, lng: 77.1220 },
  { id: 'CBE039', name: 'Sulur Town',             lat: 11.0260, lng: 77.0980 },
  { id: 'CBE040', name: 'Chinniyampalayam',       lat: 11.0240, lng: 77.0750 },
  { id: 'CBE041', name: 'Kannampalayam',          lat: 11.0210, lng: 77.0500 },
  { id: 'CBE042', name: 'Nava India',             lat: 11.0190, lng: 77.0280 },
  { id: 'CBE043', name: 'Singanallur Junction',   lat: 11.0160, lng: 77.0100 },
  { id: 'CBE044', name: 'Mettupalayam Road',      lat: 11.0600, lng: 76.9850 },
  { id: 'CBE045', name: 'Selvapuram',             lat: 11.0520, lng: 76.9800 },
  { id: 'CBE046', name: 'Seeranaickenpalayam',    lat: 11.0440, lng: 76.9750 },
  { id: 'CBE047', name: 'Velandipalayam',         lat: 11.0360, lng: 76.9720 },
  { id: 'CBE048', name: 'Cheran Ma Nagar',        lat: 11.0280, lng: 76.9690 },
  { id: 'CBE049', name: 'Koundampalayam',         lat: 11.0320, lng: 76.9480 },
  { id: 'CBE050', name: 'Saravanampatti',         lat: 11.0410, lng: 76.9620 },
  { id: 'CBE051', name: 'ITI Layout',             lat: 11.0360, lng: 76.9700 },
  { id: 'CBE052', name: 'Thudiyalur',             lat: 11.0280, lng: 76.9640 },
  { id: 'CBE053', name: 'VGP Layout',             lat: 11.0210, lng: 76.9610 },
  { id: 'CBE054', name: 'Peelamedu Airport',      lat: 11.0280, lng: 77.0440 },
  { id: 'CBE055', name: 'Eachanari',              lat: 10.9910, lng: 76.9640 },
  { id: 'CBE056', name: 'Madukkarai',             lat: 10.9830, lng: 76.9740 },
  { id: 'CBE057', name: 'Thondamuthur',           lat: 10.9760, lng: 76.9640 },
  { id: 'CBE058', name: 'Siruvani Road',          lat: 10.9700, lng: 76.9540 },
  { id: 'CBE059', name: 'Perur',                  lat: 10.9850, lng: 76.9420 },
];

export const ROUTES: RouteDef[] = [
  {
    id: 'R1', shortName: '1A', longName: 'Gandhipuram – Ukkadam', color: '#1d6ef5',
    stops: ['CBE001', 'CBE002', 'CBE003', 'CBE004', 'CBE005', 'CBE006', 'CBE007'],
    headwayMin: { peak: 8, offPeak: 15 }, avgSpeedKph: 19, dwellSec: 35, layoverSec: 300, capacity: 52,
  },
  {
    id: 'R2', shortName: '9C', longName: 'Singanallur – Peelamedu', color: '#db2777',
    stops: ['CBE008', 'CBE009', 'CBE010', 'CBE011', 'CBE012', 'CBE013'],
    headwayMin: { peak: 10, offPeak: 20 }, avgSpeedKph: 21, dwellSec: 30, layoverSec: 300, capacity: 48,
  },
  {
    id: 'R3', shortName: '15', longName: 'Podanur – Bharathiyar University', color: '#16a34a',
    stops: ['CBE014', 'CBE015', 'CBE016', 'CBE017', 'CBE018', 'CBE019'],
    headwayMin: { peak: 12, offPeak: 24 }, avgSpeedKph: 20, dwellSec: 30, layoverSec: 360, capacity: 56,
  },
  {
    id: 'R4', shortName: '21E', longName: 'Saibaba Colony – Vadavalli', color: '#ea580c',
    stops: ['CBE020', 'CBE021', 'CBE022', 'CBE023', 'CBE024', 'CBE025'],
    headwayMin: { peak: 12, offPeak: 25 }, avgSpeedKph: 22, dwellSec: 30, layoverSec: 300, capacity: 50,
  },
  {
    id: 'R5', shortName: '7B', longName: 'Coimbatore Junction – Kuniyamuthur', color: '#7c3aed',
    stops: ['CBE026', 'CBE027', 'CBE028', 'CBE029', 'CBE030', 'CBE031'],
    headwayMin: { peak: 15, offPeak: 30 }, avgSpeedKph: 23, dwellSec: 30, layoverSec: 300, capacity: 44,
  },
  {
    id: 'R6', shortName: '33', longName: 'Kalapatti – R.S. Puram West', color: '#b45309',
    stops: ['CBE032', 'CBE033', 'CBE034', 'CBE035', 'CBE036', 'CBE037'],
    headwayMin: { peak: 15, offPeak: 30 }, avgSpeedKph: 24, dwellSec: 35, layoverSec: 420, capacity: 46,
  },
  {
    id: 'R7', shortName: '44A', longName: 'Sulur – Gandhipuram', color: '#0d9488',
    stops: ['CBE038', 'CBE039', 'CBE040', 'CBE041', 'CBE042', 'CBE043', 'CBE001'],
    headwayMin: { peak: 20, offPeak: 40 }, avgSpeedKph: 28, dwellSec: 40, layoverSec: 480, capacity: 54,
  },
  {
    id: 'R8', shortName: '18', longName: 'Mettupalayam Road – Gandhipuram', color: '#dc2626',
    stops: ['CBE044', 'CBE045', 'CBE046', 'CBE047', 'CBE048', 'CBE001'],
    headwayMin: { peak: 12, offPeak: 22 }, avgSpeedKph: 21, dwellSec: 30, layoverSec: 300, capacity: 50,
  },
  {
    id: 'R9', shortName: '52', longName: 'Koundampalayam – Peelamedu Airport', color: '#9333ea',
    stops: ['CBE049', 'CBE050', 'CBE051', 'CBE052', 'CBE053', 'CBE054'],
    headwayMin: { peak: 20, offPeak: 40 }, avgSpeedKph: 26, dwellSec: 35, layoverSec: 420, capacity: 46,
  },
  {
    id: 'R10', shortName: '6', longName: 'Ukkadam – Perur', color: '#0284c7',
    stops: ['CBE007', 'CBE055', 'CBE056', 'CBE057', 'CBE058', 'CBE059'],
    headwayMin: { peak: 18, offPeak: 35 }, avgSpeedKph: 25, dwellSec: 30, layoverSec: 360, capacity: 52,
  },
];

/** Service day window. Peak periods get the tighter headway. */
export const SERVICE = {
  startSec: 5 * 3600 + 30 * 60, // 05:30
  endSec: 22 * 3600 + 30 * 60,  // 22:30
  peaks: [
    { fromSec: 7 * 3600, toSec: 10 * 3600 },  // 07:00-10:00
    { fromSec: 17 * 3600, toSec: 20 * 3600 }, // 17:00-20:00
  ],
};
