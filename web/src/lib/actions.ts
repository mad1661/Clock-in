import { initializeApp, deleteApp, getApp } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  sendPasswordResetEmail,
  signOut,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type Timestamp,
} from 'firebase/firestore';
import { auth, db, useEmulators } from '../firebase';
import type { LocationFix } from './geolocation';
import { describeDevice } from './device';
import { distanceMeters } from './policy';
import type { DailyTicket, Equipment, JobSite, Role, Shift } from './types';

/**
 * Every write the app makes.
 *
 * There are no Cloud Functions — these go straight to Firestore, and
 * firestore.rules is what enforces them. Two consequences shape everything in
 * here:
 *
 *   1. Timestamps are always `serverTimestamp()`, never `Date.now()`. The rules
 *      require the stored value to equal `request.time`, so a client that sends
 *      its own clock is simply rejected.
 *   2. Anything the client computes for display — distance, "is this verified" —
 *      is recomputed by the rules from the job site document. Getting it wrong
 *      here fails the write rather than sneaking a bad record through.
 */

const nowServer = () => serverTimestamp();

/** A rules rejection, as opposed to the network being down. */
function isPermissionDenied(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'permission-denied'
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Claims the company and makes the caller its first administrator.
 *
 * The company document and the admin profile are written in ONE batch on
 * purpose: the rules let the profile be created with role 'admin' only when the
 * company document does not yet exist and is being created in the same batch.
 * That makes it work exactly once, for whoever sets the company up, with no
 * server to arbitrate.
 */
export async function bootstrapCompany(displayName: string) {
  const user = auth.currentUser;
  if (!user?.email) throw new Error('Sign in first.');

  const batch = writeBatch(db);
  batch.set(doc(db, 'users', user.uid), {
    uid: user.uid,
    email: user.email.toLowerCase(),
    displayName: displayName.trim() || user.email.split('@')[0],
    role: 'admin',
    active: true,
    jobSiteIds: [],
    mustChangePassword: false,
    createdAt: nowServer(),
    updatedAt: nowServer(),
  });
  batch.set(doc(db, 'config', 'company'), {
    ownerUid: user.uid,
    name: 'Coburn Equipment Rentals',
    createdAt: nowServer(),
  });
  await batch.commit();
}

export async function companyExists(): Promise<boolean> {
  const snap = await getDoc(doc(db, 'config', 'company'));
  return snap.exists();
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

/**
 * Creates a worker's login and profile.
 *
 * Firebase Auth has no client API for "create a user as somebody else", so this
 * uses a second, throwaway Firebase app: signing up on that instance mints the
 * account without touching the administrator's own session on the main
 * instance. It is the standard way to do this without the Admin SDK.
 */
export async function createWorker(input: {
  email: string;
  displayName: string;
  role: Role;
  jobSiteIds: string[];
  equipmentIds?: string[];
  password: string;
  hourlyRate?: number | null;
}) {
  const email = input.email.trim().toLowerCase();
  const name = 'worker-provisioning';

  // Reuse the instance if a previous attempt left one behind.
  let secondary;
  let fresh = false;
  try {
    secondary = getApp(name);
  } catch {
    secondary = initializeApp(auth.app.options, name);
    fresh = true;
  }
  const secondaryAuth = getAuth(secondary);
  // The emulator connection is per-app, so this second instance needs pointing
  // at it too. Without this it quietly talks to real Firebase Auth, and creating
  // an employee fails everywhere except production.
  if (fresh && useEmulators) {
    connectAuthEmulator(secondaryAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
  }

  try {
    const created = await createUserWithEmailAndPassword(secondaryAuth, email, input.password);
    const uid = created.user.uid;

    // Sign the throwaway instance out immediately; it must never linger as a
    // signed-in session for someone else's account.
    await signOut(secondaryAuth).catch(() => undefined);

    await setDoc(doc(db, 'users', uid), {
      uid,
      email,
      displayName: input.displayName.trim(),
      role: input.role,
      active: true,
      jobSiteIds: input.jobSiteIds,
      equipmentIds: input.equipmentIds ?? [],
      hourlyRate: input.hourlyRate ?? null,
      mustChangePassword: true,
      createdAt: nowServer(),
      updatedAt: nowServer(),
    });

    await audit('worker.create', { targetUserId: uid, email, role: input.role });
    return { uid, email };
  } finally {
    await deleteApp(secondary).catch(() => undefined);
  }
}

export async function updateWorker(
  uid: string,
  patch: {
    displayName?: string;
    role?: Role;
    jobSiteIds?: string[];
    equipmentIds?: string[];
    hourlyRate?: number | null;
  },
) {
  await updateDoc(doc(db, 'users', uid), { ...patch, updatedAt: nowServer() });
  await audit('worker.update', { targetUserId: uid, ...patch });
}

/**
 * Turns an employee off.
 *
 * Without the Admin SDK the Auth account itself cannot be disabled, so they can
 * still sign in — but every rule checks `active`, so a deactivated person can
 * read nothing and write nothing. Worth knowing rather than assuming.
 */
export async function setWorkerActive(uid: string, active: boolean) {
  await updateDoc(doc(db, 'users', uid), { active, updatedAt: nowServer() });
  await audit(active ? 'worker.activate' : 'worker.deactivate', { targetUserId: uid });
}

/** Sends a reset link. Setting a password directly needs the Admin SDK. */
export async function sendWorkerPasswordReset(email: string) {
  await sendPasswordResetEmail(auth, email);
  await audit('worker.password_reset', { email });
}

export async function acknowledgePasswordChange() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  await updateDoc(doc(db, 'users', uid), {
    mustChangePassword: false,
    updatedAt: nowServer(),
  });
}

// ---------------------------------------------------------------------------
// Job sites
// ---------------------------------------------------------------------------

/**
 * Metres per degree of longitude at this latitude.
 *
 * Precomputed here and stored on the site because security rules have no cos().
 * It is what lets the rules check the geofence with multiplication alone.
 */
function metersPerDegLng(lat: number): number {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

export async function upsertJobSite(input: {
  id?: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  active: boolean;
  customer?: string;
  jobNumber?: string;
  equipmentIds?: string[];
}) {
  const ref = input.id ? doc(db, 'jobSites', input.id) : doc(collection(db, 'jobSites'));
  await setDoc(
    ref,
    {
      id: ref.id,
      name: input.name.trim(),
      address: input.address.trim(),
      lat: input.lat,
      lng: input.lng,
      radiusMeters: Math.round(input.radiusMeters),
      metersPerDegLng: metersPerDegLng(input.lat),
      active: input.active,
      customer: (input.customer ?? '').trim(),
      jobNumber: (input.jobNumber ?? '').trim(),
      equipmentIds: input.equipmentIds ?? [],
      updatedAt: nowServer(),
    },
    { merge: true },
  );
  await audit('jobsite.upsert', { targetId: ref.id, name: input.name });
  return ref.id;
}

export async function retireJobSite(id: string, name: string) {
  await updateDoc(doc(db, 'jobSites', id), { active: false, updatedAt: nowServer() });
  await audit('jobsite.delete', { targetId: id, name });
}

// ---------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------

export async function upsertEquipment(input: {
  id?: string;
  type: string;
  machineNo: string;
  description?: string;
  active: boolean;
  hourlyRate?: number | null;
}) {
  const ref = input.id ? doc(db, 'equipment', input.id) : doc(collection(db, 'equipment'));
  await setDoc(
    ref,
    {
      id: ref.id,
      type: input.type.trim(),
      machineNo: input.machineNo.trim(),
      description: (input.description ?? '').trim(),
      active: input.active,
      hourlyRate: input.hourlyRate ?? null,
      updatedAt: nowServer(),
    },
    { merge: true },
  );
  await audit('equipment.upsert', { targetId: ref.id, type: input.type, machineNo: input.machineNo });
  return ref.id;
}

/** Retired, never deleted — a ticket from last year still points at it. */
export async function retireEquipment(id: string, label: string) {
  await updateDoc(doc(db, 'equipment', id), { active: false, updatedAt: nowServer() });
  await audit('equipment.retire', { targetId: id, label });
}

// ---------------------------------------------------------------------------
// Clocking
// ---------------------------------------------------------------------------

export interface PunchInput {
  site: JobSite;
  location: LocationFix | null;
  locationError: { code: number | null; message: string } | null;
  /** The machine the operator is on, when the site has any assigned. */
  equipment?: Equipment | null;
  /** Hour-meter reading, read off the machine at clock-out. */
  tractorHours?: number | null;
}

export interface PunchOutcome {
  verified: boolean;
  distanceMeters: number | null;
  needsReview: boolean;
  /** Why it needs review, in the vocabulary FLAG_LABELS renders. */
  flags: string[];
}

/**
 * Whether this fix would satisfy the rules.
 *
 * Mirrors firestore.rules exactly. It is NOT the check — the rules are, and
 * they reject the write if this disagrees. It exists so the app can tell the
 * worker what is about to happen, and so `needsReview` is written correctly on
 * the first try rather than bouncing off a permission error.
 */
export function evaluatePunch(site: JobSite, location: LocationFix | null): PunchOutcome {
  if (!location) {
    return {
      verified: false,
      distanceMeters: null,
      needsReview: true,
      flags: ['NO_LOCATION_PROOF'],
    };
  }

  const distance = distanceMeters(location, site);
  const slack = Math.min(location.accuracy, 75);
  const fresh = Date.now() - location.capturedAt < 2 * 60 * 1000;
  const precise = Number.isFinite(location.accuracy) && location.accuracy <= 150;
  const inside = distance <= site.radiusMeters + slack;

  // Recorded so a supervisor sees why a punch is in front of them rather than
  // just that it is. Thresholds mirror punchVerified() in firestore.rules.
  const flags: string[] = [];
  if (!precise) flags.push('LOW_ACCURACY');
  if (!fresh) flags.push('STALE_FIX');
  if (!inside) flags.push('OUTSIDE_GEOFENCE');

  const verified = precise && fresh && inside;
  return {
    verified,
    distanceMeters: Math.round(distance),
    needsReview: !verified,
    flags: verified ? [] : flags,
  };
}

function punchRecord(input: PunchInput, outcome: PunchOutcome) {
  return {
    at: nowServer(),
    method: outcome.verified ? 'gps' : 'unverified',
    jobSiteId: input.site.id,
    jobSiteName: input.site.name,
    location: input.location
      ? {
          lat: input.location.lat,
          lng: input.location.lng,
          accuracy: Number.isFinite(input.location.accuracy) ? input.location.accuracy : -1,
          // A client timestamp, and the rules treat it as such: they only ever
          // use it to reject a stale fix, never as the punch's own time.
          capturedAt: new Date(input.location.capturedAt),
        }
      : null,
    locationError: input.locationError,
    site: {
      lat: input.site.lat,
      lng: input.site.lng,
      radiusMeters: input.site.radiusMeters,
    },
    distanceMeters: outcome.distanceMeters,
    withinGeofence: outcome.verified,
    flags: outcome.flags,
    photoPath: null,
    device: describeDevice(),
    note: null,
    offline: null,
  };
}

/**
 * Clocks in.
 *
 * The shift and the worker's clock-state document are written in one batch: the
 * rules require the state document to name this exact shift afterwards, which
 * is how "you cannot have two shifts open" is enforced without a query.
 */
export async function clockIn(input: PunchInput) {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in first.');

  const profile = await getDoc(doc(db, 'users', user.uid));
  const stateRef = doc(db, 'userState', user.uid);
  // A first-ever punch has no clock-state document. It is created inside the
  // batch already naming the new shift — creating it first and updating it
  // second would trip the rules' 30-second rate limit on the worker's very
  // first clock-in.
  const firstEver = !(await getDoc(stateRef)).exists();

  const commit = async (outcome: PunchOutcome) => {
    const shiftRef = doc(collection(db, 'shifts'));
    const punch = punchRecord(input, outcome);
    const batch = writeBatch(db);
    batch.set(shiftRef, {
      id: shiftRef.id,
      userId: user.uid,
      userDisplayName: profile.data()?.displayName ?? user.email ?? '',
      userEmail: profile.data()?.email ?? user.email ?? '',
      jobSiteId: input.site.id,
      jobSiteName: input.site.name,
      status: 'open',
      clockIn: punch,
      clockOut: null,
      clockInAt: nowServer(),
      clockOutAt: null,
      durationMinutes: null,
      needsReview: outcome.needsReview,
      flags: outcome.flags,
      review: {
        status: outcome.needsReview ? 'pending' : 'approved',
        by: null,
        at: null,
        note: null,
      },
      pendingEdit: null,
      hasPendingEdit: false,
      lastEdit: null,
      equipmentId: input.equipment?.id ?? null,
      equipmentType: input.equipment?.type ?? null,
      machineNo: input.equipment?.machineNo ?? null,
      tractorHours: null,
      createdAt: nowServer(),
      updatedAt: nowServer(),
    });
    const state = { openShiftId: shiftRef.id, lastPunchAt: nowServer() };
    if (firstEver) batch.set(stateRef, state);
    else batch.update(stateRef, state);
    await batch.commit();
    return { shiftId: shiftRef.id, ...outcome };
  };

  const outcome = evaluatePunch(input.site, input.location);
  try {
    return await commit(outcome);
  } catch (err) {
    // The rules recompute the geofence themselves and are the authority. If
    // they disagreed with the optimistic read above — a metre outside the
    // fence, a fix that aged past the freshness window in flight — record the
    // punch flagged rather than leave the worker unable to clock in. Flagging
    // is always permitted; only claiming "clean" is checked.
    if (!outcome.verified || !isPermissionDenied(err)) throw err;
    return await commit({
      ...outcome,
      verified: false,
      needsReview: true,
      flags: [...outcome.flags, 'NO_LOCATION_PROOF'],
    });
  }
}

export async function clockOut(shift: Shift, input: PunchInput) {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in first.');

  const commit = async (outcome: PunchOutcome) => {
    const flagged = shift.needsReview || outcome.needsReview;
    const batch = writeBatch(db);
    batch.update(doc(db, 'shifts', shift.id), {
      status: 'closed',
      clockOut: punchRecord(input, outcome),
      clockOutAt: nowServer(),
      ...(input.tractorHours != null ? { tractorHours: input.tractorHours } : {}),
      needsReview: flagged,
      // Union of both ends of the shift: a supervisor needs the whole story.
      flags: Array.from(new Set([...(shift.flags ?? []), ...outcome.flags])),
      'review.status': flagged ? 'pending' : 'approved',
      updatedAt: nowServer(),
    });
    batch.update(doc(db, 'userState', user.uid), {
      openShiftId: null,
      lastPunchAt: nowServer(),
    });
    await batch.commit();
    return outcome;
  };

  // Same fallback as clocking in, and it matters more here: a worker who cannot
  // clock out is stuck on the clock.
  const outcome = evaluatePunch(input.site, input.location);
  try {
    return await commit(outcome);
  } catch (err) {
    if (!outcome.verified || !isPermissionDenied(err)) throw err;
    return await commit({
      ...outcome,
      verified: false,
      needsReview: true,
      flags: [...outcome.flags, 'NO_LOCATION_PROOF'],
    });
  }
}

// ---------------------------------------------------------------------------
// Corrections and review
// ---------------------------------------------------------------------------

export async function requestShiftEdit(
  shift: Shift,
  requested: { clockInAt: Date; clockOutAt: Date | null; reason: string },
) {
  await updateDoc(doc(db, 'shifts', shift.id), {
    hasPendingEdit: true,
    pendingEdit: {
      requestedAt: nowServer(),
      requestedClockInAt: requested.clockInAt,
      requestedClockOutAt: requested.clockOutAt,
      originalClockInAt: shift.clockInAt,
      originalClockOutAt: shift.clockOutAt,
      reason: requested.reason.trim(),
    },
    updatedAt: nowServer(),
  });
}

export async function cancelShiftEdit(shift: Shift) {
  await updateDoc(doc(db, 'shifts', shift.id), {
    hasPendingEdit: false,
    pendingEdit: null,
    updatedAt: nowServer(),
  });
}

export async function reviewShift(shift: Shift, decision: 'approved' | 'rejected', note: string) {
  const uid = auth.currentUser?.uid ?? null;
  await updateDoc(doc(db, 'shifts', shift.id), {
    needsReview: false,
    review: { status: decision, by: uid, at: nowServer(), note: note.trim() || null },
    updatedAt: nowServer(),
  });
  await audit('shift.review', { targetId: shift.id, targetUserId: shift.userId, decision, note });
}

export async function reviewShiftEdit(
  shift: Shift,
  decision: 'approved' | 'rejected',
  note: string,
) {
  const uid = auth.currentUser?.uid ?? null;
  const pending = shift.pendingEdit;
  if (!pending) throw new Error('There is no pending change on this shift.');

  const applied =
    decision === 'approved'
      ? {
          clockInAt: pending.requestedClockInAt,
          clockOutAt: pending.requestedClockOutAt,
          durationMinutes: pending.requestedClockOutAt
            ? Math.round(
                (pending.requestedClockOutAt.toMillis() - pending.requestedClockInAt.toMillis()) /
                  60000,
              )
            : null,
        }
      : {};

  await updateDoc(doc(db, 'shifts', shift.id), {
    ...applied,
    flags:
      decision === 'approved'
        ? Array.from(new Set([...(shift.flags ?? []), 'WORKER_EDITED']))
        : (shift.flags ?? []),
    hasPendingEdit: false,
    pendingEdit: null,
    lastEdit: {
      status: decision,
      reason: pending.reason,
      note: note.trim() || null,
      decidedBy: uid,
      decidedAt: nowServer(),
    },
    updatedAt: nowServer(),
  });
  await audit('shift.edit_reviewed', {
    targetId: shift.id,
    targetUserId: shift.userId,
    decision,
    note,
  });
}

export async function adjustShift(
  shift: Shift,
  times: { clockInAt: Date; clockOutAt: Date | null },
  note: string,
) {
  const uid = auth.currentUser?.uid ?? null;
  await updateDoc(doc(db, 'shifts', shift.id), {
    clockInAt: times.clockInAt,
    clockOutAt: times.clockOutAt,
    durationMinutes: times.clockOutAt
      ? Math.round((times.clockOutAt.getTime() - times.clockInAt.getTime()) / 60000)
      : null,
    status: times.clockOutAt ? 'closed' : shift.status,
    flags: Array.from(new Set([...(shift.flags ?? []), 'MANUAL_ENTRY'])),
    needsReview: false,
    review: { status: 'approved', by: uid, at: nowServer(), note: note.trim() },
    hasPendingEdit: false,
    pendingEdit: null,
    updatedAt: nowServer(),
  });
  await audit('shift.manual_edit', { targetId: shift.id, targetUserId: shift.userId, note });
}

/**
 * Frees a worker whose shift is stuck open.
 *
 * With no Cloud Functions there is no scheduled sweep for forgotten clock-outs,
 * so an administrator closes them by hand from the On site tab.
 */
export async function forceCloseShift(shift: Shift, note: string) {
  const batch = writeBatch(db);
  batch.update(doc(db, 'shifts', shift.id), {
    status: 'closed',
    clockOutAt: shift.clockInAt,
    durationMinutes: 0,
    flags: Array.from(new Set([...(shift.flags ?? []), 'FORCE_CLOSED'])),
    needsReview: true,
    review: { status: 'pending', by: null, at: null, note: note.trim() || null },
    updatedAt: nowServer(),
  });
  batch.update(doc(db, 'userState', shift.userId), { openShiftId: null });
  await batch.commit();
  await audit('shift.auto_close', { targetId: shift.id, targetUserId: shift.userId, note });
}

// ---------------------------------------------------------------------------
// Daily rental ticket
// ---------------------------------------------------------------------------

/**
 * Saves the ticket, allocating its number the first time it is saved.
 *
 * The number has to be unique and has to increase, and there is no server to
 * hand them out. A Firestore transaction does it instead: it reads the counter
 * and writes the counter and the ticket together, so two supervisors saving two
 * tickets at the same moment cannot come away with the same number — one
 * transaction retries and takes the next one.
 *
 * The counter lives on the company record so the yard can set it to carry on
 * from wherever their paper book left off.
 */
export async function saveDailyTicket(
  ticket: Omit<DailyTicket, 'createdAt' | 'updatedAt'>,
): Promise<number | null> {
  const ticketRef = doc(db, 'dailyTickets', ticket.id);
  const companyRef = doc(db, 'config', 'company');

  const assigned = await runTransaction(db, async (tx) => {
    const existing = await tx.get(ticketRef);
    let number = ticket.ticketNumber ?? existing.data()?.ticketNumber ?? null;

    if (number == null) {
      const company = await tx.get(companyRef);
      number = Number(company.data()?.nextTicketNumber ?? 1);
      tx.update(companyRef, { nextTicketNumber: number + 1 });
    }

    tx.set(
      ticketRef,
      {
        ...ticket,
        ticketNumber: number,
        ...(existing.exists() ? {} : { createdAt: nowServer() }),
        updatedAt: nowServer(),
      },
      { merge: true },
    );
    return number;
  });

  await audit('ticket.save', { targetId: ticket.id, ticketNumber: assigned });
  return assigned;
}

/** Records who signed the ticket off. The customer's copy needs a name on it. */
export async function signDailyTicket(ticketId: string, supervisorName: string) {
  await updateDoc(doc(db, 'dailyTickets', ticketId), {
    supervisorName: supervisorName.trim(),
    signedAt: nowServer(),
    updatedAt: nowServer(),
  });
  await audit('ticket.sign', { targetId: ticketId, supervisorName });
}

/** Sets the number the next new ticket will take, to match the paper book. */
export async function setNextTicketNumber(next: number) {
  await updateDoc(doc(db, 'config', 'company'), { nextTicketNumber: Math.max(1, Math.round(next)) });
  await audit('ticket.counter_set', { next });
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Append-only trail. Rules stamp it with the server clock and forbid edits and
 * deletes, so it stays usable as evidence even though the client writes it.
 * Never allowed to break the operation it is describing.
 */
async function audit(action: string, details: Record<string, unknown>) {
  try {
    const user = auth.currentUser;
    if (!user) return;
    await setDoc(doc(collection(db, 'auditLogs')), {
      action,
      actorUid: user.uid,
      actorEmail: user.email ?? null,
      targetUserId: (details.targetUserId as string) ?? null,
      targetId: (details.targetId as string) ?? null,
      details,
      at: nowServer(),
    });
  } catch {
    /* never block the real work */
  }
}

export type { Timestamp };
