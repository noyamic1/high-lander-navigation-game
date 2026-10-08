import { distanceMeters } from './geo.js';

/**
 * Pure domain model of one game: a fixed goal and the players chasing it.
 * No I/O here, so it is trivially testable and could be serialized to a shared store later.
 * Players is a Map from day one so multi-player (Part 2) is the same model with more entries.
 */
export class GameSession {
  constructor({ id, goal, thresholdMeters, createdAt = Date.now() }) {
    this.id = id;
    this.goal = goal;
    this.thresholdMeters = thresholdMeters;
    this.createdAt = createdAt;
    this.players = new Map();
    this.winner = null;
  }

  addPlayer(playerId, position, name = playerId) {
    this.players.set(playerId, { id: playerId, name, position, reachedAt: null });
  }

  /** New round in the same session: players stay, goal and results reset. */
  resetGoal(goal) {
    this.goal = goal;
    this.winner = null;
    for (const player of this.players.values()) player.reachedAt = null;
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
  }

  get isEmpty() {
    return this.players.size === 0;
  }

  /** Moves a player and reports whether this update is the one that reached the goal. */
  updatePosition(playerId, position, at = Date.now()) {
    const player = this.players.get(playerId);
    if (!player) throw new Error(`unknown player ${playerId}`);

    player.position = position;
    const distanceToGoal = distanceMeters(position, this.goal);
    // Only fire once per player, otherwise every GPS tick near the goal would re-trigger.
    const justReachedGoal = player.reachedAt === null && distanceToGoal <= this.thresholdMeters;
    if (justReachedGoal) player.reachedAt = at;

    // Conflict resolution for "who was first": check-and-set with no await in between, so within
    // one Node process no other update can interleave. Server arrival order decides, never a
    // client-sent timestamp (clients can lie or have skewed clocks).
    const isWinner = justReachedGoal && this.winner === null;
    if (isWinner) this.winner = { playerId, name: player.name, at };

    return { distanceToGoal, justReachedGoal, isWinner, hasReachedGoal: player.reachedAt !== null };
  }

  toJSON() {
    return {
      id: this.id,
      goal: this.goal,
      thresholdMeters: this.thresholdMeters,
      players: [...this.players.values()],
      winner: this.winner,
    };
  }
}
