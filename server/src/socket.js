import { isValidPosition } from './geo.js';

const SESSION_ID_PATTERN = /^[\w-]{1,64}$/;
const NAME_PATTERN = /^[\p{L}\p{N} _-]{1,20}$/u;

/**
 * Socket protocol (client -> server, all with an ack callback):
 *   game:join     { sessionId, position, name? } -> { ok, playerId, session, distanceToGoal }
 *   player:move   { position }                   -> { ok, distanceToGoal }
 *   game:restart  {}                             -> { ok }
 * Server -> client:
 *   game:state    full session snapshot (goal, players, winner)  -> whole room, on membership/goal change
 *   player:moved  { id, position }                               -> rest of the room, on every move
 *   route:update  { coordinates, distanceMeters, durationSeconds } -> only the player it belongs to
 *   game:won      { playerId, name, at }                         -> whole room, once per round
 *   goal:reached  { playerId, at }                               -> a player who arrived after the winner
 */
export function registerSocketHandlers(io, service, logger = console) {
  io.on('connection', (socket) => {
    // socket.id is the player id: one connection == one player.
    const playerId = socket.id;
    let sessionId = null;

    // Wraps handlers so a bad payload or failure answers the client instead of crashing the process.
    const handle = (fn) => async (payload, ack = () => {}) => {
      try {
        ack({ ok: true, ...(await fn(payload ?? {})) });
      } catch (err) {
        logger.warn(`[${playerId}] ${err.message}`);
        ack({ ok: false, error: err.message });
      }
    };

    const sendRoute = (route) => route && socket.emit('route:update', route);

    // The winner is announced to everyone; a late arrival only hears about it themselves.
    function announceGoal(session, update) {
      if (update.isWinner) io.to(sessionId).emit('game:won', session.winner);
      else if (update.justReachedGoal) {
        socket.emit('goal:reached', { playerId, at: session.players.get(playerId).reachedAt });
      }
    }

    socket.on('game:join', handle(async ({ sessionId: requested = 'default', position, name }) => {
      if (!SESSION_ID_PATTERN.test(requested)) throw new Error('invalid sessionId');
      if (!isValidPosition(position)) throw new Error('invalid position');
      if (sessionId) throw new Error('already joined');
      const playerName = typeof name === 'string' && name.trim() ? name.trim() : `Player-${playerId.slice(0, 4)}`;
      if (!NAME_PATTERN.test(playerName)) throw new Error('invalid name');

      const { session, route, update } = await service.join(requested, playerId, position, playerName);
      sessionId = requested;
      socket.join(sessionId);
      // Membership changed: everyone, including the newcomer, gets the full snapshot.
      io.to(sessionId).emit('game:state', session.toJSON());
      sendRoute(route);
      announceGoal(session, update);
      return { playerId, session: session.toJSON(), distanceToGoal: update.distanceToGoal };
    }));

    socket.on('player:move', handle(async ({ position }) => {
      if (!sessionId) throw new Error('join a session first');
      if (!isValidPosition(position)) throw new Error('invalid position');

      // Goal/winner decided synchronously, then broadcast before the slow routing call so other
      // players see the move without waiting on OSRM.
      const { session, update } = service.updatePosition(sessionId, playerId, position);
      socket.to(sessionId).emit('player:moved', { id: playerId, position });
      announceGoal(session, update);
      // No point routing someone who is already at the goal.
      if (!update.hasReachedGoal) sendRoute(await service.routeFor(session, playerId));
      return { distanceToGoal: update.distanceToGoal };
    }));

    socket.on('game:restart', handle(async () => {
      if (!sessionId) throw new Error('join a session first');
      const session = await service.restart(sessionId, playerId);
      io.to(sessionId).emit('game:state', session.toJSON());
      // New goal: every player needs a new route, not just the one who asked.
      // Each socket is automatically in a room named after its id, so io.to(id) targets one player.
      for (const { playerId: id, route } of await service.routesForAll(session)) {
        if (route) io.to(id).emit('route:update', route);
      }
      return {};
    }));

    socket.on('disconnect', () => {
      if (!sessionId) return;
      const session = service.leave(sessionId, playerId);
      if (session) io.to(sessionId).emit('game:state', session.toJSON());
    });
  });
}
