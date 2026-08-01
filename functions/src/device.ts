import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { db } from './common';
import { FLAG, POLICY, type FlagCode } from './config';
import type { DeviceInput } from './types';

const DEVICES = 'devices';

/**
 * Turns a user-agent string into something a supervisor can read on a
 * timesheet — "iPhone · Safari" rather than 140 characters of boilerplate.
 *
 * Deliberately coarse. The point is to answer "what did they clock in on?" and
 * to make "that is not the phone they normally use" obvious at a glance, not to
 * fingerprint a browser build. The raw user agent is kept alongside this for
 * anyone who needs the detail.
 */
export function describeDeviceLabel(userAgent?: string, platform?: string): string {
  const ua = userAgent ?? '';
  if (!ua) return platform ? `Unknown (${platform})` : 'Unknown device';

  const os = (() => {
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/iPod/i.test(ua)) return 'iPod';
    if (/Android/i.test(ua)) {
      // Most Android UAs carry the model between the build info and ") AppleWebKit".
      const model = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?\)/i.exec(ua)?.[1]?.trim();
      const clean = model && !/^wv$/i.test(model) && model.length <= 40 ? model : null;
      return clean ? `Android (${clean})` : 'Android';
    }
    if (/Windows NT/i.test(ua)) return 'Windows PC';
    if (/CrOS/i.test(ua)) return 'Chromebook';
    if (/Mac OS X/i.test(ua)) return 'Mac';
    if (/Linux/i.test(ua)) return 'Linux PC';
    return 'Unknown device';
  })();

  // Order matters — every one of these UAs also contains "Safari", and most
  // contain "Chrome", so the more specific brands have to be tested first.
  const browser = (() => {
    if (/EdgA?\//i.test(ua)) return 'Edge';
    if (/SamsungBrowser\//i.test(ua)) return 'Samsung Internet';
    if (/OPR\/|Opera/i.test(ua)) return 'Opera';
    if (/FxiOS\/|Firefox\//i.test(ua)) return 'Firefox';
    if (/CriOS\//i.test(ua)) return 'Chrome';
    if (/Chrome\//i.test(ua)) return 'Chrome';
    if (/Safari\//i.test(ua)) return 'Safari';
    return null;
  })();

  return browser ? `${os} · ${browser}` : os;
}

/** Short, readable handle for a device id, e.g. "D-4F2A9C". */
export function shortDeviceId(deviceId?: string | null): string | null {
  if (!deviceId) return null;
  return `D-${deviceId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase()}`;
}

export function sanitiseDeviceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  // The client generates a UUID; anything wildly outside that shape is junk.
  if (!/^[a-zA-Z0-9._-]{8,64}$/.test(id)) return null;
  return id;
}

export interface DeviceOutcome {
  flags: FlagCode[];
  /** Who last used this device, when it was somebody else. */
  previousUserId: string | null;
}

/**
 * Records the device against this punch and reports whether it was just used by
 * a different employee.
 *
 * This is the buddy-punching check: two people clocking in minutes apart from
 * the same handset is the classic way hours get inflated, and it is invisible
 * unless something is tracking the device across workers. Sharing a phone is
 * not automatically dishonest — a crew lead may genuinely clock in a worker
 * whose battery died — so it flags for review rather than refusing the punch.
 */
export async function registerDevice(
  deviceId: string | null,
  uid: string,
  label: string,
  serverNowMs: number,
): Promise<DeviceOutcome> {
  if (!deviceId) return { flags: [], previousUserId: null };

  const ref = db.collection(DEVICES).doc(deviceId);

  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const flags: FlagCode[] = [];
      let previousUserId: string | null = null;

      if (snap.exists) {
        const data = snap.data() as {
          lastUserId?: string;
          lastSeenAt?: Timestamp;
          userIds?: string[];
        };
        const lastSeenMs = data.lastSeenAt?.toMillis() ?? 0;
        const withinWindow = serverNowMs - lastSeenMs < POLICY.sharedDeviceWindowHours * 3600 * 1000;

        if (data.lastUserId && data.lastUserId !== uid && withinWindow) {
          flags.push(FLAG.SHARED_DEVICE);
          previousUserId = data.lastUserId;
        }

        tx.update(ref, {
          label,
          lastUserId: uid,
          lastSeenAt: Timestamp.fromMillis(serverNowMs),
          userIds: FieldValue.arrayUnion(uid),
          punchCount: FieldValue.increment(1),
        });
      } else {
        tx.set(ref, {
          id: deviceId,
          label,
          firstSeenAt: Timestamp.fromMillis(serverNowMs),
          lastSeenAt: Timestamp.fromMillis(serverNowMs),
          lastUserId: uid,
          userIds: [uid],
          punchCount: 1,
        });
      }

      return { flags, previousUserId };
    });
  } catch (err) {
    // Device bookkeeping must never block someone from recording their hours.
    logger.error('Device registration failed', { deviceId, uid, err });
    return { flags: [], previousUserId: null };
  }
}

/** Normalises the untrusted device payload from the client. */
export function sanitiseDevice(raw: unknown): DeviceInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) =>
    typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;

  const userAgent = str(d.userAgent, 400);
  const platform = str(d.platform, 80);

  return {
    id: sanitiseDeviceId(d.id) ?? undefined,
    label: describeDeviceLabel(userAgent, platform),
    userAgent,
    platform,
    timezone: str(d.timezone, 80),
    screen: str(d.screen, 40),
    language: str(d.language, 40),
    clientTime:
      typeof d.clientTime === 'number' && Number.isFinite(d.clientTime) ? d.clientTime : undefined,
  };
}
