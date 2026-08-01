import { createHash } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { db, storage } from './common';
import { POLICY } from './config';

const PHOTO_CLAIMS = 'photoClaims';

export interface VerifiedPhoto {
  path: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: number;
}

/**
 * Verifies a fallback photo against the copy in Cloud Storage, not against
 * anything the client said about it.
 *
 * The checks that matter:
 *  - the path is inside the caller's own prefix (no pointing at someone else's
 *    photo from last week);
 *  - the object really exists and is an image within the size cap;
 *  - Storage's own `timeCreated` is seconds old, so the photo was taken and
 *    uploaded as part of *this* clock action rather than pulled from the
 *    camera roll and re-sent;
 *  - the path has never backed another punch, enforced by a create-only claim
 *    document, so one photo cannot cover both a clock-in and a clock-out.
 */
export async function verifyPhoto(
  uid: string,
  rawPath: unknown,
  serverNowMs: number,
): Promise<VerifiedPhoto> {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'A proof photo is required but none was supplied.');
  }
  const path = rawPath.trim();

  const expectedPrefix = `clock-photos/${uid}/`;
  if (!path.startsWith(expectedPrefix) || path.includes('..')) {
    throw new HttpsError('permission-denied', 'That photo does not belong to your account.');
  }

  const file = storage.bucket().file(path);

  let exists = false;
  let metadata: Record<string, unknown> = {};
  try {
    const [isThere] = await file.exists();
    exists = isThere;
    if (exists) {
      const [meta] = await file.getMetadata();
      metadata = meta as unknown as Record<string, unknown>;
    }
  } catch (err) {
    logger.error('Failed to read photo metadata', { path, err });
    throw new HttpsError('internal', 'Could not verify the photo. Please try again.');
  }

  if (!exists) {
    throw new HttpsError(
      'failed-precondition',
      'The photo did not finish uploading. Check your signal and try again.',
    );
  }

  const contentType = String(metadata.contentType ?? '');
  if (!contentType.startsWith('image/')) {
    throw new HttpsError('invalid-argument', 'The proof of presence must be a photo.');
  }

  const sizeBytes = Number(metadata.size ?? 0);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > POLICY.maxPhotoBytes) {
    throw new HttpsError('invalid-argument', 'That photo is empty or too large.');
  }

  const uploadedAt = Date.parse(String(metadata.timeCreated ?? ''));
  if (!Number.isFinite(uploadedAt)) {
    throw new HttpsError('internal', 'Could not read the photo upload time.');
  }

  const ageMs = serverNowMs - uploadedAt;
  // A small negative age is just clock jitter between Storage and this function.
  if (ageMs > POLICY.maxPhotoAgeMs || ageMs < -60_000) {
    throw new HttpsError(
      'failed-precondition',
      'That photo is not recent enough. Take a new one at the job site.',
    );
  }

  await claimPhoto(path, uid);

  return { path, contentType, sizeBytes, uploadedAt };
}

/**
 * Burns the photo so it can back exactly one punch.
 * `create()` fails if the document exists, which makes this atomic without a
 * transaction.
 */
async function claimPhoto(path: string, uid: string): Promise<void> {
  const id = createHash('sha256').update(path).digest('hex');
  try {
    await db.collection(PHOTO_CLAIMS).doc(id).create({
      path,
      uid,
      claimedAt: new Date(),
    });
  } catch (err: unknown) {
    // ALREADY_EXISTS is gRPC status 6.
    const code = (err as { code?: number })?.code;
    if (code === 6) {
      throw new HttpsError(
        'failed-precondition',
        'That photo has already been used. Please take a new one.',
      );
    }
    throw err;
  }
}
