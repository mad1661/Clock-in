import type { Timestamp } from 'firebase/firestore';
// Extensions written out because the unit tests run this file straight through
// Node's type stripping, which resolves imports the way the browser would.
import { californiaOvertime, californiaOvertimeByDay, type OvertimeSplit } from './overtime.ts';
import { dayKey, operatorHoursFor } from './ticket.ts';
import type { JobSite, Shift } from './types.ts';

/**
 * The weekly timecard.
 *
 * Hours worked at the yard are not billed to any customer, so they never
 * belong on a Daily Rental Ticket. What the office needs for those hours is
 * the paper weekly timecard — one employee, one Monday-to-Sunday week, signed —
 * because that is the document an auditor asks to see. This module decides
 * which sites' hours go that way and assembles the card from the same shifts
 * everything else is built from.
 */

/**
 * Sites whose hours go on weekly timecards instead of a daily rental ticket.
 *
 * Controlled by the checkbox on the job site ("Hours go on weekly timecards").
 * Until somebody has touched that checkbox, the yard is recognised by name, so
 * Coburn Yard behaves correctly from the day this ships rather than from the
 * day an admin finds the setting.
 */
export function isTimecardSite(site: Pick<JobSite, 'name' | 'timecardsOnly'>): boolean {
  if (typeof site.timecardsOnly === 'boolean') return site.timecardsOnly;
  return /coburn\s*yard/i.test(site.name);
}

/**
 * The Sunday that ends the Monday-to-Sunday week containing this date. The
 * paper form is headed "WEEK ENDING", and the yard's week ends on Sunday.
 */
export function weekEndingKey(d: Date): string {
  const end = new Date(d);
  const daysToSunday = (7 - end.getDay()) % 7;
  end.setDate(end.getDate() + daysToSunday);
  end.setHours(0, 0, 0, 0);
  return dayKey(end);
}

/** The seven day keys of a week, Monday first, given its ending Sunday. */
export function weekDayKeys(weekEnding: string): string[] {
  const [y, m, d] = weekEnding.split('-').map(Number);
  const days: string[] = [];
  for (let offset = 6; offset >= 0; offset--) {
    days.push(dayKey(new Date(y, m - 1, d - offset, 12)));
  }
  return days;
}

/** Start and end of a Monday-to-Sunday week, for querying shifts. */
export function weekBounds(weekEnding: string): { start: Date; end: Date } {
  const [y, m, d] = weekEnding.split('-').map(Number);
  return {
    start: new Date(y, m - 1, d - 6, 0, 0, 0, 0),
    end: new Date(y, m - 1, d, 23, 59, 59, 999),
  };
}

/** One printed line of the timecard: one day of the week. */
export interface TimecardDay {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  /** Paycheck hours, split by California's rules. All zero on a day off. */
  regular: number;
  overtime: number;
  doubleTime: number;
  /** Two in/out pairs, matching the paper form — morning and afternoon. */
  in1: Timestamp | null;
  out1: Timestamp | null;
  in2: Timestamp | null;
  out2: Timestamp | null;
  /** Machine numbers run that day, for the form's "Machine(s) Operated". */
  machines: string[];
  /** True while one of this day's stints has no clock-out yet. */
  stillOnTheClock: boolean;
}

/** One employee's card for one Monday-to-Sunday week. */
export interface Timecard {
  userId: string;
  name: string;
  /** The Sunday the week ends on, YYYY-MM-DD. */
  weekEnding: string;
  /** The site names the hours came from — the form's "JOB" line. */
  jobs: string[];
  /** Exactly seven entries, Monday first. */
  days: TimecardDay[];
  totals: OvertimeSplit;
}

/**
 * Builds one card per employee from a week's worth of yard shifts.
 *
 * The hours are paycheck hours, so they get the same treatment the rental
 * ticket gives an operator: quarter-hour rounding and the four-hour show-up
 * minimum, applied per day. Only finished stints count — someone still on the
 * clock appears with the finish time blank rather than with hours they have
 * not earned yet.
 */
export function buildTimecards(weekEnding: string, shifts: Shift[]): Timecard[] {
  const dayKeys = weekDayKeys(weekEnding);

  const byUser = new Map<string, Shift[]>();
  for (const shift of shifts) {
    const list = byUser.get(shift.userId);
    if (list) list.push(shift);
    else byUser.set(shift.userId, [shift]);
  }

  const cards: Timecard[] = [];
  for (const [userId, userShifts] of byUser) {
    userShifts.sort((a, b) => a.clockInAt.toMillis() - b.clockInAt.toMillis());

    const jobs = [...new Set(userShifts.map((s) => s.jobSiteName))];
    const dayHours: { date: string; hours: number }[] = [];
    const days: TimecardDay[] = [];

    for (const date of dayKeys) {
      const stints = userShifts.filter((s) => dayKey(s.clockInAt.toDate()) === date);
      const done = stints.filter((s) => s.clockOutAt);
      const minutes = done.reduce(
        (sum, s) =>
          sum +
          (s.durationMinutes ??
            Math.max(0, Math.round((s.clockOutAt!.toMillis() - s.clockInAt.toMillis()) / 60000))),
        0,
      );
      const hours = minutes > 0 ? operatorHoursFor(minutes) : 0;
      dayHours.push({ date, hours });

      // Like the rental ticket, the form has room for two in/out pairs. A rare
      // third stint folds into the second pair's end time rather than dropping.
      const first = stints[0] ?? null;
      const second = stints.length > 1 ? stints[1] : null;
      const last = stints.length > 0 ? stints[stints.length - 1] : null;

      days.push({
        date,
        regular: 0,
        overtime: 0,
        doubleTime: 0,
        in1: first?.clockInAt ?? null,
        out1: first?.clockOutAt ?? null,
        in2: second?.clockInAt ?? null,
        out2: second ? (last?.clockOutAt ?? null) : null,
        machines: [
          ...new Set(
            stints
              .map((s) => s.machineNo || s.equipmentType || '')
              .filter((label) => label !== ''),
          ),
        ],
        stillOnTheClock: stints.some((s) => !s.clockOutAt),
      });
    }

    const byDate = new Map(californiaOvertimeByDay(dayHours).map((s) => [s.date, s]));
    for (const day of days) {
      const split = byDate.get(day.date);
      if (!split) continue;
      day.regular = split.regular;
      day.overtime = split.overtime;
      day.doubleTime = split.doubleTime;
    }

    cards.push({
      userId,
      name: userShifts[0].userDisplayName || userShifts[0].userEmail,
      weekEnding,
      jobs,
      days,
      totals: californiaOvertime(dayHours),
    });
  }

  return cards.sort((a, b) => a.name.localeCompare(b.name));
}
