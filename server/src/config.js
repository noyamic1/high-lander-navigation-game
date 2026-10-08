// All tunables come from env so the same image runs locally, in compose, or in staging.
const num = (value, fallback) => (value === undefined ? fallback : Number(value));

export const config = {
  port: num(process.env.PORT, 3000),
  // Public FOSSGIS OSRM (walking) by default; point at a local osrm-backend container to drop the cloud dependency.
  osrmUrl: process.env.OSRM_URL || 'https://routing.openstreetmap.de/routed-foot',
  osrmProfile: process.env.OSRM_PROFILE || 'foot',
  goalMinRadiusMeters: num(process.env.GOAL_MIN_RADIUS_METERS, 150),
  goalMaxRadiusMeters: num(process.env.GOAL_MAX_RADIUS_METERS, 500),
  goalThresholdMeters: num(process.env.GOAL_THRESHOLD_METERS, 15),
  // Avoid hammering the routing engine on every GPS tick.
  rerouteMinIntervalMs: num(process.env.REROUTE_MIN_INTERVAL_MS, 2000),
  rerouteMinDistanceMeters: num(process.env.REROUTE_MIN_DISTANCE_METERS, 5),
};
