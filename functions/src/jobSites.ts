import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import {
  db,
  COLLECTIONS,
  CALLABLE_OPTS,
  requireAdmin,
  writeAudit,
  callerIp,
  requireString,
  optionalString,
} from './common';
import { assertValidLatLng, isFiniteNumber } from './geo';
import { POLICY } from './config';

/** Creates a job site, or updates it when `id` is supplied. */
export const upsertJobSite = onCall(CALLABLE_OPTS, async (request) => {
  const caller = await requireAdmin(request);

  const name = requireString(request.data?.name, 'Site name', 120);
  const address = optionalString(request.data?.address, 250) ?? '';
  const { lat, lng } = assertValidLatLng(request.data?.lat, request.data?.lng);

  const rawRadius = request.data?.radiusMeters;
  const radiusMeters = isFiniteNumber(rawRadius)
    ? Math.round(rawRadius)
    : POLICY.defaultSiteRadiusMeters;

  if (radiusMeters < POLICY.minSiteRadiusMeters || radiusMeters > POLICY.maxSiteRadiusMeters) {
    throw new HttpsError(
      'invalid-argument',
      `Radius must be between ${POLICY.minSiteRadiusMeters} and ${POLICY.maxSiteRadiusMeters} metres.`,
    );
  }

  const active = request.data?.active !== false;
  const id = typeof request.data?.id === 'string' && request.data.id.trim().length > 0
    ? request.data.id.trim()
    : null;

  const ref = id
    ? db.collection(COLLECTIONS.jobSites).doc(id)
    : db.collection(COLLECTIONS.jobSites).doc();

  const now = FieldValue.serverTimestamp();
  const payload = {
    id: ref.id,
    name,
    address,
    lat,
    lng,
    radiusMeters,
    active,
    updatedAt: now,
    ...(id ? {} : { createdAt: now }),
  };

  await ref.set(payload, { merge: true });

  await writeAudit({
    action: 'jobsite.upsert',
    actorUid: caller.uid,
    actorEmail: caller.email,
    targetId: ref.id,
    ip: callerIp(request),
    details: { name, lat, lng, radiusMeters, active, created: !id },
  });

  return { id: ref.id };
});

/**
 * Retires a job site.
 *
 * Deactivates rather than deletes: historic shifts reference the site, and a
 * payroll record that points at a missing document is worse than a stale one.
 */
export const deleteJobSite = onCall(CALLABLE_OPTS, async (request) => {
  const caller = await requireAdmin(request);
  const id = requireString(request.data?.id, 'Site id', 128);

  const ref = db.collection(COLLECTIONS.jobSites).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That job site no longer exists.');

  const openShifts = await db
    .collection(COLLECTIONS.shifts)
    .where('jobSiteId', '==', id)
    .where('status', '==', 'open')
    .limit(1)
    .get();

  if (!openShifts.empty) {
    throw new HttpsError(
      'failed-precondition',
      'Someone is still clocked in at this site. Close their shift first.',
    );
  }

  await ref.update({ active: false, updatedAt: FieldValue.serverTimestamp() });

  await writeAudit({
    action: 'jobsite.delete',
    actorUid: caller.uid,
    actorEmail: caller.email,
    targetId: id,
    ip: callerIp(request),
  });

  return { ok: true };
});
