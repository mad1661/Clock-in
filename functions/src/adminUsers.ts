import { randomInt } from 'node:crypto';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import {
  db,
  auth,
  COLLECTIONS,
  CALLABLE_OPTS,
  requireAdmin,
  requireActiveUser,
  writeAudit,
  callerIp,
  requireString,
  normaliseEmail,
} from './common';
import type { Role, UserDoc } from './types';

// Avoids 0/O and 1/l/I so a password read off a screen and typed on a phone
// keyboard does not turn into a support ticket.
const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function generatePassword(length = 14): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return out;
}

/**
 * Custom claims are what Firestore and Storage rules read, so they must always
 * mirror the user document. Revoking refresh tokens forces the client to fetch
 * a fresh ID token, which means a deactivation takes effect within seconds
 * instead of waiting out the one-hour token lifetime.
 */
async function syncClaims(uid: string, role: Role, active: boolean, revoke: boolean) {
  await auth.setCustomUserClaims(uid, { role, active });
  if (revoke) {
    await auth.revokeRefreshTokens(uid);
  }
}

/**
 * One-time promotion of the first administrator.
 *
 * Setup flow: create yourself a user in the Firebase console (Authentication →
 * Add user), sign in to the web app, then call this. It refuses to run once any
 * admin exists, so it cannot be used for privilege escalation later.
 */
export const bootstrapAdmin = onCall(CALLABLE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  const token = request.auth?.token;
  if (!uid || !token?.email) {
    throw new HttpsError('unauthenticated', 'Sign in first, then run bootstrap.');
  }

  const existingAdmins = await db
    .collection(COLLECTIONS.users)
    .where('role', '==', 'admin')
    .limit(1)
    .get();

  // Bootstrap is two writes — the profile, then the auth claims — and it is not
  // atomic. If the first succeeded and the second failed, the caller is a
  // half-made admin: the profile says admin, the token does not, and every
  // retry would hit "an administrator already exists" and lock them out of
  // their own project permanently. So if the only admin IS the caller, finish
  // the job instead of refusing.
  if (!existingAdmins.empty) {
    const owner = existingAdmins.docs[0];
    if (owner.id !== uid) {
      throw new HttpsError(
        'failed-precondition',
        'An administrator already exists. Ask them to create your account.',
      );
    }

    await syncClaims(uid, 'admin', true, true);
    logger.info('Re-synced claims for an existing admin', { uid });
    return {
      ok: true,
      uid,
      email: owner.data().email ?? token.email.toLowerCase(),
      displayName: owner.data().displayName ?? '',
    };
  }

  const email = token.email.toLowerCase();
  const displayName =
    (typeof request.data?.displayName === 'string' && request.data.displayName.trim()) ||
    token.name ||
    email.split('@')[0];

  const now = FieldValue.serverTimestamp();
  try {
    await db.collection(COLLECTIONS.users).doc(uid).set({
      uid,
      email,
      displayName,
      role: 'admin',
      active: true,
      jobSiteIds: [],
      createdAt: now,
      createdBy: null,
      updatedAt: now,
      mustChangePassword: false,
    });
  } catch (err) {
    logger.error('Bootstrap failed writing the profile', { uid, err });
    throw new HttpsError(
      'internal',
      'Could not write to the database. Check that Firestore was created in ' +
        'Native mode (not Datastore mode) in the Firebase console.',
    );
  }

  try {
    await syncClaims(uid, 'admin', true, true);
  } catch (err) {
    logger.error('Bootstrap failed setting auth claims', { uid, err });
    throw new HttpsError(
      'internal',
      'Your profile was created but your admin permissions could not be set. ' +
        'The functions service account is missing Firebase Authentication ' +
        'rights — grant it the "Firebase Authentication Admin" role, then ' +
        'open this page again.',
    );
  }
  await writeAudit({
    action: 'admin.bootstrap',
    actorUid: uid,
    actorEmail: email,
    targetUserId: uid,
    ip: callerIp(request),
  });

  logger.info('Bootstrapped first admin', { uid, email });
  return { ok: true, uid, email, displayName };
});

/** Creates a worker (or another admin) and returns a one-time password. */
export const createWorker = onCall(CALLABLE_OPTS, async (request) => {
  const caller = await requireAdmin(request);

  const email = normaliseEmail(request.data?.email);
  const displayName = requireString(request.data?.displayName, 'Name', 120);
  const role: Role = request.data?.role === 'admin' ? 'admin' : 'worker';
  const jobSiteIds = Array.isArray(request.data?.jobSiteIds)
    ? (request.data.jobSiteIds as unknown[])
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .slice(0, 50)
    : [];

  const password = generatePassword();

  let userRecord;
  try {
    userRecord = await auth.createUser({
      email,
      password,
      displayName,
      emailVerified: false,
      disabled: false,
    });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'An account with that email already exists.');
    }
    if (code === 'auth/invalid-email') {
      throw new HttpsError('invalid-argument', 'That email address is not valid.');
    }
    logger.error('createUser failed', { email, err });
    throw new HttpsError('internal', 'Could not create the account. Please try again.');
  }

  const now = FieldValue.serverTimestamp();
  try {
    await db.collection(COLLECTIONS.users).doc(userRecord.uid).set({
      uid: userRecord.uid,
      email,
      displayName,
      role,
      active: true,
      jobSiteIds,
      createdAt: now,
      createdBy: caller.uid,
      updatedAt: now,
      mustChangePassword: true,
    });
    await syncClaims(userRecord.uid, role, true, false);
  } catch (err) {
    // Never leave an auth account without a profile — it would be a login that
    // works but resolves to nothing, which is confusing and hard to audit.
    await auth.deleteUser(userRecord.uid).catch(() => undefined);
    logger.error('Rolling back created auth user', { uid: userRecord.uid, err });
    throw new HttpsError('internal', 'Could not save the employee profile. Please try again.');
  }

  await writeAudit({
    action: 'worker.create',
    actorUid: caller.uid,
    actorEmail: caller.email,
    targetUserId: userRecord.uid,
    ip: callerIp(request),
    details: { email, displayName, role, jobSiteIds },
  });

  // The password is returned exactly once, here. It is never stored anywhere.
  return { uid: userRecord.uid, email, displayName, role, temporaryPassword: password };
});

