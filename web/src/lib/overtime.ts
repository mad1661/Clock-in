/**
 * California overtime, worked out per worker per week.
 *
 * California is unusual: overtime is driven by the *day* as well as the week,
 * so a crew that works four ten-hour days is owed 8 hours of overtime even
 * though the week totals 40. A tool that only totals the week gets that wrong
 * every time, and Chino is in California.
 *
 * The rules implemented (Labor Code §510, IWC orders):
 *   - over 8 hours in a workday        → 1.5x
 *   - over 12 hours in a workday       → 2x
 *   - over 40 straight-time hours in a workweek → 1.5x
 *   - 7th consecutive day worked: first 8 hours 1.5x, beyond 8 hours 2x
 *
 * NOT a payroll engine and NOT legal advice. It does not know about alternative
 * workweek agreements, exempt classifications, split shifts, reporting-time pay
 * or meal-period premiums. Treat the numbers as a cross-check against whoever
 * actually runs payroll — which is exactly what the UI says.
 */

export interface DayHours {
  /** Local date key, YYYY-MM-DD. */
  date: string;
  hours: number;
}

export interface OvertimeSplit {
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  totalHours: number;
}

const DAILY_OT_AFTER = 8;
const DAILY_DT_AFTER = 12;
const WEEKLY_OT_AFTER = 40;
const SEVENTH_DAY_DT_AFTER = 8;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Days are consecutive if each is exactly one calendar day after the last. */
function isConsecutive(previous: string, current: string): boolean {
  const prev = new Date(`${previous}T00:00:00`);
  const cur = new Date(`${current}T00:00:00`);
  return Math.round((cur.getTime() - prev.getTime()) / 86400000) === 1;
}

/** One day's hours, split the way a timecard column wants them. */
export interface DaySplit {
  date: string;
  hours: number;
  regular: number;
  overtime: number;
  doubleTime: number;
}

/**
 * Splits each day of one workweek into straight, time-and-a-half and
 * double-time hours. Pass the days of a single Monday-to-Sunday week.
 *
 * Kept per-day rather than only totalled because the weekly timecard prints a
 * REG/OVT/DBL column against every day, and those columns have to add up to
 * the same numbers {@link californiaOvertime} reports.
 */
export function californiaOvertimeByDay(days: DayHours[]): DaySplit[] {
  const worked = days
    .filter((d) => d.hours > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const splits: DaySplit[] = [];
  let consecutive = 0;
  let previousDate: string | null = null;

  for (const day of worked) {
    consecutive = previousDate && isConsecutive(previousDate, day.date) ? consecutive + 1 : 1;
    previousDate = day.date;

    if (consecutive >= 7) {
      // Seventh consecutive day: every hour is premium, the first eight at 1.5x
      // and the rest at 2x. No straight time accrues at all.
      splits.push({
        date: day.date,
        hours: day.hours,
        regular: 0,
        overtime: Math.min(day.hours, SEVENTH_DAY_DT_AFTER),
        doubleTime: Math.max(0, day.hours - SEVENTH_DAY_DT_AFTER),
      });
      continue;
    }

    splits.push({
      date: day.date,
      hours: day.hours,
      regular: Math.min(day.hours, DAILY_OT_AFTER),
      overtime: Math.max(0, Math.min(day.hours, DAILY_DT_AFTER) - DAILY_OT_AFTER),
      doubleTime: Math.max(0, day.hours - DAILY_DT_AFTER),
    });
  }

  // Weekly overtime applies to straight-time hours past 40. Hours already paid
  // as daily overtime are not counted again — that would be pyramiding, which
  // California does not allow. The excess is taken from the days it was worked:
  // whatever straight time lands after the week's 40th hour becomes overtime.
  let straightSoFar = 0;
  for (const split of splits) {
    straightSoFar += split.regular;
    const over = Math.min(split.regular, Math.max(0, straightSoFar - WEEKLY_OT_AFTER));
    if (over > 0) {
      split.regular -= over;
      split.overtime += over;
    }
    split.regular = round2(split.regular);
    split.overtime = round2(split.overtime);
    split.doubleTime = round2(split.doubleTime);
  }

  return splits;
}

/**
 * Splits one workweek's daily totals into straight, time-and-a-half and
 * double-time hours. Pass the days of a single Monday-to-Sunday week.
 */
export function californiaOvertime(days: DayHours[]): OvertimeSplit {
  let regular = 0;
  let overtime = 0;
  let doubleTime = 0;
  for (const day of californiaOvertimeByDay(days)) {
    regular += day.regular;
    overtime += day.overtime;
    doubleTime += day.doubleTime;
  }

  return {
    regularHours: round2(regular),
    overtimeHours: round2(overtime),
    doubleTimeHours: round2(doubleTime),
    totalHours: round2(regular + overtime + doubleTime),
  };
}

/** Local YYYY-MM-DD for a Date, matching how the timesheet groups days. */
export function dateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Monday-starting week key. The yard's workweek runs Monday to Sunday, and the
 * weekly 40-hour threshold has to be counted over the same seven days the
 * timecard prints, or the two would disagree about the same week.
 */
export function weekKey(d: Date): string {
  const start = new Date(d);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  start.setHours(0, 0, 0, 0);
  return dateKey(start);
}

export interface WorkerOvertime {
  userId: string;
  displayName: string;
  split: OvertimeSplit;
}

/**
 * Rolls shifts up per worker, splitting overtime week by week so a date range
 * spanning several weeks does not smear the 40-hour threshold across them.
 */
export function overtimeByWorker(
  shifts: { userId: string; userDisplayName: string; clockInAt: { toDate(): Date }; durationMinutes: number | null }[],
): WorkerOvertime[] {
  // userId -> week -> day -> hours
  const byWorker = new Map<string, { name: string; weeks: Map<string, Map<string, number>> }>();

  for (const shift of shifts) {
    if (!shift.durationMinutes) continue;
    const start = shift.clockInAt.toDate();
    const worker = byWorker.get(shift.userId) ?? {
      name: shift.userDisplayName,
      weeks: new Map<string, Map<string, number>>(),
    };
    const week = worker.weeks.get(weekKey(start)) ?? new Map<string, number>();
    const key = dateKey(start);
    week.set(key, (week.get(key) ?? 0) + shift.durationMinutes / 60);
    worker.weeks.set(weekKey(start), week);
    byWorker.set(shift.userId, worker);
  }

  const results: WorkerOvertime[] = [];
  for (const [userId, worker] of byWorker) {
    const totals: OvertimeSplit = {
      regularHours: 0,
      overtimeHours: 0,
      doubleTimeHours: 0,
      totalHours: 0,
    };
    for (const week of worker.weeks.values()) {
      const split = californiaOvertime([...week.entries()].map(([date, hours]) => ({ date, hours })));
      totals.regularHours += split.regularHours;
      totals.overtimeHours += split.overtimeHours;
      totals.doubleTimeHours += split.doubleTimeHours;
      totals.totalHours += split.totalHours;
    }
    results.push({
      userId,
      displayName: worker.name,
      split: {
        regularHours: round2(totals.regularHours),
        overtimeHours: round2(totals.overtimeHours),
        doubleTimeHours: round2(totals.doubleTimeHours),
        totalHours: round2(totals.totalHours),
      },
    });
  }

  return results.sort((a, b) => a.displayName.localeCompare(b.displayName));
}
