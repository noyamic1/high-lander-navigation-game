import { GameSession } from './gameSession.js';
import { distanceMeters, randomPointInRing } from './geo.js';

/**
 * Orchestrates sessions: goal generation, position updates and (throttled) rerouting.
 * Dependencies are injected so tests can use a fake router and clock.
 */
export function createGameService({ store, routing, config, now = Date.now, random = Math.random, logger = console }) {
  // In-flight goal generation per session id. Concurrent joins on an empty session (or concurrent
  // restarts) share one promise, so everyone ends up with the same goal.
  const pending = new Map();
  const dedupe = (sessionId, fn) => {
    if (!pending.has(sessionId)) pending.set(sessionId, fn().finally(() => pending.delete(sessionId)));
    return pending.get(sessionId);
  };
  // Per-player rerouting bookkeeping, kept outside the domain model on purpose.
  const routeState = new Map();

  async function generateGoal(origin) {
    const candidate = randomPointInRing(origin, config.goalMinRadiusMeters, config.goalMaxRadiusMeters, random);
    let goal = candidate;
    try {
      // A random point can fall in a building or the sea; snapping guarantees a reachable goal.
      goal = await routing.snapToRoad(candidate);
    } catch (err) {
      logger.warn(`snapToRoad failed, using raw goal: ${err.message}`);
    }
    return goal;
  }

  async function createSession(sessionId, origin) {
    const goal = await generateGoal(origin);
    const session = new GameSession({ id: sessionId, goal, thresholdMeters: config.goalThresholdMeters, createdAt: now() });
    store.set(session);
    return session;
  }

  function getOrCreateSession(sessionId, origin) {
    const existing = store.get(sessionId);
    if (existing) return Promise.resolve(existing);
    return dedupe(sessionId, () => createSession(sessionId, origin));
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
    async join(sessionId, playerId, position, name) {
      const session = await getOrCreateSession(sessionId, position);
      session.addPlayer(playerId, position, name);
      const update = session.updatePosition(playerId, position, now());
      const route = await routeFor(session, playerId, { force: true });
      return { session, route, update };
    },

    /**
     * Synchronous on purpose: the goal/winner decision happens immediately, and the caller can
     * broadcast the move before (slow) rerouting via routeFor.
     */
    updatePosition(sessionId, playerId, position) {
      const session = requireSession(sessionId);
      const update = session.updatePosition(playerId, position, now());
      return { session, update };
    },

    /**
     * New goal around the requesting player, same session and players. Mutating in place (rather
     * than recreating) means a player who leaves mid-restart can't be re-added as a ghost.
     */
    restart(sessionId, playerId) {
      const session = requireSession(sessionId);
      const origin = session.players.get(playerId)?.position;
      if (!origin) throw new Error(`unknown player ${playerId}`);
      return dedupe(sessionId, async () => {
        session.resetGoal(await generateGoal(origin));
        // Old throttle state would block everyone's first route to the new goal.
        for (const id of session.players.keys()) routeState.delete(id);
        return session;
      });
    },

    /** Fresh route for every player who hasn't reached the goal (used after a restart). */
    async routesForAll(session) {
      const ids = [...session.players.values()].filter((p) => p.reachedAt === null).map((p) => p.id);
      const routes = await Promise.all(ids.map((id) => routeFor(session, id, { force: true })));
      return ids.map((playerId, i) => ({ playerId, route: routes[i] }));
    },

    leave(sessionId, playerId) {
      routeState.delete(playerId);
      const session = store.get(sessionId);
      if (!session) return null;
      session.removePlayer(playerId);
      // Free memory for abandoned games; the next join gets a fresh goal.
      if (session.isEmpty) {
        store.delete(sessionId);
        return null;
      }
      return session;
    },

    routeFor,
  };
}
