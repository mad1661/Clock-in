import type { Timestamp } from 'firebase/firestore';
import type { DailyTicket, Equipment, JobSite, Shift, TicketRow } from './types';

/**
 * Builds the Daily Rental Ticket from a day's shifts.
 *
 * The paper form has one line per operator per machine, with TWO in/out pairs
 * on it — that is the morning and the afternoon either side of lunch. This app
 * records each of those as its own shift, so a line is assembled by grouping a
 * worker's shifts for the day and laying them out in order.
 *
 * A worker who moves onto a second machine gets a second line, because the
 * ticket bills machine time and mixing two machines on one line would misstate
 * both.
 */

/**
 * Show-up pay: an operator who turns out at all is credited four hours, even if
 * the job sends them home after one. Applied per day, not per stint — someone
 * who works two hours in the morning and two in the afternoon has made their
 * four and is not credited eight.
 *
 * Machine hours are deliberately NOT floored this way. The hour meter reads
 * what the machine actually ran, and inflating it would overbill the customer.
 */
export const MIN_OPERATOR_HOURS = 4;

/** Local calendar day for a moment, as YYYY-MM-DD. */
export function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ticketId(jobSiteId: string, date: string): string {
  return `${jobSiteId}_${date}`;
}

/** Start and end of a local calendar day, for querying. */
export function dayBounds(date: string): { start: Date; end: Date } {
  const [y, m, d] = date.split('-').map(Number);
  return { start: new Date(y, m - 1, d, 0, 0, 0, 0), end: new Date(y, m - 1, d, 23, 59, 59, 999) };
}

function minutesBetween(a: Timestamp, b: Timestamp): number {
  return Math.max(0, Math.round((b.toMillis() - a.toMillis()) / 60000));
}

/**
 * Hours as the ticket writes them: to the nearest quarter, and a whole number
 * left whole. Payroll uses the exact minutes elsewhere; this is the customer's
 * copy, and quarter hours are what the yard has always billed.
 */
export function ticketHours(minutes: number): number {
  return Math.round((minutes / 60) * 4) / 4;
}

/** Hours credited to an operator, after show-up pay. */
export function operatorHoursFor(minutes: number): number {
  if (minutes <= 0) return 0;
  return Math.max(MIN_OPERATOR_HOURS, ticketHours(minutes));
}

export function buildTicketRows(shifts: Shift[], equipment: Equipment[]): TicketRow[] {
  const byId = new Map(equipment.map((e) => [e.id, e]));

  // One line per operator per machine. A worker with no machine recorded still
  // gets a line — their hours are real and the customer is still being billed
  // for them; the machine columns are simply left for the supervisor to write in.
  const lines = new Map<string, Shift[]>();
  for (const shift of shifts) {
    if (shift.status !== 'closed' || !shift.clockOutAt) continue;
    const key = `${shift.userId}|${shift.equipmentId ?? ''}`;
    const list = lines.get(key);
    if (list) list.push(shift);
    else lines.set(key, [shift]);
  }

  const rows: TicketRow[] = [];
  for (const group of lines.values()) {
    group.sort((a, b) => a.clockInAt.toMillis() - b.clockInAt.toMillis());
    const first = group[0];
    const machine = first.equipmentId ? byId.get(first.equipmentId) : undefined;

    const minutes = group.reduce(
      (sum, s) => sum + (s.durationMinutes ?? minutesBetween(s.clockInAt, s.clockOutAt!)),
      0,
    );

    // The form has room for two pairs. More than two stints in a day is rare
    // but real (a third trip out after dinner), so anything beyond the second
    // is folded into the second pair's end time rather than being dropped.
    const last = group[group.length - 1];
    const second = group.length > 1 ? group[1] : null;

    rows.push({
      userId: first.userId,
      operatorName: first.userDisplayName || first.userEmail,
      equipmentId: first.equipmentId ?? null,
      equipmentType: machine?.type ?? first.equipmentType ?? '',
      machineNo: machine?.machineNo ?? first.machineNo ?? '',
      // The hours actually worked, NOT the four-hour minimum: this stands in
      // for the hour meter, and a supervisor overwrites it when the machine ran
      // for less than the operator did — a breakdown, or waiting on another
      // trade. Billing the customer for machine time nobody had would be wrong.
      tractorHours: first.tractorHours ?? ticketHours(minutes),
      in1: first.clockInAt,
      out1: group[0].clockOutAt,
      in2: second ? second.clockInAt : null,
      out2: second ? last.clockOutAt : null,
      operatorHours: operatorHoursFor(minutes),
      shiftIds: group.map((s) => s.id),
    });
  }

  rows.sort((a, b) => {
    const t = (a.in1?.toMillis() ?? 0) - (b.in1?.toMillis() ?? 0);
    return t !== 0 ? t : a.operatorName.localeCompare(b.operatorName);
  });
  return rows;
}

/** A fresh ticket for a site and day, before anyone has edited it. */
export function draftTicket(
  site: JobSite,
  date: string,
  shifts: Shift[],
  equipment: Equipment[],
): Omit<DailyTicket, 'createdAt' | 'updatedAt'> {
  return {
    id: ticketId(site.id, date),
    ticketNumber: null,
    jobSiteId: site.id,
    jobSiteName: site.name,
    customer: site.customer ?? '',
    location: site.address ?? '',
    jobNumber: site.jobNumber ?? '',
    date,
    rows: buildTicketRows(shifts, equipment),
    comments: '',
    supervisorName: null,
    signedAt: null,
  };
}

/**
 * Folds already-entered supervisor data onto freshly derived rows.
 *
 * The rows come from the shifts, which can change after the ticket is first
 * opened — a correction gets approved, someone clocks out late. Re-deriving
 * keeps the ticket true to the timesheet; this keeps the hour-meter readings
 * the supervisor typed from being wiped out when that happens.
 */
export function mergeTicket(
  draft: Omit<DailyTicket, 'createdAt' | 'updatedAt'>,
  saved: DailyTicket | null,
): Omit<DailyTicket, 'createdAt' | 'updatedAt'> {
  if (!saved) return draft;
  const previous = new Map(
    saved.rows.map((r) => [`${r.userId}|${r.equipmentId ?? ''}`, r] as const),
  );
  return {
    ...draft,
    ticketNumber: saved.ticketNumber,
    comments: saved.comments,
    supervisorName: saved.supervisorName,
    signedAt: saved.signedAt,
    rows: draft.rows.map((row) => {
      const before = previous.get(`${row.userId}|${row.equipmentId ?? ''}`);
      return before?.tractorHours != null ? { ...row, tractorHours: before.tractorHours } : row;
    }),
  };
}
