import { FirebaseError } from 'firebase/app';
import type { LocationFailure } from './geolocation';

/** Converts the geolocation helper's failure shape into what a punch stores. */
export function toLocationError(failure: LocationFailure) {
  return { code: failure.code, message: `${failure.kind}: ${failure.message}` };
}

/**
 * Human-facing message for any error.
 *
 * Everything now goes straight to Firestore, so the errors that reach a worker
 * are Firestore's. The raw ones are useless on a job site — "Missing or
 * insufficient permissions" means nothing to somebody holding a phone — so the
 * few that actually happen get plain English and the rest get a safe fallback.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof FirebaseError) {
    switch (err.code) {
      case 'permission-denied':
        return 'You are not allowed to do that. If you think you should be, ask your supervisor.';
      case 'unavailable':
      case 'deadline-exceeded':
        return 'No connection right now. Check your signal and try again.';
      case 'unauthenticated':
      case 'auth/user-token-expired':
      case 'auth/requires-recent-login':
        return 'Your session expired. Please sign in again.';
      case 'auth/email-already-in-use':
        return 'That email address already has an account.';
      case 'auth/invalid-email':
        return 'That email address does not look right.';
      case 'auth/weak-password':
        return 'That password is too weak. Try a longer one.';
      case 'auth/network-request-failed':
        return 'No connection right now. Check your signal and try again.';
      case 'auth/too-many-requests':
        return 'Too many attempts. Wait a few minutes and try again.';
      case 'not-found':
        return 'That record no longer exists. Refresh and try again.';
      default:
        return err.message;
    }
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Please try again.';
}
