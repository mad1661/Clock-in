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
  deleteField,
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
import { distanceMeters, hoursVerdict } from './policy';
import type { DailyTicket, Equipment, JobSite, Role, Shift, UserDoc } from './types';

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
    ownerUids: [user.uid],
    name: 'Coburn Equipment Rentals',
    createdAt: nowServer(),
  });
  await batch.commit();
  await audit('company.claimed', { targetUserId: user.uid, email: user.email });
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

/**
 * Stores the signed-in person's own signature.
 *
 * Kept on their user record rather than typed into each ticket: a supervisor
 * signs several a day, and redrawing the same mark on a phone every time is how
 * a feature stops being used.
 */
export async function saveMySignature(signature: UserDoc['signature']) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Sign in first.');
  await updateDoc(doc(db, 'users', uid), { signature, updatedAt: nowServer() });
  await audit(signature ? 'signature.saved' : 'signature.deleted', { targetUserId: uid });
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
  shiftStart?: string | null;
  shiftEnd?: string | null;
  /** True for the yard: hours go on weekly timecards, not a rental ticket. */
  timecardsOnly?: boolean;
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
      shiftStart: input.shiftStart || null,
      shiftEnd: input.shiftEnd || null,
      timecardsOnly: input.timecardsOnly ?? false,
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

/**
 * Adds the site-hours flags to a punch that has already been judged on location.
 *
 * Kept out of {@link evaluatePunch} on purpose: that function mirrors
 * firestore.rules line for line, and the rules cannot check site hours — they
 * see UTC and no timezone, so "was this 7am local" is not a question they can
 * answer twice a year. So these flags are advisory. They cannot launder a
 * punch, only mark one: `verified` is untouched, and `needsReview` is only ever
 * turned on, which the rules always allow.
 */
