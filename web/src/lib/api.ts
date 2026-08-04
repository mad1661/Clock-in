import { httpsCallable, FunctionsError } from 'firebase/functions';
import { functions } from '../firebase';
import type { LocationFix, LocationFailure } from './geolocation';
import type { PhotoRequiredDetail, Role } from './types';

function call<Req, Res>(name: string) {
  const fn = httpsCallable<Req, Res>(functions, name);
  return async (data: Req): Promise<Res> => (await fn(data)).data;
}

export interface ClockPayload {
  jobSiteId: string;
  /** Set only for a punch captured with no signal and replayed later. */
  offlineCapturedAt?: number;
  /** Idempotency key so a retried sync cannot punch twice. */
  clientRequestId?: string;
  location: LocationFix | null;
  locationError: { code: number | null; message: string } | null;
  photoPath: string | null;
  device: Record<string, unknown>;
  note?: string;
}

export interface ClockResult {
  shiftId: string;
  at: number;
  method: 'gps' | 'photo';
  jobSiteName?: string;
  distanceMeters?: number | null;
  durationMinutes?: number;
  needsReview: boolean;
  flags: string[];
}

export const api = {
  bootstrapAdmin: call<{ displayName?: string }, { ok: boolean; uid: string; email: string }>(
    'bootstrapAdmin',
  ),
  createWorker: call<
    { email: string; displayName: string; role: Role; jobSiteIds: string[] },
    { uid: string; email: string; displayName: string; role: Role; temporaryPassword: string }
  >('createWorker'),
  updateWorker: call<
    { uid: string; displayName?: string; role?: Role; jobSiteIds?: string[] },
    { ok: boolean }
  >('updateWorker'),
  setWorkerActive: call<{ uid: string; active: boolean }, { ok: boolean; active: boolean }>(
    'setWorkerActive',
  ),
  resetWorkerPassword: call<{ uid: string }, { temporaryPassword: string }>('resetWorkerPassword'),
  acknowledgePasswordChange: call<Record<string, never>, { ok: boolean }>(
    'acknowledgePasswordChange',
  ),
  upsertJobSite: call<
    {
      id?: string;
      name: string;
      address: string;
      lat: number;
      lng: number;
      radiusMeters: number;
      active: boolean;
    },
    { id: string }
  >('upsertJobSite'),
  deleteJobSite: call<{ id: string }, { ok: boolean }>('deleteJobSite'),
  clockIn: call<ClockPayload, ClockResult>('clockIn'),
  clockOut: call<ClockPayload, ClockResult>('clockOut'),
  reviewShift: call<
    { shiftId: string; decision: 'approved' | 'rejected'; note?: string },
    { ok: boolean }
  >('reviewShift'),
  requestShiftEdit: call<
    { shiftId: string; clockInAt?: number; clockOutAt?: number; reason: string },
    { ok: boolean }
  >('requestShiftEdit'),
  cancelShiftEdit: call<{ shiftId: string }, { ok: boolean }>('cancelShiftEdit'),
  reviewShiftEdit: call<
    { shiftId: string; decision: 'approved' | 'rejected'; note?: string },
    { ok: boolean }
  >('reviewShiftEdit'),
  adjustShift: call<
    { shiftId: string; clockInAt?: number; clockOutAt?: number; note: string },
    { ok: boolean }
  >('adjustShift'),
};

/** Converts the failure shape the geolocation helper returns into API input. */
export function toLocationError(failure: LocationFailure) {
  return { code: failure.code, message: `${failure.kind}: ${failure.message}` };
}

/**
 * True when the server is telling us the punch can still go through, but only
 * with a photo attached.
 */
export function photoRequiredDetail(err: unknown): PhotoRequiredDetail | null {
  if (!(err instanceof FunctionsError)) return null;
  const details = err.details as PhotoRequiredDetail | undefined;
  return details?.reason === 'PHOTO_REQUIRED' ? details : null;
}

/** Human-facing message for any error, without leaking internals. */
export function errorMessage(err: unknown): string {
  if (err instanceof FunctionsError) {
    if (err.code === 'functions/internal') {
      return 'Something went wrong on our side. Please try again.';
    }
    if (err.code === 'functions/unauthenticated') {
      return 'Your session expired. Please sign in again.';
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Please try again.';
}
