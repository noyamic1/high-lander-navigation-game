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
2. A 🏁 goal appears 150–500 m away, snapped to the nearest walkable road.
3. The red line is the shortest walkable route; it is recalculated as you move.
4. Get within 15 m of the goal to get "Goal reached!". Press **New goal** to play again.

**Simulation mode:** a desktop doesn't move, so tick *Simulate movement* and use the arrow keys
(5 m per press) or click on the map to move the player. It's also used automatically if location
access is denied.

**Sessions:** `http://localhost:3000/?session=my-game` joins a named session (default: `default`).
Everyone in the same session shares the same goal.

## Architecture

```
Browser (Leaflet + Socket.IO client)          Node.js server
  geolocation.watchPosition ──player:move──▶  socket.js       (validation, protocol)
                                                  │
  map: player, goal, route  ◀──route:update──  gameService.js  (goal generation, throttled rerouting)
                            ◀──goal:reached──      │        │
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
| `server/src/gameService.js` | Creates sessions/goals, applies position updates, throttles rerouting |
| `server/src/gameSession.js` | Pure domain model: goal, players, goal detection |
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
  instance.
- Routing is the expensive part: it's isolated behind `routing.js`, throttled per player, and can
  be scaled independently (self-hosted OSRM replicas).
- `/health` endpoint for container health checks and load balancers; SIGTERM handling for clean
  rolling restarts.
