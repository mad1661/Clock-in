import { Timestamp } from 'firebase-admin/firestore';
import type { FlagCode } from './config';

export type Role = 'admin' | 'worker';

export interface UserDoc {
  uid: string;
  email: string;
  displayName: string;
  role: Role;
  active: boolean;
  /** Empty array means "may clock in at any active site". */
  jobSiteIds: string[];
  createdAt: Timestamp;
  createdBy: string | null;
  updatedAt: Timestamp;
  mustChangePassword: boolean;
}

export interface JobSiteDoc {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  active: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** A location fix as reported by the browser's Geolocation API. */
export interface LocationInput {
  lat: number;
  lng: number;
  accuracy: number;
  /** Epoch ms from `GeolocationPosition.timestamp`. */
  capturedAt: number;
  altitude?: number | null;
  altitudeAccuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
}

/** What the client tells us about the device. Untrusted; recorded for audit. */
export interface DeviceInput {
  userAgent?: string;
  platform?: string;
  timezone?: string;
  screen?: string;
  language?: string;
  /** Client wall clock at submit time, epoch ms. Compared to server time. */
  clientTime?: number;
}

export interface ClockRequest {
  jobSiteId: string;
  location?: LocationInput | null;
  /** Why the browser could not produce a fix, if it could not. */
  locationError?: { code?: number; message?: string } | null;
  /** Storage path of the proof photo, when falling back. */
  photoPath?: string | null;
  device?: DeviceInput;
  note?: string;
}

/** The verified, server-computed record of one clock action. */
export interface PunchRecord {
  at: Timestamp;
  method: 'gps' | 'photo';
  jobSiteId: string;
  jobSiteName: string;
  location: {
    lat: number;
    lng: number;
    accuracy: number;
    capturedAt: Timestamp;
  } | null;
  locationError: { code: number | null; message: string | null } | null;
  distanceMeters: number | null;
  withinGeofence: boolean | null;
  photoPath: string | null;
  flags: FlagCode[];
  ip: string | null;
  device: DeviceInput | null;
  note: string | null;
}

export interface ShiftDoc {
  id: string;
  userId: string;
  userDisplayName: string;
  userEmail: string;
  jobSiteId: string;
  jobSiteName: string;
  status: 'open' | 'closed';
  clockIn: PunchRecord;
  clockOut: PunchRecord | null;
  /** Denormalised for range queries and index efficiency. */
  clockInAt: Timestamp;
  clockOutAt: Timestamp | null;
  durationMinutes: number | null;
  /** True while any flag is unresolved. Drives the admin review queue. */
  needsReview: boolean;
  flags: FlagCode[];
  review: {
    status: 'pending' | 'approved' | 'rejected';
    by: string | null;
    at: Timestamp | null;
    note: string | null;
  };
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