/** Updates the mutable parts of an employee profile. */
export const updateWorker = onCall(CALLABLE_OPTS, async (request) => {
  const caller = await requireAdmin(request);
  const uid = requireString(request.data?.uid, 'Employee id', 128);

  const ref = db.collection(COLLECTIONS.users).doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That employee no longer exists.');
  const existing = snap.data() as UserDoc;

  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };

  if (request.data?.displayName !== undefined) {
    updates.displayName = requireString(request.data.displayName, 'Name', 120);
  }
  if (Array.isArray(request.data?.jobSiteIds)) {
    updates.jobSiteIds = (request.data.jobSiteIds as unknown[])
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, 50);
  }

  let nextRole = existing.role;
  if (request.data?.role === 'admin' || request.data?.role === 'worker') {
    nextRole = request.data.role;
    // Guard against an org locking itself out of its own admin console.
    if (existing.role === 'admin' && nextRole === 'worker') {
      await assertNotLastAdmin(uid);
    }
    updates.role = nextRole;
  }

  await ref.update(updates);
  if (updates.displayName) {
    await auth.updateUser(uid, { displayName: updates.displayName as string });
  }
  if (nextRole !== existing.role) {
    await syncClaims(uid, nextRole, existing.active, true);
  }

  await writeAudit({
    action: 'worker.update',
    actorUid: caller.uid,
    actorEmail: caller.email,
    targetUserId: uid,
    ip: callerIp(request),
    details: updates,
  });

  return { ok: true };
});

/** Enables or disables an employee's ability to sign in and clock. */
export const setWorkerActive = onCall(CALLABLE_OPTS, async (request) => {
  const caller = await requireAdmin(request);
  const uid = requireString(request.data?.uid, 'Employee id', 128);
  const active = request.data?.active === true;

  if (uid === caller.uid && !active) {
    throw new HttpsError('failed-precondition', 'You cannot deactivate your own account.');
  }

  const ref = db.collection(COLLECTIONS.users).doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That employee no longer exists.');
  const existing = snap.data() as UserDoc;

  if (!active && existing.role === 'admin') {
    await assertNotLastAdmin(uid);
  }

  await ref.update({ active, updatedAt: FieldValue.serverTimestamp() });
  await auth.updateUser(uid, { disabled: !active });
  await syncClaims(uid, existing.role, active, true);

  await writeAudit({
    action: active ? 'worker.activate' : 'worker.deactivate',
    actorUid: caller.uid,
    actorEmail: caller.email,
    targetUserId: uid,
    ip: callerIp(request),
  });

  return { ok: true, active };
});

/** Issues a fresh one-time password for an employee who is locked out. */
export const resetWorkerPassword = onCall(CALLABLE_OPTS, async (request) => {
  const caller = await requireAdmin(request);
  const uid = requireString(request.data?.uid, 'Employee id', 128);

  const ref = db.collection(COLLECTIONS.users).doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'That employee no longer exists.');

  const password = generatePassword();
  await auth.updateUser(uid, { password });
  await auth.revokeRefreshTokens(uid);
  await ref.update({ mustChangePassword: true, updatedAt: FieldValue.serverTimestamp() });

  await writeAudit({
    action: 'worker.password_reset',
    actorUid: caller.uid,
    actorEmail: caller.email,
    targetUserId: uid,
    ip: callerIp(request),
  });

  return { temporaryPassword: password };
});

/**
 * Clears the "you are still on the temporary password" banner.
 * Called by the worker themselves after they change it in the web app.
 */
export const acknowledgePasswordChange = onCall(CALLABLE_OPTS, async (request) => {
  const caller = await requireActiveUser(request);
  await db.collection(COLLECTIONS.users).doc(caller.uid).update({
    mustChangePassword: false,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

async function assertNotLastAdmin(uidBeingChanged: string): Promise<void> {
  const admins = await db
    .collection(COLLECTIONS.users)
    .where('role', '==', 'admin')
    .where('active', '==', true)
    .get();

  const others = admins.docs.filter((doc) => doc.id !== uidBeingChanged);
  if (others.length === 0) {
    throw new HttpsError(
      'failed-precondition',
      'This is the only active administrator. Promote someone else first.',
    );
  }
}
