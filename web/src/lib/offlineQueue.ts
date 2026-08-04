import type { LocationFix } from './geolocation';

/**
 * Punches captured with no signal, held on the phone until it can reach the
 * server.
 *
 * A crew in a basement, a canyon, or a steel-framed building has no data
 * connection, and losing a whole day's hours because of that is the single most
 * likely way this app fails a real worker. So a punch that cannot be submitted
 * is written to IndexedDB — including the photo, as a blob — and replayed when
 * signal returns.
 *
 * IndexedDB rather than localStorage for two reasons: it survives the browser
 * being killed and the phone being rebooted, and it stores the photo blob
 * without base64-inflating it by a third.
 *
 * The honest cost: a synced punch carries a timestamp from the phone, which is
 * the one thing this app otherwise never trusts. The server bounds it to 24
 * hours, refuses future dates, and flags every one of them for a supervisor.
 */

const DB_NAME = 'coburn-clock';
const DB_VERSION = 1;
const STORE = 'pendingPunches';

export interface PendingPunch {
  id: string;
  action: 'in' | 'out';
  jobSiteId: string;
  jobSiteName: string;
  capturedAt: number;
  location: LocationFix | null;
  locationError: { code: number | null; message: string } | null;
  photo: Blob | null;
  device: Record<string, unknown>;
  /** Bumped each time a sync attempt fails, for the UI and for backoff. */
  attempts: number;
  lastError: string | null;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local storage'));
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = fn(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Local storage error'));
  });
}

export function newPunchId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export async function enqueue(punch: PendingPunch): Promise<void> {
  await tx('readwrite', (store) => store.put(punch));
}

export async function listQueued(): Promise<PendingPunch[]> {
  const all = await tx<PendingPunch[]>('readonly', (store) => store.getAll() as IDBRequest<PendingPunch[]>);
  // Replay in the order they happened, so a clock-in never lands after its
  // matching clock-out.
  return all.sort((a, b) => a.capturedAt - b.capturedAt);
}

export async function dequeue(id: string): Promise<void> {
  await tx('readwrite', (store) => store.delete(id));
}

export async function markAttempt(id: string, error: string): Promise<void> {
  const existing = await tx<PendingPunch | undefined>(
    'readonly',
    (store) => store.get(id) as IDBRequest<PendingPunch | undefined>,
  );
  if (!existing) return;
  await enqueue({ ...existing, attempts: existing.attempts + 1, lastError: error });
}

export async function queueSize(): Promise<number> {
  try {
    return (await listQueued()).length;
  } catch {
    return 0;
  }
}

/**
 * True when the failure was the network rather than the server saying no.
 *
 * The distinction matters: a punch rejected because the worker is outside the
 * geofence must NOT be queued and retried — the server already had its say, and
 * silently resubmitting it later would be both wrong and confusing. Only a
 * request that never got an answer is worth holding on to.
 */
export function isOfflineError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;

  const code = (err as { code?: string })?.code ?? '';
  // Firebase surfaces a dead connection as `internal` or `unavailable`; every
  // other code is a decision the server actually made.
  if (code === 'functions/unavailable' || code === 'functions/deadline-exceeded') return true;
  if (code === 'functions/internal') {
    const message = String((err as { message?: string })?.message ?? '').toLowerCase();
    return (
      message.includes('network') ||
      message.includes('fetch') ||
      message.includes('failed to reach') ||
      message.includes('timeout')
    );
  }
  return err instanceof TypeError; // fetch() itself failed
}

/** True when the server has already accepted this punch under this id. */
export function isAlreadySubmitted(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  const details = (err as { details?: { reason?: string } })?.details;
  return code === 'functions/already-exists' || details?.reason === 'ALREADY_SUBMITTED';
}
