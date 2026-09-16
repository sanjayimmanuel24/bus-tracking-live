# CityBus Live — Coimbatore

Live bus tracking for Coimbatore city services, built on the transit industry's own
data standards: **GTFS** for the schedule and **GTFS-Realtime** for vehicle positions
and arrival predictions.

```bash
docker compose up -d        # Postgres + PostGIS, Redis
npm install
npm run dev                 # server on :3000, web client on :5173
```

The server runs without either dependency — live state falls back to an in-process
store and history is disabled — so `npm run dev` alone works. The degradation is
logged at startup, never silent.

| Command | What it does |
| --- | --- |
| `npm run dev` | Builds the GTFS feed, then runs server and web client together |
| `npm run build` | Feed, typecheck, web bundle, server check |
| `npm run build:gtfs` | Recompiles `data/network.ts` into `packages/shared/gtfs/` |
| `npm test` | 66 unit and integration tests (Vitest) |
| `npm run typecheck` | Typechecks every workspace |
| `npm run db:migrate` | Applies SQL migrations |

---

## Architecture

```
  driver phone ─┐
                ├── POST /api/ingest ──►  server  ──► Redis      (live state)
  simulator ────┘   (bearer token)          │       ──► Postgres  (history, PostGIS)
                                            │
                                     WebSocket /ws
                                    (viewport-scoped)
                                            │
                                            ▼
                             GTFS static ──► web client
                              /api/gtfs
```

A **vehicle reports only what it can observe**: a GPS fix, a heading, a speed, and
the trip it is working. The server derives everything else from the timetable —
distance along the route, schedule adherence, arrival predictions — by projecting
the reported point onto the trip shape.

That split is the point of Phase 2. The built-in simulator is a *client* of the
server with no privileged access: it authenticates with the same bearer token a
driver's phone would and posts to the same endpoint. Replacing it with real
vehicles is a deployment change, not a rewrite.

### Workspace layout

| Path | Responsibility |
| --- | --- |
| `data/network.ts` | Source network: stops, route stop-sequences, headways |
| `scripts/build-gtfs.ts` | Compiles the network into GTFS, including vehicle scheduling |
| `packages/shared/` | Domain code used by both sides: geometry, GTFS parsing, GTFS-RT types, the arrival model, the simulator |
| `apps/server/` | Ingest API, realtime fanout, history store |
| `apps/web/` | Browser client |

The shared package is what lets the server run the *same* arrival model and GTFS
parser the client uses, rather than a second implementation that drifts.

### API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/ingest` | Vehicle position reports (bearer token) |
| `POST /api/vehicles/register` | Vehicle registry upsert |
| `WS /ws` | Realtime fanout; clients subscribe with a bbox and route filter |
| `GET /api/realtime` | Current GTFS-Realtime feed message as JSON |
| `GET /api/vehicles` | Live vehicles, optionally filtered by route |
| `GET /api/stops/:id/departures` | Departure board across every route serving a stop |
| `GET /api/stops/near` | Stops within a radius (PostGIS) |
| `GET /api/analytics/on-time` | Observed on-time performance by route |
| `GET /api/vehicles/:id/track` | Historical track for replay |
| `GET /api/gtfs/:file` | The static feed, with ETags |
| `GET /health`, `GET /ready` | Liveness; dependency status |

### Viewport-scoped subscriptions

A client tells the server which map area and routes it is showing, and receives
only matching vehicles. Measured on the current network: a city-wide subscription
is **55.9 KB** per snapshot, a single-neighbourhood viewport **13.5 KB** — a 76%
reduction. At 48 buses that is an optimisation; at city scale it is the difference
between a usable phone client and one streaming the whole fleet to show six streets.

### Storage

**Redis** holds current vehicle state, keyed with a TTL — a bus that stops
reporting disappears on its own rather than lingering as a ghost on the map, with
no sweeper process. **Postgres with PostGIS** stores position history as a
`geography(Point,4326)` column, so `ST_DWithin` takes and returns metres with no
projection step. Writes are batched: 48 buses at 2 Hz is ~8.3 million rows a day.

