// Thin OSRM client. OSRM only routes over the road/footpath graph, which is what
// "permissible map routes" means. Note OSRM uses lng,lat order, we use { lat, lng }.

const REQUEST_TIMEOUT_MS = 5000;

export function createRoutingClient({ baseUrl, profile, fetchImpl = fetch }) {
  async function call(service, coords, query = '') {
    const path = coords.map((p) => `${p.lng},${p.lat}`).join(';');
    const url = `${baseUrl}/${service}/v1/${profile}/${path}${query}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`OSRM ${service} HTTP ${res.status}`);
    const body = await res.json();
    if (body.code !== 'Ok') throw new Error(`OSRM ${service} error: ${body.code}`);
    return body;
  }

  return {
    /** Shortest route over the road graph. Returns a polyline as [[lat, lng], ...]. */
    async getRoute(from, to) {
      const body = await call('route', [from, to], '?overview=full&geometries=geojson');
      const route = body.routes[0];
      return {
        coordinates: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
        distanceMeters: route.distance,
        durationSeconds: route.duration,
      };
    },

    /** Snap a point to the nearest routable road, so a random goal is always reachable. */
    async snapToRoad(point) {
      const body = await call('nearest', [point]);
      const [lng, lat] = body.waypoints[0].location;
      return { lat, lng };
    },
  };
}
