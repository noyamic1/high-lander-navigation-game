import { GameSession } from './gameSession.js';
import { distanceMeters, randomPointInRing } from './geo.js';

/**
 * Orchestrates sessions: goal generation, position updates and (throttled) rerouting.
 * Dependencies are injected so tests can use a fake router and clock.
 */
export function createGameService({ store, routing, config, now = Date.now, random = Math.random, logger = console }) {
  // Pending creations per session id: two joins racing on an empty session must share one goal.
  const creating = new Map();
  // Per-player rerouting bookkeeping, kept outside the domain model on purpose.
  const routeState = new Map();

  async function createSession(sessionId, origin) {
    const candidate = randomPointInRing(origin, config.goalMinRadiusMeters, config.goalMaxRadiusMeters, random);
    let goal = candidate;
    try {
      // A random point can fall in a building or the sea; snapping guarantees a reachable goal.
      goal = await routing.snapToRoad(candidate);
    } catch (err) {
      logger.warn(`snapToRoad failed, using raw goal: ${err.message}`);
    }
    const session = new GameSession({ id: sessionId, goal, thresholdMeters: config.goalThresholdMeters, createdAt: now() });
    store.set(session);
    return session;
  }

  function getOrCreateSession(sessionId, origin) {
    const existing = store.get(sessionId);
    if (existing) return Promise.resolve(existing);
    if (!creating.has(sessionId)) {
      creating.set(sessionId, createSession(sessionId, origin).finally(() => creating.delete(sessionId)));
    }
    return creating.get(sessionId);
  }

  function requireSession(sessionId) {
    const session = store.get(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    return session;
  }

  /** Returns a route, or null if rerouting is throttled / already in flight / failed. */
  async function routeFor(session, playerId, { force = false } = {}) {
    const player = session.players.get(playerId);
    if (!player) return null;

    const state = routeState.get(playerId) ?? { at: 0, from: null, inFlight: false };
    routeState.set(playerId, state);
    if (state.inFlight) return null;
    if (!force) {
      const tooSoon = now() - state.at < config.rerouteMinIntervalMs;
      const barelyMoved = state.from && distanceMeters(state.from, player.position) < config.rerouteMinDistanceMeters;
      if (tooSoon || barelyMoved) return null;
    }

    const from = player.position;
    state.inFlight = true;
    try {
      const route = await routing.getRoute(from, session.goal);
      state.at = now();
      state.from = from;
      return route;
    } catch (err) {
      logger.warn(`getRoute failed for ${playerId}: ${err.message}`);
      return null;
    } finally {
      state.inFlight = false;
    }
  }

  return {
    async join(sessionId, playerId, position) {
      const session = await getOrCreateSession(sessionId, position);
      session.addPlayer(playerId, position);
      const update = session.updatePosition(playerId, position, now());
      const route = await routeFor(session, playerId, { force: true });
      return { session, route, update };
    },

    async updatePosition(sessionId, playerId, position) {
      const session = requireSession(sessionId);
      const update = session.updatePosition(playerId, position, now());
      // No point routing someone who is already at the goal.
      const route = update.hasReachedGoal ? null : await routeFor(session, playerId);
      return { session, route, update };
    },

    /** New goal around the requesting player; everyone in the session keeps playing. */
    async restart(sessionId, playerId) {
      const old = requireSession(sessionId);
      const origin = old.players.get(playerId)?.position;
      if (!origin) throw new Error(`unknown player ${playerId}`);
      store.delete(sessionId);
      const session = await getOrCreateSession(sessionId, origin);
      for (const p of old.players.values()) session.addPlayer(p.id, p.position);
      return session;
    },

    leave(sessionId, playerId) {
      routeState.delete(playerId);
      const session = store.get(sessionId);
      if (!session) return null;
      session.removePlayer(playerId);
      // Free memory for abandoned games; the next join gets a fresh goal.
      if (session.isEmpty) store.delete(sessionId);
      return session;
    },

    routeFor,
  };
}