`stop_arrivals` records the actual time each bus reached each stop against the
scheduled time. That is the ground truth the Phase 3 model will be trained and
scored on — without it there are predictions and no way to know whether they were
any good.

---

## What Phase 1 fixed in the original prototype

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

## What Phase 2 changed

**Computation moved off the client.** In Phase 1 the browser ran a simulator that
computed its own delays and predictions, because it was the only thing that
existed. Now a vehicle reports a raw GPS fix and the server derives the rest. That
exposed a problem the simulator had hidden: it tracked layover internally, but the
server sees only a bus parked at a trip origin, and the naive calculation reported
a bus waiting 20 minutes for its departure as *20 minutes early*. Network-wide
adherence sat at −146 seconds. The server now recovers that state from the
timetable, and `tests/resolver.test.ts` guards it.

**The simulator became an ingest client.** It runs in the server process but talks
to it over HTTP with a bearer token, exactly as a driver's phone would. It also
injects Gaussian GPS error (8 m by default) — a simulator that reports exact
positions is one that lets server-side bugs hide. Measured against history, the
mean reported offset from the route shape is 7.0 m, which is the noise being
correctly absorbed by projection rather than mistaken for a detour.

**The client kept its interface.** `WebSocketFeedSource` satisfies the same
`FeedSource` contract the Phase 1 simulator did, so `src/state/` and `src/ui/` were
untouched. The client gained reconnection with backoff and a staleness watchdog: an
open socket is not the same as a live feed, and a map full of frozen buses is worse
than an honest "Reconnecting…".

**The simulation speed control was removed.** It had no meaning once the simulator
moved server-side, and a control that does nothing is worse than no control.

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

66 tests (`npm test`), covering the spherical geometry, the CSV reader (quoted
fields, embedded newlines, BOM, GTFS times past 24:00), the arrival model,
simulator invariants, the position resolver, and the HTTP API driven through
Fastify's `inject()`.

Two exist specifically as regression guards for bugs that were really there:

- **Reported speed matches observed displacement.** The original prototype moved
  markers at ~117 km/h in wall-clock time while displaying an unrelated random walk
  of 8–55 km/h.
- **A bus that has not departed is never reported as early.** The Phase 2 ingest
  path lost the layover state the Phase 1 simulator tracked internally.

The API tests run with neither Postgres nor Redis configured, which also exercises
the in-memory fallbacks — the configuration a contributor gets from a bare
`npm run dev`.

Not yet covered in CI: browser-level end-to-end tests. The full stack was verified
manually against headless Chromium (WebSocket delivery, live rendering, scroll
retention, DOM reuse, mobile layout, zero console errors) and the WebSocket
protocol against a scripted client (viewport filtering, route filtering, malformed
input handling). Committing those as a suite is Phase 5 work.

---

## Roadmap

**Phase 1 — real app structure.** ✅
Vite + TypeScript, GTFS static feed, GTFS-Realtime boundary, corrected physics,
arrival predictions, diff-based rendering, responsive layout.

**Phase 2 — real backend.** ✅ *This release.*
Fastify ingest API with token auth, Postgres + PostGIS history, Redis live state,
WebSocket fanout with viewport-scoped subscriptions, departure boards, on-time
analytics, Docker Compose. The simulator moved server-side and became an ordinary
ingest client.

**Phase 3 — the parts that make it serious.**
Learned ETA model, trained on the `stop_arrivals` ground truth Phase 2 now records,
with published accuracy (MAE against held-out actuals) · OSRM map-matching so buses
follow roads instead of straight lines between stops · Kalman filtering of GPS
noise, stale-fix detection, dead reckoning through signal loss · bus bunching and
headway regularity detection.

**Phase 4 — rider features.**
"Notify me when 5 minutes away" via Web Push · trip planner (RAPTOR over the GTFS) ·
crowding from driver input · offline PWA · Tamil/English localisation.

**Phase 5 — credibility.**
A driver PWA on a real phone in a real vehicle · historical replay over the track
API · ops dashboard · load testing · CI and Playwright end-to-end tests.

---

## Licence and attribution

Map tiles © OpenStreetMap contributors. The GTFS feed in `public/gtfs/` is generated
demonstration data and does not represent a real published agency feed.
