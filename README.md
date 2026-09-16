# CityBus Live — Coimbatore

Live bus tracking for Coimbatore city services, built on the transit industry's own
data standards: **GTFS** for the schedule and **GTFS-Realtime** for vehicle positions
and arrival predictions.

```
npm install
npm run dev      # http://localhost:5173
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with hot reload |
| `npm run build` | Regenerates the GTFS feed, typechecks, builds to `dist/` |
| `npm run build:gtfs` | Recompiles `data/network.ts` into `public/gtfs/*.txt` |
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` | `tsc --noEmit` |

---

## Architecture

The organising idea is that **the frontend is a dumb consumer of a standard feed**.
It has no privileged access to the simulator and no idea the buses are not real.

```
   data/network.ts                     (authoring format — human editable)
          │  npm run build:gtfs
          ▼
   public/gtfs/*.txt                   GTFS static: stops, routes, trips,
          │                            stop_times, shapes, calendar
          ▼
   src/gtfs/feed.ts ──────────┐
                              ▼
                        src/state/store.ts  ◄──── GTFS-Realtime FeedSource
                              │                   (src/realtime/)
                              ▼                          ▲
                        src/ui/*.ts                      │
                                                 SimulatedFeedSource
                                                 (Phase 1 — in browser)
```

`FeedSource` (`src/realtime/types.ts`) is the seam. Phase 1 ships
`SimulatedFeedSource`, which generates `VehiclePosition`, `TripUpdate` and
`ServiceAlert` entities from the static schedule. Phase 2 replaces it with a
WebSocket client against a real ingest backend. **Nothing in `src/ui/` or
`src/state/` changes** when that happens — only the two lines in `src/main.ts`
that construct the source.

### Why GTFS

Adopting the standard up front is what makes the rest of the roadmap possible:

- A real agency feed can be dropped in by pointing `loadFeed()` at a different URL.
- A real vehicle — a driver's phone posting positions — produces the same entities.
- Trip planning, departure boards and transfer search all assume this data model.
- The prediction output is directly comparable with what agencies publish.

### Module map

| Path | Responsibility |
| --- | --- |
| `data/network.ts` | Source network: stops, route stop-sequences, headways |
| `scripts/build-gtfs.ts` | Compiles the network into a GTFS feed, including vehicle scheduling |
| `src/geo/geo.ts` | Haversine distance, bearings, interpolation and projection onto a path |
| `src/gtfs/` | CSV reader and feed loader with lookup indexes |
| `src/realtime/types.ts` | GTFS-Realtime entity shapes and the `FeedSource` interface |
| `src/realtime/sim/` | The vehicle simulator |
| `src/eta/predict.ts` | **The arrival model.** Isolated so it can be replaced wholesale |
| `src/eta/present.ts` | Turning predictions into rider-readable text |
| `src/state/store.ts` | Joins static + realtime into view models; computes KPIs |
| `src/ui/` | Rendering. Diff-based, never rebuild-everything |

---

## What Phase 1 changed, and why

The starting point was a single 900-line HTML file. It looked good and was a
genuinely useful prototype, but every number on screen came from `Math.random()`.
These were the substantive problems, and how each is addressed:

**Speed had no relationship to motion.**
Markers advanced `0.00022°` (~24 m) per 750 ms tick — about 117 km/h in wall-clock
time, or 2.7 km/h against the simulation's own clock, which ran at ~43×. Meanwhile
the displayed speed random-walked independently between 8 and 55 km/h. Three
different speeds, none agreeing. Now a bus runs each segment at the speed the
timetable implies, and reported speed is derived from actual displacement.
`tests/simulator.test.ts` asserts the two agree.

**Distance was measured in degrees.**
`Math.sqrt(dLat² + dLng²)` conflates units — a degree of longitude at Coimbatore's
latitude is ~1.8% shorter than a degree of latitude — and yields a number that
cannot be converted to metres, so nothing derived from it could be correct.
Everything now uses haversine distance in metres.

**"Delayed" meant nothing.**
Status flipped at random every 18 ticks, with no schedule to be late against. Delay
is now *emergent*: buses run at scheduled speed times a congestion factor, dwell for
as long as boarding actually takes, and delay is measured by comparing position
against the timetable. Congestion and crowding cause delay; delay is not an input.

**There was no ETA.**
The single thing riders open a bus app for was absent. Every bus now carries arrival
predictions for its remaining stops, with an explicit confidence band.

**Buses teleported at the terminus.**
`(i + 1) % stops.length` sent a bus from the last stop back to the first. Buses now
work *blocks* — a sequence of trips assigned by the scheduler — laying over at a
terminus and departing on the return working.

**The fleet list could not be scrolled.**
`innerHTML = ''` on every tick collapsed the container's scroll height, resetting
`scrollTop` to 0 roughly once a second. Rendering is now keyed and diff-based: one
DOM node per vehicle, and only changed fields are written. Scroll, focus and text
selection all survive updates.

**The marker pulse never animated.**
`setIcon()` on every bus every frame replaced 31 DOM subtrees 1.3×/second,
restarting the CSS keyframes each time. Markers are created once and mutated.

**Buses were named after bus stops.**
A vehicle called "Gandhipuram Bus Stand" cannot be tracked across a day, a route
change or a maintenance log. Vehicles now carry registrations (`TN 38 AZ 4471`).

**Alerts were fiction.**
Twelve hardcoded strings chosen at random, never corresponding to anything visible.
Alerts are now generated from simulation state and name the route and stop involved.

**Desktop only.**
Fixed 318px sidebar, `overflow: hidden`, 100vh, 7px type. The sidebar is now a
bottom sheet below 900px. Riders are on phones.

**XSS surface.**
`innerHTML` with interpolated data everywhere. Structure is built once; all dynamic
values go through `textContent`.

Also added: keyboard navigation and ARIA labelling throughout, a dark theme, a
`prefers-reduced-motion` path, and pausing the feed when the tab is hidden.

---

## The arrival model

`src/eta/predict.ts` propagates a vehicle's measured delay forward, decaying it
~7% per stop (drivers recover time) and widening the uncertainty band with the
horizon. This is what most agency GTFS-Realtime producers actually ship, so it is a
real baseline rather than a placeholder — but it is a baseline. It assumes current
delay is the best estimate of future delay, which is wrong in exactly the cases
riders care about: a junction that is always jammed at 18:30, or a segment that runs
fast on a Sunday.

It is deliberately one small module with a narrow signature. Phase 3 replaces its
body with a model trained on observed segment travel times keyed by
`(segment, hour-of-day, day-of-week)`; the `StopTimeUpdate[]` output is unchanged,
which is also what makes the two directly comparable when measuring whether the new
model is actually better.

The UI always shows the confidence band (`4 min ±1 min`). A bare minute figure reads
as a promise the model cannot keep.

---

## Data provenance

**These are not surveyed coordinates.** Stop positions and route stop-sequences were
carried over from the original prototype and are plausible but unverified against
actual TNSTC / Coimbatore City Municipal Corporation services. Before this is useful
to a real rider, the network needs:

- Stop locations surveyed, or sourced from OpenStreetMap / the agency
- Route sequences checked against published timetables
- Real headways and running times rather than derived averages

Two known issues in the inherited data:

- Route **52** jumps ~9 km from VGP Layout to Peelamedu Airport with no
  intermediate stop. The schedule handles it consistently (it reads as a ~25 minute
  express leg) but it is unlikely to reflect the real service.
- `shapes.txt` is straight lines between stops, so buses cut across blocks rather
  than following roads. Phase 3 fixes this with OSRM map-matching against an
  OpenStreetMap extract.

Three stop-name variants in the original data were merged as the same physical
location: "Gandhipuram Bus Stand" / "Gandhipuram" → `CBE001`, and
"Ukkadam Bus Terminus" / "Ukkadam" → `CBE007`. Shared stops are what make
interchange and transfer search possible at all.

### Derived service levels

`npm run build:gtfs` reports what the timetable actually requires — these numbers are
computed by the vehicle scheduler, not assumed:

```
  Route   Buses   Trips/day   Round trip
  --------------------------------------------
  1A          6         179       36 min
  9C          6         138       45 min
  15          4         115       45 min
  21E         4         111       35 min
  7B          4          93       31 min
  33          4          93       55 min
  44A         6          68       91 min
  18          4         120       45 min
  52          6          68       83 min
  6           4          77       52 min
  --------------------------------------------
  TOTAL      48        1062
```

---

## Testing

42 unit tests (`npm test`) covering the spherical geometry, the CSV reader
(quoted fields, embedded newlines, BOM, GTFS times past 24:00), the arrival model,
and simulator invariants.

The most important one asserts that **reported speed matches observed
displacement** — a direct regression test for the prototype's core inconsistency.
Others cover block progression without teleporting, warm-starting each block at the
correct trip for the current clock, and reproducibility from a fixed seed.

Not yet covered: any browser-level end-to-end tests. Phase 1 was verified manually
against a headless Chromium (render, scroll retention, DOM reuse, route filtering,
mobile layout, zero console errors); making that a committed Playwright suite is
Phase 5 work.

---

## Roadmap

**Phase 1 — real app structure.** ✅ *This release.*
Vite + TypeScript, GTFS static feed, GTFS-Realtime boundary, corrected physics,
arrival predictions, diff-based rendering, responsive layout.

**Phase 2 — real backend.**
Fastify or FastAPI ingest API, Postgres + PostGIS, Redis for live state, WebSocket
fanout with viewport-scoped subscriptions. The simulator moves server-side and posts
to the same `/ingest` endpoint a real vehicle would.

**Phase 3 — the parts that make it serious.**
Learned ETA model with published accuracy (MAE against held-out actuals) · OSRM
map-matching so buses follow roads · Kalman filtering of GPS noise, stale-fix
detection, dead reckoning through signal loss · bus bunching and headway regularity
detection.

**Phase 4 — rider features.**
"Notify me when 5 minutes away" via Web Push · trip planner (RAPTOR over the GTFS) ·
crowding from driver input · offline PWA · Tamil/English localisation.

**Phase 5 — credibility.**
A driver PWA on a real phone in a real vehicle · historical replay · ops dashboard
(on-time performance, dwell distributions, ridership heatmaps) · load testing ·
Docker Compose, CI, Playwright end-to-end tests.

---

## Licence and attribution

Map tiles © OpenStreetMap contributors. The GTFS feed in `public/gtfs/` is generated
demonstration data and does not represent a real published agency feed.
