import { isValidPosition } from './geo.js';

const SESSION_ID_PATTERN = /^[\w-]{1,64}$/;

/**
 * Socket protocol (client -> server, all with an ack callback):
 *   game:join     { sessionId, position }  -> { ok, playerId, session }
 *   player:move   { position }             -> { ok }
 *   game:restart  {}                       -> { ok }
 * Server -> client:
 *   game:state    session snapshot (goal + players)
 *   route:update  { coordinates, distanceMeters, durationSeconds }
 *   goal:reached  { playerId, at }
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

    socket.on('game:join', handle(async ({ sessionId: requested = 'default', position }) => {
      if (!SESSION_ID_PATTERN.test(requested)) throw new Error('invalid sessionId');
      if (!isValidPosition(position)) throw new Error('invalid position');
      if (sessionId) throw new Error('already joined');

      const { session, route, update } = await service.join(requested, playerId, position);
      sessionId = requested;
      socket.join(sessionId);
      socket.emit('game:state', session.toJSON());
      sendRoute(route);
      if (update.justReachedGoal) socket.emit('goal:reached', { playerId, at: Date.now() });
      return { playerId, session: session.toJSON() };
    }));

    socket.on('player:move', handle(async ({ position }) => {
      if (!sessionId) throw new Error('join a session first');
      if (!isValidPosition(position)) throw new Error('invalid position');

      const { session, route, update } = await service.updatePosition(sessionId, playerId, position);
      sendRoute(route);
      if (update.justReachedGoal) {
        socket.emit('goal:reached', { playerId, at: session.players.get(playerId).reachedAt });
      }
      return {};
    }));

    socket.on('game:restart', handle(async () => {
      if (!sessionId) throw new Error('join a session first');
      const session = await service.restart(sessionId, playerId);
      socket.emit('game:state', session.toJSON());
      sendRoute(await service.routeFor(session, playerId, { force: true }));
      return {};
    }));

    socket.on('disconnect', () => {
      if (sessionId) service.leave(sessionId, playerId);
    });
  });
}
