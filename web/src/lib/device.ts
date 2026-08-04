const DEVICE_ID_KEY = 'coburn.deviceId';

/**
 * A stable identifier for this browser install.
 *
 * Not a security control — clearing site data mints a new one, and it is easy
 * to tamper with. Its job is to make an honest pattern visible: two workers
 * punching from the same handset within a shift is the classic shape of buddy
 * punching, and nothing else in the app would ever notice it. The server
 * flags that for a supervisor rather than refusing the punch, because sharing
 * a phone is often perfectly legitimate.
 */
export function getDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing && /^[a-zA-Z0-9._-]{8,64}$/.test(existing)) return existing;

    const fresh =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

    window.localStorage.setItem(DEVICE_ID_KEY, fresh);
    return fresh;
  } catch {
    // Private browsing with storage blocked. The punch still works; it just
    // cannot contribute to the shared-device check.
    return '';
  }
}

/**
 * Snapshot of the device, sent with every punch and stored on the shift.
 * The server derives the readable label from this — see functions/src/device.ts.
 */
export function describeDevice() {
  return {
    id: getDeviceId() || undefined,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: `${window.screen.width}x${window.screen.height}`,
    language: navigator.language,
    clientTime: Date.now(),
  };
}

/** Mirrors the server's short handle so both ends display the same thing. */
export function shortDeviceId(deviceId?: string | null): string | null {
  if (!deviceId) return null;
  return `D-${deviceId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase()}`;
}
