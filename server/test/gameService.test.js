import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameService } from '../src/gameService.js';
import { InMemorySessionStore } from '../src/sessionStore.js';
import { distanceMeters } from '../src/geo.js';

const START = { lat: 32.0853, lng: 34.7818 };
const config = {
  goalMinRadiusMeters: 150,
  goalMaxRadiusMeters: 500,
  goalThresholdMeters: 15,
  rerouteMinIntervalMs: 2000,
  rerouteMinDistanceMeters: 5,
};
const silent = { warn() {} };

function setup({ routing } = {}) {
  let clock = 0;
  const calls = { route: 0, snap: 0 };
  const fakeRouting = routing ?? {
    async snapToRoad(p) { calls.snap++; return p; },
    async getRoute(from, to) { calls.route++; return { coordinates: [[from.lat, from.lng], [to.lat, to.lng]], distanceMeters: 1, durationSeconds: 1 }; },
  };
  const service = createGameService({
    store: new InMemorySessionStore(), routing: fakeRouting, config, now: () => clock, logger: silent,
  });
  return { service, calls, tick: (ms) => { clock += ms; } };
}

test('join creates a goal within the configured radius and returns a route', async () => {
  const { service } = setup();
  const { session, route } = await service.join('s1', 'p1', START);
  const d = distanceMeters(START, session.goal);
  assert.ok(d >= 148 && d <= 502, `goal at ${d}m`);
  assert.ok(route.coordinates.length > 0);
});

test('concurrent joins on a new session share one goal', async () => {
  const { service, calls } = setup();
  const [a, b] = await Promise.all([service.join('s1', 'p1', START), service.join('s1', 'p2', START)]);
  assert.equal(a.session, b.session);
  assert.equal(calls.snap, 1);
});

test('rerouting is throttled by time and by distance moved', async () => {
  const { service, calls, tick } = setup();
  await service.join('s1', 'p1', START);
  assert.equal(calls.route, 1);

  const moved = { lat: START.lat + 0.001, lng: START.lng }; // ~110 m
  const move = async () => {
    const { session } = service.updatePosition('s1', 'p1', moved);
    return service.routeFor(session, 'p1');
  };
  await move();
  assert.equal(calls.route, 1, 'too soon');

  tick(3000);
  await move();
  assert.equal(calls.route, 2, 'enough time and distance');

  tick(3000);
  await move();
  assert.equal(calls.route, 2, 'did not move');
});

test('falls back to the raw goal if snapping fails', async () => {
  const { service } = setup({
    routing: {
      async snapToRoad() { throw new Error('down'); },
      async getRoute() { throw new Error('down'); },
    },
  });
  const { session, route } = await service.join('s1', 'p1', START);
  assert.ok(session.goal);
  assert.equal(route, null);
});

test('session is removed when the last player leaves', async () => {
  const { service } = setup();
  const { session } = await service.join('s1', 'p1', START);
  service.leave('s1', 'p1');
  const again = await service.join('s1', 'p1', START);
  assert.notEqual(again.session, session);
});

test('first player to reach the goal wins; later arrivals do not', async () => {
  const { service, tick } = setup();
  const { session } = await service.join('s1', 'p1', START, 'Alice');
  await service.join('s1', 'p2', START, 'Bob');

  tick(10);
  const first = service.updatePosition('s1', 'p2', session.goal);
  tick(10);
  const second = service.updatePosition('s1', 'p1', session.goal);

  assert.equal(first.update.isWinner, true);
  assert.equal(second.update.isWinner, false);
  assert.equal(second.update.justReachedGoal, true, 'late arrival still reached the goal');
  assert.deepEqual(session.winner, { playerId: 'p2', name: 'Bob', at: 10 });
});

test('restart keeps players, resets winner and gives everyone a fresh route', async () => {
  const { service, calls } = setup();
  const { session } = await service.join('s1', 'p1', START);
  await service.join('s1', 'p2', START);
  service.updatePosition('s1', 'p1', session.goal);
  const oldGoal = session.goal;

  const restarted = await service.restart('s1', 'p2');
  assert.equal(restarted, session, 'same session object');
  assert.notDeepEqual(restarted.goal, oldGoal);
  assert.equal(restarted.winner, null);
  assert.equal(restarted.players.size, 2);

  const before = calls.route;
  const routes = await service.routesForAll(restarted);
  assert.equal(routes.length, 2);
  assert.equal(calls.route - before, 2, 'throttle was reset for everyone');
});

test('concurrent restarts produce a single new goal', async () => {
  const { service, calls } = setup();
  await service.join('s1', 'p1', START);
  await service.join('s1', 'p2', START);
  const snapsBefore = calls.snap;
  const [a, b] = await Promise.all([service.restart('s1', 'p1'), service.restart('s1', 'p2')]);
  assert.equal(a.goal, b.goal);
  assert.equal(calls.snap - snapsBefore, 1);
});
