import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  db,
  COLLECTIONS,
  CALLABLE_OPTS,
  requireActiveUser,
  writeAudit,
  callerIp,
  requireString,
  optionalString,
  type Caller,
} from './common';
import { POLICY, FLAG, type FlagCode } from './config';
import { distanceMeters, parseLocation, MAX_PLAUSIBLE_SPEED_MPS } from './geo';
import { verifyPhoto } from './photo';
import { registerDevice, sanitiseDevice } from './device';
import type { ClockRequest, JobSiteDoc, PunchRecord, ShiftDoc } from './types';

/** Structured detail attached to a rejection so the UI can react precisely. */
interface RejectionDetail {
  reason: 'PHOTO_REQUIRED';
  flags: FlagCode[];
  distanceMeters: number | null;
  allowedRadiusMeters: number;
  accuracyMeters: number | null;
  jobSiteName: string;
}

async function loadJobSite(jobSiteId: string): Promise<JobSiteDoc> {
  const snap = await db.collection(COLLECTIONS.jobSites).doc(jobSiteId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'That job site does not exist.');
  const site = snap.data() as JobSiteDoc;
  if (!site.active) {
    throw new HttpsError('failed-precondition', `${site.name} is no longer an active job site.`);
  }
  return { ...site, id: snap.id };
}

/**
 * Builds a verified record of one punch.
 *
 * The rule the whole app rests on: a punch is only accepted on a trustworthy
 * GPS fix inside the site's geofence. Anything else — permission denied, a fix
 * too vague to mean anything, a stale replay, or standing outside the fence —
 * falls back to a freshly taken photo, and that punch is recorded but flagged
 * for an administrator to approve. Nothing is silently accepted, and nothing is
 * silently thrown away.
 */
async function buildPunch(
  caller: Caller,
  data: ClockRequest,
  request: CallableRequest,
  site: JobSiteDoc,
  serverNow: Date,
): Promise<PunchRecord> {
  const serverNowMs = serverNow.getTime();
  const flags: FlagCode[] = [];

  const device = sanitiseDevice(data.device);
  const deviceOutcome = await registerDevice(
    device?.id ?? null,
    caller.uid,
    device?.label ?? 'Unknown device',
    serverNowMs,
  );
  flags.push(...deviceOutcome.flags);

  if (
    device?.clientTime !== undefined &&
    Math.abs(serverNowMs - device.clientTime) > POLICY.maxClockSkewMs
  ) {
    // Not fatal — we always store the server time — but a device whose clock is
    // far off is worth a second look.
    flags.push(FLAG.CLOCK_SKEW);
  }

  const location = parseLocation(data.location);
  let distance: number | null = null;
  let withinGeofence: boolean | null = null;
  let gpsIsSufficient = false;

  if (location) {
    distance = distanceMeters(location, site);

    const fixAgeMs = serverNowMs - location.capturedAt;
    const fixIsFresh = location.capturedAt > 0 && fixAgeMs <= POLICY.maxFixAgeMs && fixAgeMs > -POLICY.maxClockSkewMs;
    const accuracyIsUsable = location.accuracy <= POLICY.maxAccuracyMeters;

    // Give the worker the benefit of their fix's own error bars, but cap how
    // much slack a claimed accuracy can buy.
    const slack = Math.min(location.accuracy, POLICY.maxAccuracySlackMeters);
    withinGeofence = distance <= site.radiusMeters + slack;

    if (!fixIsFresh) flags.push(FLAG.STALE_FIX);
    if (!accuracyIsUsable) flags.push(FLAG.LOW_ACCURACY);
    if (!withinGeofence) flags.push(FLAG.OUTSIDE_GEOFENCE);

    gpsIsSufficient = fixIsFresh && accuracyIsUsable && withinGeofence;
  }

  if (gpsIsSufficient && location) {
    return {
      at: Timestamp.fromDate(serverNow),
      method: 'gps',
      jobSiteId: site.id,
      jobSiteName: site.name,
      location: {
        lat: location.lat,
        lng: location.lng,
        accuracy: location.accuracy,
        capturedAt: Timestamp.fromMillis(location.capturedAt),
      },
      locationError: null,
      distanceMeters: Math.round(distance ?? 0),
      withinGeofence: true,
      photoPath: null,
      flags,
      ip: callerIp(request),
      device,
      note: optionalString(data.note),
    };
  }

  // --- GPS was not good enough: the photo path is the only way through -------
  if (!data.photoPath) {
    const detail: RejectionDetail = {
      reason: 'PHOTO_REQUIRED',
      flags,
      distanceMeters: distance === null ? null : Math.round(distance),
      allowedRadiusMeters: site.radiusMeters,
      accuracyMeters: location && Number.isFinite(location.accuracy)
        ? Math.round(location.accuracy)
        : null,
      jobSiteName: site.name,
    };
    throw new HttpsError('failed-precondition', photoRequiredMessage(flags, site.name), detail);
  }

  const photo = await verifyPhoto(caller.uid, data.photoPath, serverNowMs);
  flags.push(FLAG.PHOTO_FALLBACK);

  const rawError = data.locationError;
  return {
    at: Timestamp.fromDate(serverNow),
    method: 'photo',
    jobSiteId: site.id,
    jobSiteName: site.name,
    location: location
      ? {
          lat: location.lat,
          lng: location.lng,
          accuracy: Number.isFinite(location.accuracy) ? location.accuracy : -1,
          capturedAt: Timestamp.fromMillis(location.capturedAt || serverNowMs),
        }
      : null,
    locationError: rawError
      ? {
          code: typeof rawError.code === 'number' ? rawError.code : null,
          message: optionalString(rawError.message, 200),
        }
      : null,
    distanceMeters: distance === null ? null : Math.round(distance),
    withinGeofence,
    photoPath: photo.path,
    flags,
    ip: callerIp(request),
    device,
    note: optionalString(data.note),
  };
}

