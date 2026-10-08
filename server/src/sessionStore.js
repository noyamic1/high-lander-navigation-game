/**
 * In-memory session store. The service only depends on get/set/delete, so swapping in a
 * Redis-backed store for horizontal scaling doesn't touch game logic.
 */
export class InMemorySessionStore {
  #sessions = new Map();

  get(id) {
    return this.#sessions.get(id);
  }

  set(session) {
    this.#sessions.set(session.id, session);
  }

  delete(id) {
    this.#sessions.delete(id);
  }
}
