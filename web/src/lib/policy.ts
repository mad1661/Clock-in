/**
 * Mirror of functions/src/config.ts.
 *
 * These values exist only so the clock screen can tell a worker "you are 300 m
 * away" before they tap the button. The server re-checks every one of them and
 * its answer is the only one that counts — changing anything here changes the
 * hint text, not what gets accepted.
 */
export const POLICY = {
  maxAccuracyMeters: 150,
  maxFixAgeMs: 2 * 60 * 1000,
  maxAccuracySlackMeters: 75,
} as const;

/**
 * Every flag the app can actually produce, and nothing it cannot.
 *
 * Flags that needed a server to detect — impossible travel between punches, the
 * same handset used by two workers — are deliberately absent rather than left
 * here looking supported. See README.md, "What this cannot do".
 */
export const FLAG_LABELS: Record<string, string> = {
  OUTSIDE_GEOFENCE: 'Outside the site boundary',
  LOW_ACCURACY: 'Location too imprecise',
  STALE_FIX: 'Location reading was out of date',
  NO_LOCATION_PROOF: 'Location could not be confirmed',
  FORCE_CLOSED: 'Closed by an administrator — never clocked out',
  MANUAL_ENTRY: 'Times set by an administrator',
  WORKER_EDITED: 'Times corrected at the worker\u2019s request',
};

const EARTH_RADIUS_METERS = 6371008.8;

export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}
