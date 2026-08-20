import { FirebaseError } from 'firebase/app';
import type { LocationFailure } from './geolocation';
import { reportError } from './report';

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
 *
 * Every error the app shows anybody passes through here, which makes it the one
 * place worth reporting from. What gets reported is filtered: a mistyped
 * password or a lost signal is the app working, and burying the real faults in
 * thousands of those would make the Problems tab useless.
 */
const EXPECTED = new Set([
  // The person, not the app.
  'auth/wrong-password',
  'auth/invalid-credential',
  'auth/user-not-found',
  'auth/invalid-email',
  'auth/weak-password',
  'auth/email-already-in-use',
  'auth/too-many-requests',
  'auth/user-token-expired',
  'auth/requires-recent-login',
  // A job site with one bar of signal, not a fault.
  'unavailable',
  'deadline-exceeded',
  'cancelled',
  'auth/network-request-failed',
]);

export function errorMessage(err: unknown): string {
  const code = err instanceof FirebaseError ? err.code : null;
  if (!code || !EXPECTED.has(code)) reportError(err, { kind: 'shown-to-user' });
  return describeError(err);
}

function describeError(err: unknown): string {
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
      case 'failed-precondition':
        // Firestore's own message for this is three lines of console URL. It
        // happens on the first run after a deploy that adds a report, and it
        // clears itself, so say that rather than making it look like a fault.
        return (
          'The database is still building an index for this report. It usually ' +
          'takes a few minutes after an update — wait, then try again.'
        );
      case 'aborted':
        return 'Someone else saved at the same moment. Try again.';
      default:
        return err.message;
    }
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Please try again.';
}
