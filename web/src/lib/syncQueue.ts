import { api, errorMessage } from './api';
import { uploadPhoto } from './photo';
import {
  dequeue,
  isAlreadySubmitted,
  isOfflineError,
  listQueued,
  markAttempt,
  type PendingPunch,
} from './offlineQueue';

/**
 * Drains the offline punch queue.
 *
 * Runs on app start, whenever the browser reports it is back online, and after
 * any punch the worker makes. Deliberately sequential and in capture order: a
 * clock-in has to be accepted before its matching clock-out, and the server
 * refuses a second open shift, so parallelism here would just manufacture
 * failures.
 */

export interface SyncResult {
  synced: number;
  remaining: number;
  failed: { punch: PendingPunch; message: string }[];
}

let running = false;

export async function syncPendingPunches(uid: string): Promise<SyncResult> {
  // A second caller would race the first over the same queue entries; the
  // `finally` below guarantees the flag is cleared even on an unexpected throw.
  if (running) return { synced: 0, remaining: await countQuietly(), failed: [] };
  running = true;

  const failed: SyncResult['failed'] = [];
  let synced = 0;

  try {
    const queued = await listQueued();

    for (const punch of queued) {
      try {
        let photoPath: string | null = null;
        if (punch.photo) {
          photoPath = await uploadPhoto(uid, {
            blob: punch.photo,
            previewUrl: '',
            originalBytes: punch.photo.size,
            bytes: punch.photo.size,
            looksPreExisting: false,
          });
        }

        const payload = {
          jobSiteId: punch.jobSiteId,
          location: punch.location,
          locationError: punch.locationError,
          photoPath,
          device: punch.device,
          offlineCapturedAt: punch.capturedAt,
          clientRequestId: punch.id,
        };

        if (punch.action === 'in') {
          await api.clockIn(payload);
        } else {
          await api.clockOut(payload);
        }

        await dequeue(punch.id);
        synced += 1;
      } catch (err) {
        if (isAlreadySubmitted(err)) {
          // A previous attempt got through and we never heard the answer.
          await dequeue(punch.id);
          synced += 1;
          continue;
        }

        if (isOfflineError(err)) {
          // Still no signal. Leave the rest of the queue alone and try later —
          // hammering a dead connection drains the battery for nothing.
          await markAttempt(punch.id, 'Waiting for a connection');
          break;
        }

        // The server made a decision and it was no. Keeping this queued would
        // retry it forever, so drop it and surface the reason to the worker.
        const message = errorMessage(err);
        await dequeue(punch.id);
        failed.push({ punch, message });
      }
    }
  } finally {
    running = false;
  }

  return { synced, remaining: await countQuietly(), failed };
}

async function countQuietly(): Promise<number> {
  try {
    return (await listQueued()).length;
  } catch {
    return 0;
  }
}
