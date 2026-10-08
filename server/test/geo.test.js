import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceMeters, randomPointInRing, isValidPosition } from '../src/geo.js';

const TEL_AVIV = { lat: 32.0853, lng: 34.7818 };

test('distance of a point to itself is zero', () => {
  assert.equal(distanceMeters(TEL_AVIV, TEL_AVIV), 0);
});

test('distance matches a known value (~1 degree of latitude ≈ 111 km)', () => {
  const d = distanceMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
  assert.ok(Math.abs(d - 111195) < 100, `got ${d}`);
});

test('random goal always lands inside the requested ring', () => {
  for (let i = 0; i < 1000; i++) {
    const p = randomPointInRing(TEL_AVIV, 150, 500);
    const d = distanceMeters(TEL_AVIV, p);
    assert.ok(d >= 148 && d <= 502, `distance ${d} out of ring`);
  }
});

test('position validation rejects garbage', () => {
  assert.ok(isValidPosition(TEL_AVIV));
  assert.ok(!isValidPosition(null));
  assert.ok(!isValidPosition({ lat: 'a', lng: 1 }));
  assert.ok(!isValidPosition({ lat: 91, lng: 0 }));
  assert.ok(!isValidPosition({ lat: NaN, lng: 0 }));
});
