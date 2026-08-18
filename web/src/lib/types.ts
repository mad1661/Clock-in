import type { Timestamp } from 'firebase/firestore';

export type Role = 'admin' | 'worker';

export interface UserDoc {
  uid: string;
  email: string;
  displayName: string;
  role: Role;
  active: boolean;
  jobSiteIds: string[];
  /** The machines this operator usually runs; preselected when they clock in. */
  equipmentIds?: string[];
  mustChangePassword: boolean;
  /** Pay rate in dollars per hour. Internal — never printed on a customer's ticket. */
  hourlyRate?: number | null;
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
  /** Who the work is billed to — the "Customer" line on the rental ticket. */
  customer?: string;
  /** The customer's job number, if they issue one. */
  jobNumber?: string;
  /** Machines available at this site. Editable before or after the job runs. */
  equipmentIds?: string[];
}

/**
 * A machine in the yard.
 *
 * `type` and `machineNo` are what the rental ticket prints, and together they
 * are how the yard actually refers to a machine — "D8T-2", "637-21".
 */
export interface Equipment {
  id: string;
  type: string;
  machineNo: string;
  description?: string;
  active: boolean;
  /** What the customer is charged per hour for this machine. */
  hourlyRate?: number | null;
  updatedAt?: Timestamp;
}

/** "D8T-2", or just the type when a machine has no number. */
export function equipmentLabel(e: { type: string; machineNo?: string | null }): string {
  return e.machineNo ? `${e.type}-${e.machineNo}` : e.type;
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
  /** Which machine the operator ran, recorded when they clocked in. */
  equipmentId?: string | null;
  equipmentType?: string | null;
  machineNo?: string | null;
  /** Hour-meter reading for the machine, entered by the operator on clock-out. */
  tractorHours?: number | null;
}

/** One printed line of the daily rental ticket: one operator on one machine. */
export interface TicketRow {
  userId: string;
  operatorName: string;
  equipmentId: string | null;
  equipmentType: string;
  machineNo: string;
  tractorHours: number | null;
  /** Two in/out pairs, because the paper form has two — morning and afternoon. */
  in1: Timestamp | null;
  out1: Timestamp | null;
  in2: Timestamp | null;
  out2: Timestamp | null;
  operatorHours: number;
  /** True while one of this line's stints has no clock-out yet. */
  stillOnTheClock?: boolean;
  /** The shifts this line was built from, so the ticket can be traced back. */
  shiftIds: string[];
}

/**
 * The Daily Rental Ticket & Equipment Report — one per job site per day, the
 * document handed to the customer.
 *
 * Rows are derived from the shifts, then a supervisor fills in the hour-meter
 * readings and any downtime and signs it. Kept as its own record rather than
 * regenerated on demand so that what was given to the customer stays exactly
 * as it was given, even if a shift is corrected afterwards.
 */
export interface DailyTicket {
  id: string;
  ticketNumber: number | null;
  jobSiteId: string;
  jobSiteName: string;
  customer: string;
  location: string;
  jobNumber: string;
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  rows: TicketRow[];
  comments: string;
  supervisorName: string | null;
  signedAt: Timestamp | null;
  /**
   * The supervisor's actual signature, as stroke paths in a 600×200 space.
   *
   * Stored on the ticket rather than in Cloud Storage, which this plan does not
   * have. Strokes rather than a bitmap: a few kilobytes instead of tens, and it
   * stays sharp when the ticket is printed.
   */
  signature: { paths: string[]; width: number; height: number } | null;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
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
