import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError, type CallableRequest, type CallableOptions } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import type { Role, UserDoc } from './types';

if (getApps().length === 0) {
  initializeApp();
}

export const db = getFirestore();
export const auth = getAuth();
export const storage = getStorage();

db.settings({ ignoreUndefinedProperties: true });

export const COLLECTIONS = {
  users: 'users',
  jobSites: 'jobSites',
  shifts: 'shifts',
  auditLogs: 'auditLogs',
} as const;

/**
 * Shared options for every callable.
 *
 * `enforceAppCheck` is driven by an env var so you can deploy first and turn on
 * App Check once the web app is registered with reCAPTCHA Enterprise — see
 * SETUP.md. With it on, a stolen ID token replayed from curl is rejected,
 * which closes the "script the API directly" hole.
 */
export const CALLABLE_OPTS: CallableOptions = {
  region: process.env.FUNCTIONS_REGION || 'us-central1',
  enforceAppCheck: process.env.ENFORCE_APP_CHECK === 'true',
  cors: true,
  memory: '256MiB',
  timeoutSeconds: 30,
};

export interface Caller {
  uid: string;
  email: string;
  role: Role;
  user: UserDoc;
}

/**
 * Resolves the caller and verifies they are still an active employee.
 *
 * The custom claim alone is not enough: claims are cached in the client's ID
 * token for up to an hour, so a worker deactivated five minutes ago would still
 * present `active: true`. We therefore re-read the user document on every call
 * and treat Firestore as the source of truth.
 */
export async function requireActiveUser(request: CallableRequest): Promise<Caller> {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }

  const snap = await db.collection(COLLECTIONS.users).doc(uid).get();
  if (!snap.exists) {
    throw new HttpsError('permission-denied', 'No employee profile is linked to this account.');
  }

  const user = snap.data() as UserDoc;
  if (!user.active) {
    throw new HttpsError(
      'permission-denied',
      'This account has been deactivated. Contact your administrator.',
    );
  }

  return { uid, email: user.email, role: user.role, user };
}

export async function requireAdmin(request: CallableRequest): Promise<Caller> {
  const caller = await requireActiveUser(request);
  if (caller.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Administrator access is required.');
  }
  return caller;
}

/** Best-effort client IP, accounting for the load balancer in front of us. */
export function callerIp(request: CallableRequest): string | null {
  const raw = request.rawRequest;
  if (!raw) return null;
  const forwarded = raw.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return raw.ip ?? null;
}

export type AuditAction =
  | 'worker.create'
  | 'worker.update'
  | 'worker.deactivate'
  | 'worker.activate'
  | 'worker.password_reset'
  | 'worker.delete'
  | 'jobsite.upsert'
  | 'jobsite.delete'
  | 'shift.clock_in'
  | 'shift.clock_out'
  | 'shift.review'
  | 'shift.manual_edit'
  | 'shift.auto_close'
  | 'admin.bootstrap';

/**
 * Append-only audit trail. Written with the Admin SDK so it is unreachable from
 * any client, which is what makes it usable as evidence in a payroll dispute.
 */
export async function writeAudit(entry: {
  action: AuditAction;
  actorUid: string | null;
  actorEmail: string | null;
  targetUserId?: string | null;
  targetId?: string | null;
  ip?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.collection(COLLECTIONS.auditLogs).add({
      ...entry,
      targetUserId: entry.targetUserId ?? null,
      targetId: entry.targetId ?? null,
      ip: entry.ip ?? null,
      details: entry.details ?? {},
      at: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // An audit write must never take down the operation it is describing.
    logger.error('Failed to write audit log', { action: entry.action, err });
  }
}

export function requireString(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpsError('invalid-argument', `${field} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new HttpsError('invalid-argument', `${field} must be ${maxLength} characters or fewer.`);
  }
  return trimmed;
}

export function optionalString(value: unknown, maxLength = 500): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLength);
}

export function normaliseEmail(value: unknown): string {
  const email = requireString(value, 'Email', 254).toLowerCase();
  // Deliberately permissive: Firebase Auth does the authoritative validation.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new HttpsError('invalid-argument', 'That does not look like a valid email address.');
  }
  return email;
}

export function toMillis(value: Timestamp | null | undefined): number | null {
  return value ? value.toMillis() : null;
}
