# High Lander Navigation Game

A web-based, real-time navigation game. The player's position comes from the host machine's
location services; a goal is generated nearby, the shortest walkable route is drawn on the map and
kept up to date as the player moves, and the player is told when they reach the goal.

## Quick start

### Docker Compose (recommended)

```bash
docker compose up --build
```

Open http://localhost:3000 and allow location access.

### Without Docker

```bash
cd server
npm install
npm start        # or: npm run dev (auto-restart on change)
```

### Tests

```bash
cd server
npm test
```

## How to play

1. Open the page and allow location access. The browser reads the host machine's position
   (OS location services) via the Geolocation API.
2. A goal net marker appears 150–500 m away, snapped to the nearest walkable road.
3. The red line is the shortest walkable route; it is recalculated as you move.
4. Get within 15 m of the goal to get "Goal reached!". Press **New goal** to play again.

The HUD (top right) shows your position and GPS accuracy, the goal position (with a **Copy**
button), the live straight-line distance to the goal, the OSRM route distance and the game status.
If location permission is denied or the position is unavailable, the HUD shows an error.

## Multi-player competitive mode

Open the same session in several windows or on several machines:

```
http://localhost:3000/?session=race1&name=Alice
http://localhost:3000/?session=race1&name=Bob
```

- `session` picks the game (default `default`); `name` is optional (default `Player-xxxx`).
- Everyone in a session shares **one goal**, created around the first player who joins.
- All players are shown on the shared map in real time (faded balls with name labels) and listed
  in the HUD.
- The **first player to reach the goal wins**: everyone sees "🏆 Alice won!". Players who arrive
  later are told they reached it but not first.
- **New goal** starts a new round for the whole session, with the goal around whoever pressed it.

**Testing two players on one machine:** open two Chrome windows with the URLs above. DevTools
Sensors overrides are per tab, so give each window its own location, then paste the goal into
both and see who wins.

### Concurrency and conflict resolution

| Problem | How it's handled |
|---------|------------------|
| Two players reach the goal at the same moment | `GameSession.updatePosition` checks `winner === null` and sets it with no `await` in between. Node runs one event at a time, so exactly one update wins. The server's arrival order decides, never a client timestamp. |
| Two players join an empty session at the same time | Goal generation is deduplicated per session (a shared promise), so both get the same goal. |
| Two players press "New goal" at the same time | Same deduplication: one new goal for everyone. |
| A player leaves during a restart | Restart mutates the existing session instead of recreating it, so no ghost players. |
| Slow routing delaying other players' updates | The move is broadcast before the OSRM call; routing is per player and throttled. |
| Disconnect / reconnect | The player is removed and the room gets a new snapshot; the client auto-reconnects and re-joins with its last position. |

### Events

| Event | Direction | Audience | When |
|-------|-----------|----------|------|
| `game:join` | client → server | — | first location fix (or reconnect) |
| `player:move` | client → server | — | every location update |
| `game:restart` | client → server | — | "New goal" pressed |
| `game:state` | server → client | whole room | join, leave, restart (full snapshot) |
| `player:moved` | server → client | rest of the room | every move (small delta) |
| `route:update` | server → client | that player only | join, throttled reroute, restart |
| `game:won` | server → client | whole room | first player reaches the goal |
| `goal:reached` | server → client | that player only | reached the goal after someone else won |

## Testing location with Chrome DevTools

Movement comes only from real geolocation (`watchPosition`, `enableHighAccuracy: true`,
`maximumAge: 0`). To test from a desk, override the location in Chrome:

1. Open http://localhost:3000, then DevTools (`Cmd+Opt+I` / `Ctrl+Shift+I`).
2. Open the Command Menu (`Cmd+Shift+P` / `Ctrl+Shift+P`), type **Show Sensors** and press Enter.
3. Under **Location**, pick a preset or choose **Other…** / **Manage** to enter a custom
   latitude and longitude, e.g. `32.085300, 34.781800`.
4. Reload the page. The player marker appears at that location and a goal is generated around it.

**Walking step by step:** keep the Sensors panel open and change the latitude or longitude a
little at a time. The page updates on each change (no reload needed).

| Change | Approx. distance |
|--------|------------------|
| latitude ± 0.0001 | ~11 m north/south |
| longitude ± 0.0001 | ~9.5 m east/west (at latitude 32°) |

The route is recalculated at most every 2 s and only after moving at least 5 m, so wait a moment
between steps to see the red line update.

**Testing goal detection:** click **Copy** next to the goal in the HUD, paste the `lat, lng`
values into the Sensors latitude/longitude fields, and you'll get "Goal reached!" right away
(the threshold is 15 m). Press **New goal** to start again.

