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
  OUTSIDE_HOURS: 'Clocked in outside the site\u2019s hours',
  LATE_CLOCK_OUT: 'Clocked out after the site\u2019s hours',
};

// --- Site hours -------------------------------------------------------------

/**
 * A job site can carry the hours it runs — "07:00" to "17:30".
 *
 * These record and flag. They do not block, and that is a deliberate legal
 * position rather than an unfinished feature. Under the FLSA and California
 * Labor Code an employer has to pay for all hours it suffers or permits to be
 * worked, whether or not the worker was scheduled for them. Refusing a clock-in
 * does not stop somebody working — it stops the work being *recorded*, which is
 * how an off-the-clock claim starts. Automatically punching somebody out at a
 * set time is the same problem wearing a different hat, and is close kin to the
 * automatic meal deduction that California courts have repeatedly thrown out.
 *
 * So: the real minute is always what gets stored, unauthorised hours are
 * flagged for a supervisor to deal with as a management matter, and the app
 * never quietly edits somebody's day. See README.md, "Site hours".
 */
export function parseTimeOfDay(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** "07:00" → "7:00 AM", for text a worker reads. */
export function fmtTimeOfDay(value: string | null | undefined): string {
  const total = parseTimeOfDay(value);
  if (total == null) return '';
  const date = new Date();
  date.setHours(Math.floor(total / 60), total % 60, 0, 0);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export type HoursVerdict = 'none' | 'inside' | 'before' | 'after' | 'outside';

interface SiteHours {
  shiftStart?: string | null;
  shiftEnd?: string | null;
}

/** Where a moment falls against a site's hours. 'none' when it keeps none. */
export function hoursVerdict(site: SiteHours, at: Date = new Date()): HoursVerdict {
  const start = parseTimeOfDay(site.shiftStart);
  const end = parseTimeOfDay(site.shiftEnd);
  if (start == null && end == null) return 'none';

  const minute = at.getHours() * 60 + at.getMinutes();

  // A window that ends before it starts is an overnight one — 22:00 to 06:00.
  // There is no meaningful "before" or "after" in that case, only in or out.
  if (start != null && end != null && end < start) {
    return minute >= start || minute <= end ? 'inside' : 'outside';
  }
  if (start != null && minute < start) return 'before';
  if (end != null && minute > end) return 'after';
  return 'inside';
}

/** The site's hours as one readable span, or '' when it keeps none. */
export function describeHours(site: SiteHours): string {
  const start = fmtTimeOfDay(site.shiftStart);
  const end = fmtTimeOfDay(site.shiftEnd);
  if (start && end) return `${start}–${end}`;
  if (start) return `from ${start}`;
  if (end) return `until ${end}`;
  return '';
}

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
