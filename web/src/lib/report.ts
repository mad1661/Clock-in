import { collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { describeDevice } from './device';

/**
 * Problem reports.
 *
 * With no server there is nothing watching the app run, so a worker who hits a
 * fault on a job site either rings somebody or — much more likely — shrugs and
 * stops using it. This writes what went wrong straight to Firestore, where the
 * Problems tab shows it grouped by fault rather than by occurrence.
 *
 * Three things are deliberate:
 *
 *   1. It never throws and never blocks. Reporting a fault must not become a
 *      second fault, and a punch must never fail because logging it failed.
 *   2. It is heavily rate limited. A render loop can throw thousands of times a
 *      minute, and the free Firestore tier is 20,000 writes a day — the whole
 *      yard's punches could be crowded out by one broken phone.
 *   3. It carries no location, no hours and no customer detail. Who, what
 *      broke, which screen, which build, which handset. Nothing else.
 */

/** Distinct faults reported by this tab, so the same one is not sent twice. */
const seen = new Map<string, number>();

/** Total reports from this tab. A loop stops being informative long before this. */
const SESSION_CAP = 12;
/** The same fault again is only worth re-reporting after this long. */
const REPEAT_AFTER_MS = 10 * 60 * 1000;

let sent = 0;

/** The first frames of the stack, which is what makes two faults comparable. */
function shortStack(err: unknown): string | null {
  if (!(err instanceof Error) || !err.stack) return null;
  return err.stack.split('\n').slice(0, 12).join('\n').slice(0, 2000);
}

function codeOf(err: unknown): string | null {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : null;
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err).slice(0, 300);
  } catch {
    return String(err);
  }
}

/**
 * What makes two reports "the same problem".
 *
 * The message alone is too coarse — every permission failure in the app would
 * pile into one line. The stack alone is too fine, because line numbers move
 * with every build. Message plus the topmost frame plus the screen is the
 * combination that groups a fault the way somebody investigating would.
 */
function fingerprint(message: string, code: string | null, stack: string | null, where: string) {
  const frame = stack?.split('\n')[1]?.trim().replace(/:\d+:\d+\)?$/, '') ?? '';
  // Ids, uuids and numbers vary per occurrence and would split one fault into
  // dozens of groups.
  const generalised = message.replace(/\b[0-9a-f]{8,}\b/gi, '#').replace(/\d+/g, 'n');
  return [code ?? '', generalised, frame, where].join('|').slice(0, 300);
}

/**
 * Records a problem. Safe to call from anywhere, including a catch block that
 * is already handling the error for the person on screen.
 */
export function reportError(err: unknown, context: Record<string, unknown> = {}): void {
  void (async () => {
    try {
      const user = auth.currentUser;
      // Nothing to attribute it to and the rules would refuse the write anyway.
      // The console still has it for anybody watching.
      if (!user) return;
      if (sent >= SESSION_CAP) return;

      const message = messageOf(err).slice(0, 500);
      const code = codeOf(err);
      const stack = shortStack(err);
      const where = window.location.pathname;
      const key = fingerprint(message, code, stack, where);

      const last = seen.get(key);
      if (last != null && Date.now() - last < REPEAT_AFTER_MS) return;
      seen.set(key, Date.now());
      sent += 1;

      const device = describeDevice();
      await setDoc(doc(collection(db, 'errorLogs')), {
        fingerprint: key,
        message,
        code,
        stack,
        where,
        context,
        actorUid: user.uid,
        actorEmail: user.email ?? null,
        // Which build this phone was actually running. A stale service-worker
        // copy is a real cause of "it only happens to Pat".
        build: typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev',
        device: {
          id: device.id ?? null,
          userAgent: device.userAgent,
          platform: device.platform,
          screen: device.screen,
          language: device.language,
          timezone: device.timezone,
        },
        online: navigator.onLine,
        resolved: false,
        at: serverTimestamp(),
      });
    } catch {
      /* Reporting a fault must never become a second one. */
    }
  })();
}

/**
 * Catches what no `try` block does: a render that throws, a promise nobody
 * awaited, a script that failed to load. Installed once, from main.tsx.
 */
export function installErrorReporting() {
  window.addEventListener('error', (event) => {
    // A file that failed to load fires this with no error object. Only code
    // counts: a missing script or stylesheet is what a half-deployed build or a
    // stale cached copy looks like, and it breaks the app. A missing image is
    // usually a map tile on one bar of signal, which is weather rather than a
    // fault — reporting those would bury the real ones.
    if (!event.error && event.target && event.target !== window) {
      const el = event.target as HTMLElement & { src?: string; href?: string };
      const tag = el.tagName?.toLowerCase();
      if (tag !== 'script' && tag !== 'link') return;
      reportError(new Error(`Failed to load ${tag}`), {
        kind: 'resource',
        url: el.src ?? el.href ?? null,
      });
      return;
    }
    reportError(event.error ?? new Error(event.message), { kind: 'uncaught' });
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, { kind: 'unhandled-rejection' });
  });
}