**Testing errors:** choose **Location unavailable** in Sensors to see the "position unavailable"
message, or block location for `localhost` (lock icon in the address bar → Location → Block,
then reload) to see the "permission denied" message.

## Architecture

```
Browser (Leaflet + Socket.IO client)          Node.js server
  geolocation.watchPosition ──player:move──▶  socket.js       (validation, protocol)
                                                  │
  map: players, goal, route ◀──game:state───  gameService.js  (goal generation, throttled rerouting)
                            ◀──player:moved─       │        │
                            ◀──route:update─       │        │
                            ◀──game:won─────       │        │
                                              gameSession.js  routing.js ──HTTP──▶ OSRM
                                              (pure domain)   (route + snap)
                                                  │
                                              sessionStore.js (in-memory)
```

| File | Responsibility |
|------|----------------|
| `server/src/index.js` | Composition root: wires Express, Socket.IO and the services; health check; graceful shutdown |
| `server/src/config.js` | All tunables from environment variables |
| `server/src/socket.js` | Socket protocol, input validation, errors returned via ack |
| `server/src/gameService.js` | Creates sessions/goals, applies position updates, throttles rerouting, restarts rounds |
| `server/src/gameSession.js` | Pure domain model: goal, players, goal detection, winner |
| `server/src/routing.js` | OSRM client: shortest route, snap point to road |
| `server/src/geo.js` | Haversine distance, random point in a ring, position validation |
| `server/src/sessionStore.js` | Session storage behind a get/set/delete interface |
| `server/public/` | Static browser client |

### Key design decisions

- **The server is authoritative.** The client only reports its position and renders. Goal
  generation, goal detection and routing happen on the server, so the client can't fake a win and
  multi-player (one shared goal, one winner) needs no redesign.
- **WebSockets (Socket.IO)** for real-time, two-way updates, with automatic reconnection and
  rooms per session.
- **Shortest path via OSRM** over the OpenStreetMap road/footpath graph (`foot` profile), which
  satisfies "permissible map routes only". The goal is snapped to the nearest road (`/nearest`)
  so it is always reachable.
- **Rerouting is throttled** (at most every 2 s and only after moving ≥ 5 m, one request in
  flight per player) to protect the routing engine from GPS noise.
- **Graceful degradation:** if OSRM fails, the game continues with the unsnapped goal and no
  route instead of crashing.
- **Dependency injection** (routing client, store, clock, RNG) keeps the domain testable without
  network or timers.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `OSRM_URL` | `https://routing.openstreetmap.de/routed-foot` | OSRM base URL |
| `OSRM_PROFILE` | `foot` | OSRM profile in the URL |
| `GOAL_MIN_RADIUS_METERS` | `150` | Minimum goal distance from the player |
| `GOAL_MAX_RADIUS_METERS` | `500` | Maximum goal distance from the player |
| `GOAL_THRESHOLD_METERS` | `15` | Distance that counts as reaching the goal |
| `REROUTE_MIN_INTERVAL_MS` | `2000` | Minimum time between route recalculations per player |
| `REROUTE_MIN_DISTANCE_METERS` | `5` | Minimum movement before recalculating |

### Running fully offline (local OSRM)

By default routing uses the public FOSSGIS OSRM server. To remove that dependency, run
`osrm-backend` locally with a regional extract:

```bash
mkdir osrm && cd osrm
wget https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf
docker run -t -v "$PWD:/data" osrm/osrm-backend osrm-extract -p /opt/foot.lua /data/israel-and-palestine-latest.osm.pbf
docker run -t -v "$PWD:/data" osrm/osrm-backend osrm-partition /data/israel-and-palestine-latest.osrm
docker run -t -v "$PWD:/data" osrm/osrm-backend osrm-customize /data/israel-and-palestine-latest.osrm
docker run -d -p 5000:5000 -v "$PWD:/data" osrm/osrm-backend osrm-routed --algorithm mld /data/israel-and-palestine-latest.osrm
```

Then start the game with `OSRM_URL=http://host.docker.internal:5000 docker compose up`.
Map tiles still come from OpenStreetMap; a tile server could be self-hosted the same way.

## Scaling to production

- The game server is stateless apart from `sessionStore`. To run several instances, replace the
  in-memory store with Redis and add the Socket.IO Redis adapter so room broadcasts reach every
  instance. The winner check-and-set then moves to Redis too (`SET winner:<session> <player> NX`),
  because a single event loop no longer guarantees exclusivity across processes.
- Sticky sessions at the load balancer keep each Socket.IO connection on one instance.
- Routing is the expensive part: it's isolated behind `routing.js`, throttled per player, and can
  be scaled independently (self-hosted OSRM replicas).
- `/health` endpoint for container health checks and load balancers; SIGTERM handling for clean
  rolling restarts.
