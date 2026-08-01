import { HttpsError } from 'firebase-functions/v2/https';
import type { LocationInput } from './types';

const EARTH_RADIUS_METERS = 6371008.8;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle distance in metres between two WGS-84 points.
 *
 * Haversine is accurate to ~0.5 % which is far below the noise floor of a phone
 * GPS fix, so there is no reason to reach for Vincenty here.
 */
export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function assertValidLatLng(lat: unknown, lng: unknown): { lat: number; lng: number } {
  if (!isFiniteNumber(lat) || lat < -90 || lat > 90) {
    throw new HttpsError('invalid-argument', 'Latitude must be a number between -90 and 90.');
  }
  if (!isFiniteNumber(lng) || lng < -180 || lng > 180) {
    throw new HttpsError('invalid-argument', 'Longitude must be a number between -180 and 180.');
  }
  return { lat, lng };
}

/**
 * Normalises an untrusted location payload, rejecting anything malformed.
 * Returns null when no usable fix was supplied.
 */
export function parseLocation(raw: unknown): LocationInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;

  if (!isFiniteNumber(input.lat) || !isFiniteNumber(input.lng)) return null;
  const { lat, lng } = assertValidLatLng(input.lat, input.lng);

  // A fix with no accuracy value is not verifiable, so treat it as the worst
  // possible case rather than silently trusting it.
  const accuracy = isFiniteNumber(input.accuracy) && input.accuracy >= 0
    ? input.accuracy
    : Number.POSITIVE_INFINITY;

  const capturedAt = isFiniteNumber(input.capturedAt) ? input.capturedAt : 0;

  return {
    lat,
    lng,
    accuracy,
    capturedAt,
    altitude: isFiniteNumber(input.altitude) ? input.altitude : null,
    altitudeAccuracy: isFiniteNumber(input.altitudeAccuracy) ? input.altitudeAccuracy : null,
    heading: isFiniteNumber(input.heading) ? input.heading : null,
    speed: isFiniteNumber(input.speed) ? input.speed : null,
  };
}

/**
 * Fastest plausible ground speed, in metres per second, used by the
 * impossible-travel check. ~250 km/h tolerates highway driving plus a sloppy
 * fix without admitting "clocked in 300 km away four minutes later".
 */
export const MAX_PLAUSIBLE_SPEED_MPS = 70;
