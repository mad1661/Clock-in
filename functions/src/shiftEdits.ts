import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  db,
  COLLECTIONS,
  CALLABLE_OPTS,
  requireActiveUser,
  requireAdmin,
  writeAudit,
  callerIp,
  requireString,
  optionalString,
} from './common';
import { POLICY, FLAG } from './config';
import type { ShiftDoc } from './types';

/**
 * Worker-initiated timesheet corrections.
 *
 * A worker can propose new times on their own shift and say why; nothing
 * changes until a supervisor approves it. Both the original and the proposal
 * are held on the shift while it is pending, so the reviewer always sees what
 * is actually being asked for, and the captured evidence — location, photo,
 * device, IP — is never touched by an edit.
 *
 * The alternative, letting workers edit their own hours directly, would make
 * every other check in this app pointless.
 */

function parseTime(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) {
    throw new HttpsError('invalid-argument', `${field} is not a valid time.`);
  }
  return ms;
}

async function loadOwnShift(shiftId: string, uid: string) {
  const ref = db.collection(COLLECTIONS.shifts).doc(shiftId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That shift no longer exists.');
  const shift = snap.data() as ShiftDoc;
  if (shift.userId !== uid) {
    throw new HttpsError('permission-denied', 'That is not your shift.');
  }
  return { ref, shift };
}

/** A worker proposes corrected times on one of their own shifts. */
export const requestShiftEdit = onCall(CALLABLE_OPTS, async (request) => {
  const caller = await requireActiveUser(request);
  const shiftId = requireString(request.data?.shiftId, 'Shift id', 128);
  const reason = requireString(request.data?.reason, 'Reason', 500);

  const { ref, shift } = await loadOwnShift(shiftId, caller.uid);

  if (shift.status === 'open') {
    throw new HttpsError(
      'failed-precondition',
      'You are still clocked in on this shift. Clock out first, then request a change.',
    );
  }
  if (shift.hasPendingEdit) {
    throw new HttpsError(
      'failed-precondition',
      'You already have a change waiting on your supervisor for this shift.',
    );
  }

  const ageDays = (Date.now() - shift.clockInAt.toMillis()) / 86400000;
  if (ageDays > POLICY.maxEditRequestAgeDays) {
    throw new HttpsError(
      'failed-precondition',
      `Shifts can only be corrected within ${POLICY.maxEditRequestAgeDays} days. Ask your supervisor to adjust this one.`,
    );
  }

  const originalInMs = shift.clockInAt.toMillis();
  const originalOutMs = shift.clockOutAt ? shift.clockOutAt.toMillis() : null;

  const requestedInMs = parseTime(request.data?.clockInAt, 'Start time') ?? originalInMs;
  const requestedOutMs = parseTime(request.data?.clockOutAt, 'Finish time') ?? originalOutMs;

  if (requestedInMs === originalInMs && requestedOutMs === originalOutMs) {
    throw new HttpsError('invalid-argument', 'Change a time before submitting the request.');
  }
  if (requestedOutMs !== null && requestedOutMs <= requestedInMs) {
    throw new HttpsError('invalid-argument', 'Your finish time must be after your start time.');
  }
  if (requestedInMs > Date.now() + 60_000) {
    throw new HttpsError('invalid-argument', 'Your start time cannot be in the future.');
  }
  if (requestedOutMs !== null && requestedOutMs > Date.now() + 60_000) {
    throw new HttpsError('invalid-argument', 'Your finish time cannot be in the future.');
  }
  if (
    requestedOutMs !== null &&
    requestedOutMs - requestedInMs > POLICY.maxShiftHours * 3600 * 1000
  ) {
    throw new HttpsError(
      'invalid-argument',
      `A shift cannot be longer than ${POLICY.maxShiftHours} hours. Ask your supervisor if that is right.`,
    );
  }

  await ref.update({
    hasPendingEdit: true,
    pendingEdit: {
      requestedAt: Timestamp.now(),
      requestedClockInAt: Timestamp.fromMillis(requestedInMs),
      requestedClockOutAt:
        requestedOutMs === null ? null : Timestamp.fromMillis(requestedOutMs),
      originalClockInAt: shift.clockInAt,
      originalClockOutAt: shift.clockOutAt,
      reason,
    },
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAudit({
    action: 'shift.edit_requested',
    actorUid: caller.uid,
    actorEmail: caller.email,
    targetUserId: caller.uid,
    targetId: shiftId,
    ip: callerIp(request),
    details: {
      reason,
      original: { clockInAt: originalInMs, clockOutAt: originalOutMs },
      requested: { clockInAt: requestedInMs, clockOutAt: requestedOutMs },
    },
  });

  return { ok: true };
});

/** A worker withdraws their own pending request. */
export const cancelShiftEdit = onCall(CALLABLE_OPTS, async (request) => {
  const caller = await requireActiveUser(request);
  const shiftId = requireString(request.data?.shiftId, 'Shift id', 128);

  const { ref, shift } = await loadOwnShift(shiftId, caller.uid);
  if (!shift.hasPendingEdit || !shift.pendingEdit) {
    throw new HttpsError('failed-precondition', 'There is no pending change on this shift.');
  }

  await ref.update({
    hasPendingEdit: false,
    pendingEdit: null,
    lastEdit: {
      status: 'withdrawn',
      reason: shift.pendingEdit.reason,
      note: null,
      decidedBy: caller.uid,
      decidedAt: Timestamp.now(),
      appliedClockInAt: null,
      appliedClockOutAt: null,
    },
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAudit({
    action: 'shift.edit_withdrawn',
    actorUid: caller.uid,
    actorEmail: caller.email,
    targetUserId: caller.uid,
    targetId: shiftId,
    ip: callerIp(request),
  });

  return { ok: true };
});

/**
 * A supervisor rules on a worker's requested correction.
 *
 * Approving applies the proposed times and marks the shift as worker-edited, so
 * the change is visible on the timesheet forever rather than quietly blending
 * into the captured record.
 */
export const reviewShiftEdit = onCall(CALLABLE_OPTS, async (request) => {
  const caller = await requireAdmin(request);
  const shiftId = requireString(request.data?.shiftId, 'Shift id', 128);
  const decision = request.data?.decision;

  if (decision !== 'approved' && decision !== 'rejected') {
    throw new HttpsError('invalid-argument', 'Decision must be "approved" or "rejected".');
  }

  const note = optionalString(request.data?.note, 500);
  if (decision === 'rejected' && !note) {
    throw new HttpsError(
      'invalid-argument',
      'Explain why the change is being turned down — the worker sees this.',
    );
  }

  const ref = db.collection(COLLECTIONS.shifts).doc(shiftId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That shift no longer exists.');

  const shift = snap.data() as ShiftDoc;
  const pending = shift.pendingEdit;
  if (!shift.hasPendingEdit || !pending) {
    throw new HttpsError('failed-precondition', 'There is no pending change on this shift.');
  }

  const outcome = {
    status: decision,
    reason: pending.reason,
    note,
    decidedBy: caller.uid,
    decidedAt: Timestamp.now(),
    appliedClockInAt: decision === 'approved' ? pending.requestedClockInAt : null,
    appliedClockOutAt: decision === 'approved' ? pending.requestedClockOutAt : null,
  };

  const applied =
    decision === 'approved'
      ? {
          clockInAt: pending.requestedClockInAt,
          'clockIn.at': pending.requestedClockInAt,
          ...(pending.requestedClockOutAt
            ? {
                clockOutAt: pending.requestedClockOutAt,
                ...(shift.clockOut ? { 'clockOut.at': pending.requestedClockOutAt } : {}),
                durationMinutes: Math.round(
                  (pending.requestedClockOutAt.toMillis() -
                    pending.requestedClockInAt.toMillis()) /
                    60000,
                ),
              }
            : {}),
          flags: Array.from(new Set([...(shift.flags ?? []), FLAG.WORKER_EDITED])),
        }
      : {};

  await ref.update({
    ...applied,
    hasPendingEdit: false,
    pendingEdit: null,
    lastEdit: outcome,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAudit({
    action: 'shift.edit_reviewed',
    actorUid: caller.uid,
    actorEmail: caller.email,
    targetUserId: shift.userId,
    targetId: shiftId,
    ip: callerIp(request),
    details: {
      decision,
      note,
      reason: pending.reason,
      before: {
        clockInAt: pending.originalClockInAt.toMillis(),
        clockOutAt: pending.originalClockOutAt ? pending.originalClockOutAt.toMillis() : null,
      },
      requested: {
        clockInAt: pending.requestedClockInAt.toMillis(),
        clockOutAt: pending.requestedClockOutAt ? pending.requestedClockOutAt.toMillis() : null,
      },
    },
  });

  return { ok: true };
});
