import { POLICY } from './policy';

export interface LocationFix {
  lat: number;
  lng: number;
  accuracy: number;
  capturedAt: number;
  altitude: number | null;
  altitudeAccuracy: number | null;
  heading: number | null;
  speed: number | null;
}

export type LocationFailureKind =
  | 'unsupported'
  | 'insecure-context'
  | 'permission-denied'
  | 'unavailable'
  | 'timeout'
  | 'inaccurate';

export interface LocationFailure {
  kind: LocationFailureKind;
  code: number | null;
  message: string;
  /** The best fix we managed to get, if any. Sent along for the audit trail. */
  bestEffort: LocationFix | null;
}

export type LocationResult =
  | { ok: true; fix: LocationFix }
  | { ok: false; failure: LocationFailure };

function toFix(position: GeolocationPosition): LocationFix {
  const c = position.coords;
  return {
    lat: c.latitude,
    lng: c.longitude,
    accuracy: Number.isFinite(c.accuracy) ? c.accuracy : Number.POSITIVE_INFINITY,
    capturedAt: position.timestamp,
    altitude: c.altitude ?? null,
    altitudeAccuracy: c.altitudeAccuracy ?? null,
    heading: c.heading ?? null,
    speed: c.speed ?? null,
  };
}

/** Human-readable explanation, used verbatim in the UI. */
export function describeFailure(failure: LocationFailure): string {
  switch (failure.kind) {
    case 'unsupported':
      return 'This browser cannot provide your location.';
    case 'insecure-context':
      return 'Location only works over a secure (https) connection.';
    case 'permission-denied':
      return 'Location permission is turned off for this site.';
    case 'unavailable':
      return 'Your device could not get a location fix — usually no GPS signal indoors.';
    case 'timeout':
      return 'Getting your location took too long.';
    case 'inaccurate':
      return `Your location was only accurate to about ${Math.round(
        failure.bestEffort?.accuracy ?? 0,
      )} m, which is not precise enough to prove you are on site.`;
    default:
      return 'Your location could not be confirmed.';
  }
}

/** Step-by-step instructions for re-enabling location, tailored to the device. */
export function permissionHelp(): string[] {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);

  if (isIOS) {
    return [
      'Open Settings → Privacy & Security → Location Services and make sure it is on.',
      'Scroll to your browser (Safari or Chrome) and choose "While Using the App".',
      'Also turn on "Precise Location" for that browser.',
      'Return here and tap Retry.',
    ];
  }
  if (isAndroid) {
    return [
      'Swipe down and check that Location is switched on in quick settings.',
      'Open Settings → Apps → your browser → Permissions → Location and allow it.',
      'In the browser, tap the padlock in the address bar and allow Location for this site.',
      'Return here and tap Retry.',
    ];
  }
  return [
    'Click the padlock or location icon in your browser\'s address bar.',
    'Set Location to "Allow" for this site, then reload the page.',
    'On a desktop machine location is often too imprecise regardless — use a phone on site.',
  ];
}

export async function checkPermissionState(): Promise<PermissionState | 'unknown'> {
  if (!('permissions' in navigator) || !navigator.permissions?.query) return 'unknown';
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return status.state;
  } catch {
    return 'unknown';
  }
}

export interface AcquireOptions {
  /** Stop early once a fix at least this good arrives. */
  targetAccuracy?: number;
  /** Give up after this long. */
  timeoutMs?: number;
  /** Called with each improved fix so the UI can show progress. */
  onProgress?: (fix: LocationFix) => void;
  signal?: AbortSignal;
}

/**
 * Gets the best location fix the device can manage within the time budget.
 *
 * `watchPosition` rather than a single `getCurrentPosition` on purpose: the
 * first fix a phone hands back is usually a cached wifi/cell estimate accurate
 * to hundreds of metres, and the real GPS fix lands a few seconds later. Taking
 * the first answer would push honest workers onto the photo fallback constantly.
 * So we watch, keep the best fix seen, and return as soon as it is good enough.
 */
export function acquireLocation(options: AcquireOptions = {}): Promise<LocationResult> {
  const targetAccuracy = options.targetAccuracy ?? POLICY.maxAccuracyMeters;
  const timeoutMs = options.timeoutMs ?? 20000;

  return new Promise<LocationResult>((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve({
        ok: false,
        failure: { kind: 'unsupported', code: null, message: 'Geolocation API missing', bestEffort: null },
      });
      return;
    }

    // Browsers block geolocation outside a secure context, and it is a common
    // self-inflicted problem when someone serves the app over plain http.
    if (!window.isSecureContext) {
      resolve({
        ok: false,
        failure: {
          kind: 'insecure-context',
          code: null,
          message: 'Not a secure context',
          bestEffort: null,
        },
      });
      return;
    }

    let best: LocationFix | null = null;
    let settled = false;
    let watchId: number | null = null;
    let timer: number | null = null;

    const cleanup = () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (timer !== null) window.clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const finish = (result: LocationResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    function onAbort() {
      finish({
        ok: false,
        failure: { kind: 'timeout', code: null, message: 'Cancelled', bestEffort: best },
      });
    }
    options.signal?.addEventListener('abort', onAbort);

    watchId = navigator.geolocation.watchPosition(
      (position) => {
        const fix = toFix(position);
        if (!best || fix.accuracy < best.accuracy) {
          best = fix;
          options.onProgress?.(fix);
        }
        if (fix.accuracy <= targetAccuracy) {
          finish({ ok: true, fix });
        }
      },
      (err) => {
        // PERMISSION_DENIED is terminal; the others may still be followed by a
        // good fix, so only give up on them once the timeout expires.
        if (err.code === err.PERMISSION_DENIED) {
          finish({
            ok: false,
            failure: {
              kind: 'permission-denied',
              code: err.code,
              message: err.message,
              bestEffort: best,
            },
          });
        }
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );

    timer = window.setTimeout(() => {
      if (best && best.accuracy <= targetAccuracy) {
        finish({ ok: true, fix: best });
      } else if (best) {
        finish({
          ok: false,
          failure: {
            kind: 'inaccurate',
            code: null,
            message: `Best accuracy ${Math.round(best.accuracy)}m`,
            bestEffort: best,
          },
        });
      } else {
        finish({
          ok: false,
          failure: {
            kind: 'unavailable',
            code: null,
            message: 'No fix within the time limit',
            bestEffort: null,
          },
        });
      }
    }, timeoutMs);
  });
}
