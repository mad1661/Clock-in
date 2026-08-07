import type { DocumentData, QueryDocumentSnapshot, DocumentSnapshot } from 'firebase/firestore';

/**
 * Reads a document, filling in server timestamps that have not landed yet.
 *
 * Every timestamp the app writes is a `serverTimestamp()` sentinel, and until
 * the server resolves it Firestore hands the local snapshot back with that
 * field set to **null**. The listener fires with that null immediately — so the
 * moment a worker clocks in, the screen tries to render a shift whose
 * `clockInAt` does not exist yet.
 *
 * Asking for an estimate gives the local clock's best guess instead of null,
 * replaced by the real server value a moment later. The alternative is a null
 * check on every timestamp in the app, and missing one is a blank screen.
 */
export function withTimestamps<T>(
  snap: QueryDocumentSnapshot<DocumentData> | DocumentSnapshot<DocumentData>,
): T {
  return { ...(snap.data({ serverTimestamps: 'estimate' }) as T), id: snap.id };
}
