import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
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
import { POLICY, FLAG } from './config';
import type { ShiftDoc } from './types';

/** Approve or reject a flagged shift. */
export const reviewShift = onCall(CALLABLE_OPTS, async (request) => {
  const caller = await requireAdmin(request);
  const shiftId = requireString(request.data?.shiftId, 'Shift id', 128);
  const decision = request.data?.decision;

  if (decision !== 'approved' && decision !== 'rejected') {
    throw new HttpsError('invalid-argument', 'Decision must be "approved" or "rejected".');
  }

  const note = optionalString(request.data?.note, 500);
  if (decision === 'rejected' && !note) {
    throw new HttpsError('invalid-argument', 'Please explain why the shift is being rejected.');
  }

  const ref = db.collection(COLLECTIONS.shifts).doc(shiftId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That shift no longer exists.');

  const shift = snap.data() as ShiftDoc;
  if (shift.status === 'open') {
    throw new HttpsError('failed-precondition', 'This shift is still open. Close it first.');
  }

  await ref.update({
    needsReview: false,
    review: {
      status: decision,
      by: caller.uid,
      at: Timestamp.now(),
      note,
    },
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAudit({
    action: 'shift.review',
    actorUid: caller.uid,
    actorEmail: caller.email,
    targetUserId: shift.userId,
    targetId: shiftId,
    ip: callerIp(request),
    details: { decision, note, flags: shift.flags },
  });

  return { ok: true };
});

/**
 * Administrative correction of a shift's times.
 *
 * Deliberately narrow: an admin can fix the clock, nothing else. The original
 * punch records — location, photo, device, IP — stay exactly as captured, and
 * every edit lands in the audit log with the before-and-after values.
 */
export const adjustShift = onCall(CALLABLE_OPTS, async (request) => {
  const caller = await requireAdmin(request);
  const shiftId = requireString(request.data?.shiftId, 'Shift id', 128);
  const note = requireString(request.data?.note, 'Reason', 500);

  const ref = db.collection(COLLECTIONS.shifts).doc(shiftId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That shift no longer exists.');
  const shift = snap.data() as ShiftDoc;

  const parseTime = (value: unknown, field: string): number | null => {
    if (value === undefined || value === null) return null;
    const ms = typeof value === 'number' ? value : Date.parse(String(value));
    if (!Number.isFinite(ms)) {
      throw new HttpsError('invalid-argument', `${field} is not a valid time.`);
    }
    return ms;
  };

  const newInMs = parseTime(request.data?.clockInAt, 'Clock-in time');
  const newOutMs = parseTime(request.data?.clockOutAt, 'Clock-out time');

  const finalInMs = newInMs ?? shift.clockInAt.toMillis();
  const finalOutMs = newOutMs ?? (shift.clockOutAt ? shift.clockOutAt.toMillis() : null);

  if (finalOutMs !== null && finalOutMs <= finalInMs) {
    throw new HttpsError('invalid-argument', 'Clock-out must be after clock-in.');
  }
  if (finalInMs > Date.now() + 60_000) {
    throw new HttpsError('invalid-argument', 'Clock-in cannot be in the future.');
  }
  if (finalOutMs !== null && finalOutMs - finalInMs > POLICY.maxShiftHours * 3600 * 1000) {
    throw new HttpsError(
      'invalid-argument',
      `A shift cannot be longer than ${POLICY.maxShiftHours} hours.`,
    );
  }

  const flags = Array.from(new Set([...(shift.flags ?? []), FLAG.MANUAL_ENTRY]));

  await ref.update({
    clockInAt: Timestamp.fromMillis(finalInMs),
    'clockIn.at': Timestamp.fromMillis(finalInMs),
    ...(finalOutMs !== null
      ? {
          clockOutAt: Timestamp.fromMillis(finalOutMs),
          ...(shift.clockOut ? { 'clockOut.at': Timestamp.fromMillis(finalOutMs) } : {}),
          durationMinutes: Math.round((finalOutMs - finalInMs) / 60000),
          status: 'closed',
        }
      : {}),
    flags,
    needsReview: false,
    review: { status: 'approved', by: caller.uid, at: Timestamp.now(), note },
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAudit({
    action: 'shift.manual_edit',
    actorUid: caller.uid,
    actorEmail: caller.email,
    targetUserId: shift.userId,
    targetId: shiftId,
    ip: callerIp(request),
    details: {
      note,
      before: {
        clockInAt: shift.clockInAt.toMillis(),
        clockOutAt: shift.clockOutAt ? shift.clockOutAt.toMillis() : null,
        durationMinutes: shift.durationMinutes,
      },
      after: {
        clockInAt: finalInMs,
        clockOutAt: finalOutMs,
      },
    },
  });

  return { ok: true };
});

/**
 * Nightly sweep that closes shifts someone forgot to clock out of.
 *
 * Left open, a forgotten shift blocks the worker's next clock-in and silently
 * inflates hours. Auto-closing at the clock-in time (zero duration) and flagging
 * for review puts it in front of an admin instead of guessing at the hours.
 */
export const autoCloseStaleShifts = onSchedule(
  {
    schedule: 'every day 03:00',
    timeZone: process.env.SCHEDULE_TIMEZONE || 'Etc/UTC',
    region: process.env.FUNCTIONS_REGION || 'us-central1',
  },
  async () => {
    const cutoff = Timestamp.fromMillis(Date.now() - POLICY.maxShiftHours * 3600 * 1000);

    const stale = await db
      .collection(COLLECTIONS.shifts)
      .where('status', '==', 'open')
      .where('clockInAt', '<', cutoff)
      .limit(400)
      .get();

    if (stale.empty) {
      logger.info('No stale shifts to close');
      return;
    }

    const batch = db.batch();
    for (const doc of stale.docs) {
      const shift = doc.data() as ShiftDoc;
      batch.update(doc.ref, {
        status: 'closed',
        clockOutAt: shift.clockInAt,
        durationMinutes: 0,
        flags: Array.from(new Set([...(shift.flags ?? []), FLAG.AUTO_CLOSED])),
        needsReview: true,
        'review.status': 'pending',
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();

    for (const doc of stale.docs) {
      const shift = doc.data() as ShiftDoc;
      await writeAudit({
        action: 'shift.auto_close',
        actorUid: null,
        actorEmail: null,
        targetUserId: shift.userId,
        targetId: doc.id,
        details: { reason: `open longer than ${POLICY.maxShiftHours}h` },
      });
    }

    logger.info(`Auto-closed ${stale.size} stale shift(s)`);
  },
);
