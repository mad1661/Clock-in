import type { Timestamp } from 'firebase/firestore';

export type Role = 'admin' | 'worker';

export interface UserDoc {
  uid: string;
  email: string;
  displayName: string;
  role: Role;
  active: boolean;
  jobSiteIds: string[];
  mustChangePassword: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface JobSite {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  active: boolean;
}

/** What the punch recorded about the handset it was made on. */
export interface DeviceRecord {
  /** Stable per-browser id; see lib/device.ts. */
  id?: string | null;
  /** Server-derived readable name, e.g. "iPhone / Safari". */
  label?: string | null;
  userAgent?: string | null;
  platform?: string | null;
  timezone?: string | null;
  screen?: string | null;
  language?: string | null;
  clientTime?: number | null;
}

/** A correction the worker has asked their supervisor to approve. */
export interface PendingEdit {
  requestedAt: Timestamp;
  requestedClockInAt: Timestamp;
  requestedClockOutAt: Timestamp | null;
  originalClockInAt: Timestamp;
  originalClockOutAt: Timestamp | null;
  reason: string;
}

/** How the most recent correction request was resolved. */
export interface EditOutcome {
  status: 'approved' | 'rejected' | 'withdrawn';
  reason: string;
  note: string | null;
  decidedBy: string | null;
  decidedAt: Timestamp;
  appliedClockInAt: Timestamp | null;
  appliedClockOutAt: Timestamp | null;
}

export interface PunchRecord {
  at: Timestamp;
  method: 'gps' | 'photo' | 'unverified';
  jobSiteId: string;
  jobSiteName: string;
  location: { lat: number; lng: number; accuracy: number; capturedAt: Timestamp } | null;
  locationError: { code: number | null; message: string | null } | null;
  /** The site's position and radius as they were at the moment of the punch. */
  site: { lat: number; lng: number; radiusMeters: number } | null;
  distanceMeters: number | null;
  withinGeofence: boolean | null;
  photoPath: string | null;
  flags: string[];
  ip: string | null;
  device: DeviceRecord | null;
  note: string | null;
  /** Present when the punch was captured with no signal and synced later. */
  offline: { capturedAt: Timestamp; syncedAt: Timestamp; delayMinutes: number } | null;
}

export interface Shift {
  id: string;
  userId: string;
  userDisplayName: string;
  userEmail: string;
  jobSiteId: string;
  jobSiteName: string;
  status: 'open' | 'closed';
  clockIn: PunchRecord;
  clockOut: PunchRecord | null;
  clockInAt: Timestamp;
  clockOutAt: Timestamp | null;
  durationMinutes: number | null;
  needsReview: boolean;
  flags: string[];
  review: {
    status: 'pending' | 'approved' | 'rejected';
    by: string | null;
    at: Timestamp | null;
    note: string | null;
  };
  pendingEdit: PendingEdit | null;
  hasPendingEdit: boolean;
  lastEdit: EditOutcome | null;
}

/** Extra data the server attaches when it refuses a punch. */
export interface PhotoRequiredDetail {
  reason: 'PHOTO_REQUIRED';
  flags: string[];
  distanceMeters: number | null;
  allowedRadiusMeters: number;
  accuracyMeters: number | null;
  jobSiteName: string;
}
