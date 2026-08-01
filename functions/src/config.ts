/**
 * Tunable policy for location verification.
 *
 * Everything here is enforced SERVER-SIDE. The web client uses the same numbers
 * (mirrored in web/src/lib/policy.ts) purely to give the worker useful feedback
 * before they submit — never as the decision itself.
 */
export const POLICY = {
  /**
   * A GPS fix reporting an accuracy radius worse than this is not trustworthy
   * enough to prove presence. 150 m comfortably admits a normal phone fix
   * outdoors (5-30 m) and typical wifi positioning (20-80 m), while rejecting
   * IP-geolocation-grade guesses (often 1-50 km) that a laptop would return.
   */
  maxAccuracyMeters: 150,

  /**
   * How stale a fix may be when it reaches the server. Blocks a worker from
   * capturing a fix at the job site in the morning and replaying it later.
   */
  maxFixAgeMs: 2 * 60 * 1000,

  /**
   * Allowance added to a site's radius to account for the reported accuracy of
   * the fix, so a worker genuinely standing on site with a mediocre fix is not
   * punished. We never grant more than this cap, otherwise a client could claim
   * a 10 km accuracy radius to "reach" any site.
   */
  maxAccuracySlackMeters: 75,

  /** Default geofence radius applied to a new job site. */
  defaultSiteRadiusMeters: 150,

  /** Hard bounds an admin may configure for a site radius. */
  minSiteRadiusMeters: 25,
  maxSiteRadiusMeters: 2000,

  /**
   * A fallback photo must have landed in Cloud Storage within this window
   * before the clock action referencing it. Checked against the object's
   * server-assigned creation time, which the client cannot influence.
   */
  maxPhotoAgeMs: 5 * 60 * 1000,

  /** Maximum accepted photo size, mirrored in storage.rules. */
  maxPhotoBytes: 8 * 1024 * 1024,

  /**
   * If the client clock differs from the server clock by more than this, we
   * flag it. All stored timestamps use the server clock regardless.
   */
  maxClockSkewMs: 5 * 60 * 1000,

  /**
   * Reject a second clock action from the same user inside this window.
   * Overridable so the emulator test suite does not have to sleep between
   * punches; see functions/.env.local.
   */
  minSecondsBetweenActions: Number(process.env.MIN_SECONDS_BETWEEN_ACTIONS ?? 30),

  /** A shift left open longer than this is auto-closed by the nightly sweep. */
  maxShiftHours: 16,

  /**
   * Two different employees punching from the same handset inside this window
   * is flagged for review. Sharing a phone is not automatically dishonest — a
   * crew lead may clock in someone whose battery died — so it is surfaced, not
   * refused.
   */
  sharedDeviceWindowHours: 12,

  /**
   * How far back a worker may ask to correct their own timesheet. Long enough
   * to cover "I forgot to clock out on Friday", short enough that a closed
   * payroll period is not reopened.
   */
  maxEditRequestAgeDays: 14,
} as const;

/** Reasons a shift can be flagged for admin review. */
export const FLAG = {
  PHOTO_FALLBACK: 'PHOTO_FALLBACK',
  OUTSIDE_GEOFENCE: 'OUTSIDE_GEOFENCE',
  LOW_ACCURACY: 'LOW_ACCURACY',
  STALE_FIX: 'STALE_FIX',
  CLOCK_SKEW: 'CLOCK_SKEW',
  AUTO_CLOSED: 'AUTO_CLOSED',
  MANUAL_ENTRY: 'MANUAL_ENTRY',
  IMPOSSIBLE_TRAVEL: 'IMPOSSIBLE_TRAVEL',
  SHARED_DEVICE: 'SHARED_DEVICE',
  WORKER_EDITED: 'WORKER_EDITED',
} as const;

export type FlagCode = (typeof FLAG)[keyof typeof FLAG];
