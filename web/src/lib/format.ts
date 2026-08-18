import type { Timestamp } from 'firebase/firestore';

const dateTime = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const timeOnly = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dateOnly = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export const fmtDateTime = (ts?: Timestamp | null) => (ts ? dateTime.format(ts.toDate()) : '—');
export const fmtTime = (ts?: Timestamp | null) => (ts ? timeOnly.format(ts.toDate()) : '—');
export const fmtDate = (ts?: Timestamp | null) => (ts ? dateOnly.format(ts.toDate()) : '—');

export function fmtDuration(minutes?: number | null): string {
  if (minutes === null || minutes === undefined) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function fmtDistance(meters?: number | null): string {
  if (meters === null || meters === undefined) return '—';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** Live elapsed time since a start instant, as h:mm:ss. */
export function elapsedSince(startMs: number, nowMs: number): string {
  const total = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const clock = `${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  // Past a day, "76:04:11" reads as a typo. Somebody who forgot to clock out on
  // Monday should be obviously three days stale at a glance.
  if (h >= 24) return `${Math.floor(h / 24)}d ${clock}`;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` in the browser's local timezone, for date inputs. */
export function localDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `YYYY-MM-DDTHH:mm` in local time, for datetime-local inputs. */
export function localDateTimeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${localDateInput(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
