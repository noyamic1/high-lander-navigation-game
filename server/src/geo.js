// Pure geo helpers. Positions are { lat, lng } in degrees.

const EARTH_RADIUS_METERS = 6371000;
const METERS_PER_DEGREE_LAT = 111320;

const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in meters (haversine). */
export function distanceMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

/**
 * Random point in the ring [minMeters, maxMeters] around center.
 * sqrt on the radius keeps points uniformly spread by area instead of clustered near the center.
 * Flat-earth offset is accurate enough for radii of a few km.
 */
export function randomPointInRing(center, minMeters, maxMeters, random = Math.random) {
  const angle = random() * 2 * Math.PI;
  const r = Math.sqrt(random() * (maxMeters ** 2 - minMeters ** 2) + minMeters ** 2);
  const dNorth = r * Math.cos(angle);
  const dEast = r * Math.sin(angle);
  return {
    lat: center.lat + dNorth / METERS_PER_DEGREE_LAT,
    lng: center.lng + dEast / (METERS_PER_DEGREE_LAT * Math.cos(toRad(center.lat))),
  };
}

export function isValidPosition(p) {
  return (
    p != null &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}
