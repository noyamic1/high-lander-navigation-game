import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameSession } from '../src/gameSession.js';

const GOAL = { lat: 32.0853, lng: 34.7818 };
const FAR = { lat: 32.0953, lng: 34.7818 }; // ~1.1 km north
const NEAR = { lat: 32.08535, lng: 34.7818 }; // ~5 m

test('goal reached fires exactly once when entering the threshold', () => {
  const s = new GameSession({ id: 's', goal: GOAL, thresholdMeters: 15 });
  s.addPlayer('p1', FAR);

  assert.equal(s.updatePosition('p1', FAR).justReachedGoal, false);
  const first = s.updatePosition('p1', NEAR, 1000);
  assert.equal(first.justReachedGoal, true);
  assert.equal(s.players.get('p1').reachedAt, 1000);
  assert.equal(s.updatePosition('p1', NEAR).justReachedGoal, false);
});

test('updating an unknown player throws', () => {
  const s = new GameSession({ id: 's', goal: GOAL, thresholdMeters: 15 });
  assert.throws(() => s.updatePosition('ghost', FAR), /unknown player/);
});