function photoRequiredMessage(flags: FlagCode[], siteName: string): string {
  if (flags.includes(FLAG.OUTSIDE_GEOFENCE)) {
    return `You appear to be outside the boundary for ${siteName}. Move closer and try again, or take a photo at the job site to submit for approval.`;
  }
  if (flags.includes(FLAG.LOW_ACCURACY)) {
    return 'Your location is not precise enough to confirm you are on site. Step outside for a better signal, or take a photo at the job site to submit for approval.';
  }
  if (flags.includes(FLAG.STALE_FIX)) {
    return 'Your location reading was out of date. Try again, or take a photo at the job site to submit for approval.';
  }
  return 'Location services are unavailable, so we cannot confirm you are on site. Take a photo at the job site to submit for approval.';
}

/**
 * Flags a punch that could not physically follow the previous one.
 * Catches the "my mate clocked me in from across the county" case.
 */
async function checkImpossibleTravel(
  uid: string,
  punch: PunchRecord,
  serverNowMs: number,
): Promise<FlagCode[]> {
  if (!punch.location) return [];

  const recent = await db
    .collection(COLLECTIONS.shifts)
    .where('userId', '==', uid)
    .orderBy('clockInAt', 'desc')
    .limit(1)
    .get();

  if (recent.empty) return [];

  const prev = recent.docs[0].data() as ShiftDoc;
  const prevPunch = prev.clockOut ?? prev.clockIn;
  if (!prevPunch?.location) return [];

  const elapsedSeconds = (serverNowMs - prevPunch.at.toMillis()) / 1000;
  if (elapsedSeconds <= 0) return [];

  const metres = distanceMeters(punch.location, prevPunch.location);
  // Below a few hundred metres this is just GPS noise, not travel.
  if (metres < 500) return [];

  const speed = metres / elapsedSeconds;
  return speed > MAX_PLAUSIBLE_SPEED_MPS ? [FLAG.IMPOSSIBLE_TRAVEL] : [];
}

/** Rejects double-taps and rapid-fire scripted calls. */
async function assertNotTooSoon(uid: string, serverNowMs: number): Promise<void> {
  const recent = await db
    .collection(COLLECTIONS.shifts)
    .where('userId', '==', uid)
    .orderBy('clockInAt', 'desc')
    .limit(1)
    .get();

  if (recent.empty) return;
  const prev = recent.docs[0].data() as ShiftDoc;
  const lastAt = (prev.clockOut ?? prev.clockIn).at.toMillis();
  const gapSeconds = (serverNowMs - lastAt) / 1000;

  if (gapSeconds >= 0 && gapSeconds < POLICY.minSecondsBetweenActions) {
    throw new HttpsError(
      'resource-exhausted',
      `Please wait ${Math.ceil(POLICY.minSecondsBetweenActions - gapSeconds)} more seconds.`,
    );
  }
}

