import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { db, CALLABLE_OPTS, requireAdmin, writeAudit, callerIp } from './common';

/**
 * Company-wide settings an administrator can change without a redeploy.
 *
 * Kept in Firestore rather than an environment variable so turning a feature on
 * is a switch in the app, not a deploy — and so the client can read the same
 * value and show the matching screens instead of guessing.
 */

const CONFIG = 'config';
const COMPANY = 'company';

export interface CompanySettings {
  /**
   * When on, a worker who cannot get a usable GPS fix must supply a photo taken
   * at the job site. Needs Cloud Storage, which is why it ships off.
   *
   * Off does not mean unverified punches are refused — they are recorded and
   * flagged. Refusing would leave a worker with a dead GPS unable to clock in
   * at all, which loses real hours over a problem that is not their fault.
   */
  photoFallbackEnabled: boolean;
}

export const DEFAULT_SETTINGS: CompanySettings = {
  photoFallbackEnabled: false,
};

/**
 * Read fresh on every punch, deliberately.
 *
 * An in-process cache was the obvious optimisation and it is wrong here:
 * clockIn runs in a different function instance from updateCompanySettings, so
 * clearing the cache on write cannot reach it, and the toggle would appear not
 * to work for a minute. One document read per punch against a 50k/day free
 * quota is not worth that confusion.
 */
export async function getCompanySettings(): Promise<CompanySettings> {
  try {
    const snap = await db.collection(CONFIG).doc(COMPANY).get();
    const data = snap.exists ? (snap.data() as Partial<CompanySettings>) : {};
    return { photoFallbackEnabled: data.photoFallbackEnabled === true };
  } catch {
    // Never let a settings read stop someone clocking in. Defaults are the
    // permissive-to-the-worker choice: record the punch, flag it.
    return DEFAULT_SETTINGS;
  }
}

export const updateCompanySettings = onCall(CALLABLE_OPTS, async (request) => {
  const caller = await requireAdmin(request);

  const photoFallbackEnabled = request.data?.photoFallbackEnabled;
  if (typeof photoFallbackEnabled !== 'boolean') {
    throw new HttpsError('invalid-argument', 'photoFallbackEnabled must be true or false.');
  }

  await db.collection(CONFIG).doc(COMPANY).set(
    {
      photoFallbackEnabled,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: caller.uid,
    },
    { merge: true },
  );

  await writeAudit({
    action: 'settings.update',
    actorUid: caller.uid,
    actorEmail: caller.email,
    ip: callerIp(request),
    details: { photoFallbackEnabled },
  });

  return { ok: true, photoFallbackEnabled };
});