function withHoursFlags(site: JobSite, outcome: PunchOutcome, kind: 'in' | 'out'): PunchOutcome {
  const verdict = hoursVerdict(site);
  const flag =
    kind === 'in'
      ? verdict === 'before' || verdict === 'after' || verdict === 'outside'
        ? 'OUTSIDE_HOURS'
        : null
      : verdict === 'after' || verdict === 'outside'
        ? 'LATE_CLOCK_OUT'
        : null;
  if (!flag) return outcome;
  return {
    ...outcome,
    needsReview: true,
    flags: Array.from(new Set([...outcome.flags, flag])),
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

  const outcome = withHoursFlags(input.site, evaluatePunch(input.site, input.location), 'in');
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
  const outcome = withHoursFlags(input.site, evaluatePunch(input.site, input.location), 'out');
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
  await audit('shift.edit_requested', {
    targetId: shift.id,
    targetUserId: shift.userId,
    reason: requested.reason,
    from: {
      clockInAt: shift.clockInAt?.toDate().toISOString() ?? null,
      clockOutAt: shift.clockOutAt?.toDate().toISOString() ?? null,
    },
    to: {
      clockInAt: requested.clockInAt.toISOString(),
      clockOutAt: requested.clockOutAt?.toISOString() ?? null,
    },
  });
}

export async function cancelShiftEdit(shift: Shift) {
  await updateDoc(doc(db, 'shifts', shift.id), {
    hasPendingEdit: false,
    pendingEdit: null,
    updatedAt: nowServer(),
  });
  await audit('shift.edit_withdrawn', { targetId: shift.id, targetUserId: shift.userId });
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
    worker: shift.userDisplayName,
    decision,
    note,
    reason: pending.reason,
    from: {
      clockInAt: shift.clockInAt?.toDate().toISOString() ?? null,
      clockOutAt: shift.clockOutAt?.toDate().toISOString() ?? null,
    },
    to:
      decision === 'approved'
        ? {
            clockInAt: pending.requestedClockInAt?.toDate().toISOString() ?? null,
            clockOutAt: pending.requestedClockOutAt?.toDate().toISOString() ?? null,
          }
        : null,
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
  await audit('shift.manual_edit', {
    targetId: shift.id,
    targetUserId: shift.userId,
    worker: shift.userDisplayName,
    note,
    // What the hours were and what they became. A log saying only that
    // somebody edited a shift answers none of the questions you would ask.
    from: {
      clockInAt: shift.clockInAt?.toDate().toISOString() ?? null,
      clockOutAt: shift.clockOutAt?.toDate().toISOString() ?? null,
      minutes: shift.durationMinutes ?? null,
    },
    to: {
      clockInAt: times.clockInAt.toISOString(),
      clockOutAt: times.clockOutAt?.toISOString() ?? null,
      minutes: times.clockOutAt
        ? Math.round((times.clockOutAt.getTime() - times.clockInAt.getTime()) / 60000)
        : null,
    },
  });
}

/**
 * How long a shift has to have been running before somebody else may end it.
 *
 * Deliberately long. A shift still inside this window is somebody who is
 * probably still working, and taking them off the clock from an office would
 * cost them hours they are owed. Past it, it is a forgotten punch.
 */
export const STUCK_SHIFT_HOURS = 24;

/** True once a shift has been open long enough for an owner to close it. */
export function shiftIsStuck(shift: Shift, now: Date = new Date()): boolean {
  if (shift.status !== 'open') return false;
  const started = shift.clockInAt?.toDate?.();
  if (!started) return false;
  return now.getTime() - started.getTime() >= STUCK_SHIFT_HOURS * 3600_000;
}

/** One day of a forgotten shift, as somebody remembers it. */
export interface WorkedDay {
  start: Date;
  end: Date;
}

/** The punch record for a time nobody actually punched. */
function manualPunch(shift: Shift, at: Date) {
  return {
    at,
    method: 'manual',
    jobSiteId: shift.jobSiteId,
    jobSiteName: shift.jobSiteName,
    location: null,
    locationError: null,
    site: null,
    distanceMeters: null,
    withinGeofence: false,
    flags: ['MANUAL_ENTRY'],
    photoPath: null,
    device: null,
    note: 'Entered by an owner — never punched',
    offline: null,
  };
}

/**
 * Ends a shift that has been left open for more than a day.
 *
 * With no Cloud Functions there is no nightly sweep for forgotten clock-outs,
 * so an owner closes them by hand from the On site tab. The rules only accept
 * this from an owner and only past {@link STUCK_SHIFT_HOURS}.
 *
 * `firstDayEnd` and `extraDays` are when the worker actually worked, as best
 * anybody knows. It matters that this is asked for rather than assumed: hours
 * worked have to be recorded and paid whether or not somebody remembered to
 * press a button, so closing a shift at a guessed-low time is not a neutral act.
 * Knowing nothing is allowed, records no hours at all, and leaves the shift
 * sitting in the review queue, unpaid, until somebody enters the real ones.
 *
 * A shift left open across several days becomes one closed shift per day rather
 * than one enormous one. Somebody on the clock since Monday did not work
 * seventy-two hours — they went home each night — and a single record spanning
 * the lot lands every hour on Monday, reads as a seventy-two hour day to the
 * overtime split, and leaves Tuesday's and Wednesday's rental tickets showing
 * nobody on site.
 */
export async function forceCloseShift(
  shift: Shift,
  {
    firstDayEnd,
    extraDays = [],
    note,
  }: { firstDayEnd: Date | null; extraDays?: WorkedDay[]; note: string },
) {
  const started = shift.clockInAt.toDate();
  const rest = [...extraDays].sort((a, b) => a.start.getTime() - b.start.getTime());

  // The shift already carries a real, punched clock-in, so the day it was made
  // on is closed on the shift itself and only ever needs a finish time. The
  // later days never happened as far as the clock is concerned and are written
  // out in full.
  if (firstDayEnd) {
    if (firstDayEnd.getTime() < started.getTime()) throw new Error('That is before they clocked in.');
    if (firstDayEnd.getTime() > Date.now()) throw new Error('That is in the future.');
  }
  for (const day of rest) {
    if (day.end.getTime() < day.start.getTime()) throw new Error('A day cannot end before it starts.');
    if (day.end.getTime() > Date.now()) throw new Error('That is in the future.');
    if (day.start.getTime() < started.getTime()) throw new Error('That is before they clocked in.');
  }

  const uid = auth.currentUser?.uid ?? null;
  const first = firstDayEnd ? { start: started, end: firstDayEnd } : null;
  const minutes = first ? Math.round((first.end.getTime() - started.getTime()) / 60000) : 0;

  const batch = writeBatch(db);
  batch.update(doc(db, 'shifts', shift.id), {
    status: 'closed',
    clockOut: first ? manualPunch(shift, first.end) : null,
    clockOutAt: first ? first.end : shift.clockInAt,
    durationMinutes: minutes,
    flags: Array.from(
      new Set([...(shift.flags ?? []), 'FORCE_CLOSED', ...(first ? ['MANUAL_ENTRY'] : [])]),
    ),
    // An owner who supplied the hours has ruled on them. One who did not has
    // not, and the shift stays in the queue rather than quietly reading as a
    // settled day with no hours in it.
    needsReview: !first,
    review: first
      ? { status: 'approved', by: uid, at: nowServer(), note: note.trim() || null }
      : { status: 'pending', by: null, at: null, note: note.trim() || null },
    updatedAt: nowServer(),
  });

  for (const day of rest) {
    const ref = doc(collection(db, 'shifts'));
    batch.set(ref, {
      id: ref.id,
      // Names the shift this was split out of, which is also what the rules
      // check: this write is the repair of that shift, not a free hand to
      // invent history.
      fromShiftId: shift.id,
      userId: shift.userId,
      userDisplayName: shift.userDisplayName,
      userEmail: shift.userEmail,
      jobSiteId: shift.jobSiteId,
      jobSiteName: shift.jobSiteName,
      status: 'closed',
      clockIn: manualPunch(shift, day.start),
      clockOut: manualPunch(shift, day.end),
      clockInAt: day.start,
      clockOutAt: day.end,
      durationMinutes: Math.round((day.end.getTime() - day.start.getTime()) / 60000),
      needsReview: false,
      flags: ['MANUAL_ENTRY', 'FORCE_CLOSED'],
      review: { status: 'approved', by: uid, at: nowServer(), note: note.trim() || null },
      pendingEdit: null,
      hasPendingEdit: false,
      lastEdit: null,
      equipmentId: shift.equipmentId ?? null,
      equipmentType: shift.equipmentType ?? null,
      machineNo: shift.machineNo ?? null,
      tractorHours: null,
      createdAt: nowServer(),
      updatedAt: nowServer(),
    });
  }

  batch.update(doc(db, 'userState', shift.userId), { openShiftId: null });
  await batch.commit();

  const totalMinutes =
    minutes +
    rest.reduce((sum, day) => sum + Math.round((day.end.getTime() - day.start.getTime()) / 60000), 0);
  const lastEnd = rest.length ? rest[rest.length - 1].end : (first?.end ?? null);
  await audit('shift.auto_close', {
    targetId: shift.id,
    targetUserId: shift.userId,
    worker: shift.userDisplayName,
    note,
    days: (first ? 1 : 0) + rest.length,
    from: {
      clockInAt: started.toISOString(),
      clockOutAt: null,
      minutes: null,
    },
    to: {
      clockInAt: started.toISOString(),
      clockOutAt: lastEnd?.toISOString() ?? null,
      minutes: totalMinutes || null,
    },
  });
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

/**
 * Signs the ticket off.
 *
 * The signature is what the customer's copy carries, so the name goes on with
 * it — a mark on its own identifies nobody a year later when the invoice is
 * queried.
 */
export async function signDailyTicket(
  ticketId: string,
  supervisorName: string,
  signature: DailyTicket['signature'],
) {
  await updateDoc(doc(db, 'dailyTickets', ticketId), {
    supervisorName: supervisorName.trim(),
    signature,
    signedAt: nowServer(),
    updatedAt: nowServer(),
  });
  await audit('ticket.sign', { targetId: ticketId, supervisorName });
}

/**
 * Takes the signature back off a ticket.
 *
 * Separate from re-signing: a supervisor who signed the wrong day's sheet needs
 * the mark gone, not replaced. The name and time go with it — leaving those
 * behind would still read as signed on the printed copy.
 */
export async function clearDailyTicketSignature(ticketId: string) {
  await updateDoc(doc(db, 'dailyTickets', ticketId), {
    signature: null,
    supervisorName: null,
    signedAt: null,
    updatedAt: nowServer(),
  });
  await audit('ticket.unsign', { targetId: ticketId });
}

/**
 * Reads who currently owns the company.
 *
 * Tolerates the older single-`ownerUid` shape, which is what any company
 * claimed before ownership could be shared still carries. `firestore.rules`
 * reads it the same way, so the two never disagree.
 */
export async function currentOwnerUids(): Promise<string[]> {
  const snap = await getDoc(doc(db, 'config', 'company'));
  const data = snap.data();
  if (!data) return [];
  if (Array.isArray(data.ownerUids)) return data.ownerUids as string[];
  return data.ownerUid ? [data.ownerUid as string] : [];
}

/**
 * Makes another supervisor an owner alongside the existing ones.
 *
 * Owners are equals, not a chain of succession — this grants, it does not hand
 * over. The rules accept it only from somebody who is already an owner and only
 * in favour of an active supervisor, so the list cannot come to contain a
 * deactivated account or somebody with no way to use it.
 */
export async function addOwner(uid: string, name: string) {
  const owners = await currentOwnerUids();
  if (owners.includes(uid)) return;
  await updateDoc(doc(db, 'config', 'company'), {
    ownerUids: [...owners, uid],
    // The company has moved to the shared shape; drop the single-owner field
    // rather than leaving a stale name behind that looks authoritative.
    ownerUid: deleteField(),
  });
  await audit('company.owner_added', { targetUserId: uid, to: name });
}

/**
 * Takes ownership back off somebody, leaving them a supervisor.
 *
 * The last owner cannot be removed — the rules refuse to empty the list, since
 * a company nobody owns is one nobody can ever fix.
 */
export async function removeOwner(uid: string, name: string) {
  const owners = await currentOwnerUids();
  const next = owners.filter((o) => o !== uid);
  if (next.length === owners.length) return;
  if (next.length === 0) throw new Error('A company has to have at least one owner.');
  await updateDoc(doc(db, 'config', 'company'), {
    ownerUids: next,
    ownerUid: deleteField(),
  });
  await audit('company.owner_removed', { targetUserId: uid, to: name });
}

/**
 * Ticks a problem report off.
 *
 * Not a delete: the report is evidence of what somebody hit, and a list you can
 * empty is a list that stops being a record. If the same fault happens again it
 * comes back to the top by itself, which is the point — "fixed" that did not fix
 * it should not stay looking fixed.
 */
export async function resolveProblem(id: string) {
  await updateDoc(doc(db, 'errorLogs', id), {
    resolved: true,
    resolvedAt: nowServer(),
    resolvedBy: auth.currentUser?.uid ?? null,
  });
}

/**
 * Hands the Problems tab to somebody else.
 *
 * Only the person who currently holds it can do this, and only to an active
 * supervisor — the rules check both. There is no way to give yourself a look at
 * everybody's faults.
 */
export async function handOverProblems(uid: string, name: string) {
  await updateDoc(doc(db, 'config', 'company'), { supportUid: uid });
  await audit('company.support_changed', { targetUserId: uid, to: name });
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
