import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoutingClient } from '../src/routing.js';

const fakeFetch = (body, ok = true) => async (url) => {
  fakeFetch.lastUrl = url;
  return { ok, status: ok ? 200 : 500, json: async () => body };
};

test('getRoute builds an OSRM url in lng,lat order and flips geometry to lat,lng', async () => {
  const fetchImpl = fakeFetch({
    code: 'Ok',
    routes: [{ distance: 100, duration: 80, geometry: { coordinates: [[34.1, 32.1], [34.2, 32.2]] } }],
  });
  const client = createRoutingClient({ baseUrl: 'http://osrm', profile: 'foot', fetchImpl });
  const route = await client.getRoute({ lat: 32.1, lng: 34.1 }, { lat: 32.2, lng: 34.2 });

  assert.match(fakeFetch.lastUrl, /^http:\/\/osrm\/route\/v1\/foot\/34.1,32.1;34.2,32.2\?/);
  assert.deepEqual(route.coordinates, [[32.1, 34.1], [32.2, 34.2]]);
  assert.equal(route.distanceMeters, 100);
});

test('snapToRoad returns the snapped location', async () => {
  const fetchImpl = fakeFetch({ code: 'Ok', waypoints: [{ location: [34.5, 32.5] }] });
  const client = createRoutingClient({ baseUrl: 'http://osrm', profile: 'foot', fetchImpl });
  assert.deepEqual(await client.snapToRoad({ lat: 32.49, lng: 34.49 }), { lat: 32.5, lng: 34.5 });
});

test('OSRM errors are surfaced as exceptions', async () => {
  const client = createRoutingClient({
    baseUrl: 'http://osrm',
    profile: 'foot',
    fetchImpl: fakeFetch({ code: 'NoRoute' }),
  });
  await assert.rejects(client.getRoute({ lat: 0, lng: 0 }, { lat: 1, lng: 1 }), /NoRoute/);
});
