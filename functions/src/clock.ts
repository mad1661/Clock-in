import { createHash } from 'node:crypto';
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

  // A punch captured with no signal is replayed from the phone later, so its
  // GPS fix and its timestamp are both older than "now" through no fault of the
  // worker. `effectiveNowMs` is the moment the punch claims to have happened,
  // and every freshness check below is measured against it rather than against
  // the clock on this server.
  //
  // This is the one place the app trusts a client clock. It is bounded (24h),
  // it cannot be in the future, and it always lands in the review queue — the
  // alternative was losing a day's hours whenever a crew works somewhere with
  // no bars, which is most of what this app is for.
  const offline = parseOfflineCapture(data.offlineCapturedAt, serverNowMs);
  const effectiveNowMs = offline ? offline.capturedAtMs : serverNowMs;
  if (offline) flags.push(FLAG.OFFLINE_SYNCED);

  const device = sanitiseDevice(data.device);
  const deviceOutcome = await registerDevice(
    device?.id ?? null,
    caller.uid,
    device?.label ?? 'Unknown device',
    serverNowMs,
  );
  flags.push(...deviceOutcome.flags);

  if (
    !offline &&
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

    const fixAgeMs = effectiveNowMs - location.capturedAt;
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

  const punchAt = offline
    ? Timestamp.fromMillis(offline.capturedAtMs)
    : Timestamp.fromDate(serverNow);
  const offlineRecord = offline
    ? {
        capturedAt: Timestamp.fromMillis(offline.capturedAtMs),
        syncedAt: Timestamp.fromDate(serverNow),
        delayMinutes: Math.round((serverNowMs - offline.capturedAtMs) / 60000),
      }
    : null;

  if (gpsIsSufficient && location) {
    return {
      at: punchAt,
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
      offline: offlineRecord,
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
    at: punchAt,
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
    offline: offlineRecord,
  };
}

const PUNCH_CLAIMS = 'punchClaims';

/** The moment a punch claims to have happened — capture time when offline. */
function effectiveNow(offlineCapturedAt: unknown, serverNowMs: number): number {
  return parseOfflineCapture(offlineCapturedAt, serverNowMs)?.capturedAtMs ?? serverNowMs;
}

/**
 * Burns a client-generated request id so a retried sync cannot punch twice.
 *
 * The failure mode this exists for is mundane and certain: the phone submits a
 * queued punch, the response is lost on a flaky connection, and the queue
 * retries. Without this the worker gets two shifts and a phone call from
 * payroll.
 */
async function claimRequestId(uid: string, clientRequestId: string | null | undefined) {
  if (typeof clientRequestId !== 'string' || !/^[a-zA-Z0-9._-]{8,64}$/.test(clientRequestId)) {
    return null;
  }
  const id = createHash('sha256').update(`${uid}:${clientRequestId}`).digest('hex');
  const ref = db.collection(PUNCH_CLAIMS).doc(id);
  try {
    await ref.create({ uid, clientRequestId, claimedAt: FieldValue.serverTimestamp() });
    return ref;
  } catch (err: unknown) {
    if ((err as { code?: number })?.code === 6) {
      const existing = await ref.get();
      throw new HttpsError(
        'already-exists',
        'That punch was already recorded.',
        { reason: 'ALREADY_SUBMITTED', shiftId: existing.data()?.shiftId ?? null },
      );
    }
    throw err;
  }
}

/**
 * Validates a claimed offline capture time, or returns null for a live punch.
 *
 * Rejects rather than flags, because a timestamp outside these bounds is not a
 * judgement call a supervisor could sensibly make — it is either a broken clock
 * or someone trying it on.
 */
function parseOfflineCapture(
  raw: unknown,
  serverNowMs: number,
): { capturedAtMs: number } | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new HttpsError('invalid-argument', 'The saved punch has an unreadable timestamp.');
  }
  if (raw > serverNowMs + POLICY.maxClockSkewMs) {
    throw new HttpsError('invalid-argument', 'That saved punch is dated in the future.');
  }
  if (serverNowMs - raw > POLICY.maxOfflineAgeMs) {
    throw new HttpsError(
      'failed-precondition',
      'That saved punch is more than a day old. Ask your supervisor to add the hours by hand.',
    );
  }
  return { capturedAtMs: raw };
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
  effectiveNowMs: number,
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

  const elapsedSeconds = (effectiveNowMs - prevPunch.at.toMillis()) / 1000;
  if (elapsedSeconds <= 0) return [];

  const metres = distanceMeters(punch.location, prevPunch.location);
  // Below a few hundred metres this is just GPS noise, not travel.
  if (metres < 500) return [];

  const speed = metres / elapsedSeconds;
  return speed > MAX_PLAUSIBLE_SPEED_MPS ? [FLAG.IMPOSSIBLE_TRAVEL] : [];
}

/** Rejects double-taps and rapid-fire scripted calls. */
async function assertNotTooSoon(uid: string, effectiveNowMs: number): Promise<void> {
  const recent = await db
    .collection(COLLECTIONS.shifts)
    .where('userId', '==', uid)
    .orderBy('clockInAt', 'desc')
    .limit(1)
    .get();

  if (recent.empty) return;
  const prev = recent.docs[0].data() as ShiftDoc;
  const lastAt = (prev.clockOut ?? prev.clockIn).at.toMillis();
  const gapSeconds = (effectiveNowMs - lastAt) / 1000;

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

  const serverNow = new Date();
  const effectiveNowMs = effectiveNow(data.offlineCapturedAt, serverNow.getTime());

  // Before anything else: if this exact request already succeeded, say so
  // plainly. A phone that submitted, lost signal before hearing back, and
  // retried must get an answer its queue can act on — not "you are already
  // clocked in", which is true but tells it nothing about what to do.
  const claim = await claimRequestId(caller.uid, data.clientRequestId);

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

  await assertNotTooSoon(caller.uid, effectiveNowMs);
  const site = await loadJobSite(jobSiteId);
  const punch = await buildPunch(caller, data, request, site, serverNow);
  punch.flags.push(...(await checkImpossibleTravel(caller.uid, punch, effectiveNowMs)));

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
  await claim?.update({ shiftId: ref.id }).catch(() => undefined);

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

  const serverNow = new Date();
  const effectiveNowMs = effectiveNow(data.offlineCapturedAt, serverNow.getTime());

  // Same reasoning as clockIn: answer a replayed request id before any state
  // check can turn it into a different, unactionable error.
  const claim = await claimRequestId(caller.uid, data.clientRequestId);

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

  await assertNotTooSoon(caller.uid, effectiveNowMs);

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
  punch.flags.push(...(await checkImpossibleTravel(caller.uid, punch, effectiveNowMs)));

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
  await claim?.update({ shiftId: shiftRef.id }).catch(() => undefined);

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