export const clockIn = onCall(CALLABLE_OPTS, async (request) => {
  const caller = await requireActiveUser(request);
  const data = (request.data ?? {}) as ClockRequest;
  const jobSiteId = requireString(data.jobSiteId, 'Job site', 128);

  if (caller.user.jobSiteIds?.length && !caller.user.jobSiteIds.includes(jobSiteId)) {
    throw new HttpsError('permission-denied', 'You are not assigned to that job site.');
  }

  const openShift = await db
    .collection(COLLECTIONS.shifts)
    .where('userId', '==', caller.uid)
    .where('status', '==', 'open')
    .limit(1)
    .get();

  if (!openShift.empty) {
    const open = openShift.docs[0].data() as ShiftDoc;
    throw new HttpsError(
      'failed-precondition',
      `You are already clocked in at ${open.jobSiteName}. Clock out first.`,
    );
  }

  const serverNow = new Date();
  await assertNotTooSoon(caller.uid, serverNow.getTime());

  const site = await loadJobSite(jobSiteId);
  const punch = await buildPunch(caller, data, request, site, serverNow);
  punch.flags.push(...(await checkImpossibleTravel(caller.uid, punch, serverNow.getTime())));

  const needsReview = punch.flags.length > 0;
  const ref = db.collection(COLLECTIONS.shifts).doc();

  const shift = {
    id: ref.id,
    userId: caller.uid,
    userDisplayName: caller.user.displayName,
    userEmail: caller.user.email,
    jobSiteId: site.id,
    jobSiteName: site.name,
    status: 'open' as const,
    clockIn: punch,
    clockOut: null,
    clockInAt: punch.at,
    clockOutAt: null,
    durationMinutes: null,
    needsReview,
    flags: punch.flags,
    review: {
      status: needsReview ? ('pending' as const) : ('approved' as const),
      by: null,
      at: null,
      note: null,
    },
    pendingEdit: null,
    hasPendingEdit: false,
    lastEdit: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  // create() rather than set(): if two taps race, the second gets a clean
  // failure instead of overwriting the first.
  await ref.create(shift);

  await writeAudit({
    action: 'shift.clock_in',
    actorUid: caller.uid,
    actorEmail: caller.email,
    targetUserId: caller.uid,
    targetId: ref.id,
    ip: punch.ip,
    details: {
      jobSiteId: site.id,
      method: punch.method,
      distanceMeters: punch.distanceMeters,
      flags: punch.flags,
    },
  });

  return {
    shiftId: ref.id,
    at: punch.at.toMillis(),
    method: punch.method,
    jobSiteName: site.name,
    distanceMeters: punch.distanceMeters,
    needsReview,
    flags: punch.flags,
  };
});

export const clockOut = onCall(CALLABLE_OPTS, async (request) => {
  const caller = await requireActiveUser(request);
  const data = (request.data ?? {}) as ClockRequest;

  const openShifts = await db
    .collection(COLLECTIONS.shifts)
    .where('userId', '==', caller.uid)
    .where('status', '==', 'open')
    .limit(1)
    .get();

  if (openShifts.empty) {
    throw new HttpsError('failed-precondition', 'You are not currently clocked in.');
  }

  const shiftRef = openShifts.docs[0].ref;
  const shift = openShifts.docs[0].data() as ShiftDoc;

  const serverNow = new Date();
  await assertNotTooSoon(caller.uid, serverNow.getTime());

  // Clock out against the site the shift was opened at, not whatever the client
  // sends, so the pair can never straddle two sites.
  const site = await loadJobSite(shift.jobSiteId).catch(() => null);
  if (!site) {
    throw new HttpsError(
      'failed-precondition',
      'The job site for your open shift is no longer active. Ask an administrator to close the shift.',
    );
  }

  const punch = await buildPunch(caller, { ...data, jobSiteId: site.id }, request, site, serverNow);
  punch.flags.push(...(await checkImpossibleTravel(caller.uid, punch, serverNow.getTime())));

  const durationMinutes = Math.max(
    0,
    Math.round((punch.at.toMillis() - shift.clockInAt.toMillis()) / 60000),
  );

  const combinedFlags = Array.from(new Set([...(shift.flags ?? []), ...punch.flags]));
  const needsReview = combinedFlags.length > 0;

  await shiftRef.update({
    status: 'closed',
    clockOut: punch,
    clockOutAt: punch.at,
    durationMinutes,
    flags: combinedFlags,
    needsReview,
    'review.status': needsReview ? 'pending' : 'approved',
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAudit({
    action: 'shift.clock_out',
    actorUid: caller.uid,
    actorEmail: caller.email,
    targetUserId: caller.uid,
    targetId: shiftRef.id,
    ip: punch.ip,
    details: {
      jobSiteId: site.id,
      method: punch.method,
      distanceMeters: punch.distanceMeters,
      durationMinutes,
      flags: punch.flags,
    },
  });

  return {
    shiftId: shiftRef.id,
    at: punch.at.toMillis(),
    method: punch.method,
    durationMinutes,
    needsReview,
    flags: combinedFlags,
  };
});
