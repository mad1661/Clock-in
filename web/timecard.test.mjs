/**
 * Tests for the weekly timecard.
 *
 * This is the sheet handed to an auditor, so what is worth pinning down is the
 * week itself (Monday to Sunday, ending on the Sunday the form is headed with)
 * and the paycheck arithmetic: the four-hour show-up minimum, the daily and
 * weekly California splits, and that the seven printed rows add up to exactly
 * what the overtime summary reports.
 *
 *   npm --prefix web run test:timecard
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTimecards,
  isTimecardSite,
  weekBounds,
  weekDayKeys,
  weekEndingKey,
} from './src/lib/timecard.ts';

// Local-time stamps, because the card assigns a stint to a day the same way
// the rest of the app does: by the local calendar day it started on.
const at = (y, mo, d, h, m = 0) => {
  const date = new Date(y, mo - 1, d, h, m);
  return { toDate: () => date, toMillis: () => date.getTime() };
};

let n = 0;
function shift(over = {}) {
  return {
    id: `s${n++}`,
    userId: 'u1',
    userDisplayName: 'R. Florez',
    userEmail: 'rf@example.com',
    jobSiteId: 'yard',
    jobSiteName: 'Coburn Yard',
    status: 'closed',
    ...over,
  };
}

// 2026-09-07 is a Monday; that week ends Sunday 2026-09-13.

test('the week runs Monday to Sunday and ends on the Sunday', () => {
  assert.equal(weekEndingKey(new Date(2026, 8, 7)), '2026-09-13'); // Monday
  assert.equal(weekEndingKey(new Date(2026, 8, 9)), '2026-09-13'); // Wednesday
  assert.equal(weekEndingKey(new Date(2026, 8, 13)), '2026-09-13'); // Sunday stays put
  assert.equal(weekEndingKey(new Date(2026, 8, 14)), '2026-09-20'); // next Monday rolls over

  assert.deepEqual(weekDayKeys('2026-09-13'), [
    '2026-09-07',
    '2026-09-08',
    '2026-09-09',
    '2026-09-10',
    '2026-09-11',
    '2026-09-12',
    '2026-09-13',
  ]);

  const { start, end } = weekBounds('2026-09-13');
  assert.equal(start.getTime(), new Date(2026, 8, 7, 0, 0, 0, 0).getTime());
  assert.equal(end.getTime(), new Date(2026, 8, 13, 23, 59, 59, 999).getTime());
});

test('the yard is recognised by name until the flag says otherwise', () => {
  assert.equal(isTimecardSite({ name: 'Coburn Yard' }), true);
  assert.equal(isTimecardSite({ name: 'COBURN YARD' }), true);
  assert.equal(isTimecardSite({ name: 'Dock Street' }), false);
  // An explicit flag wins in both directions.
  assert.equal(isTimecardSite({ name: 'Coburn Yard', timecardsOnly: false }), false);
  assert.equal(isTimecardSite({ name: 'Dock Street', timecardsOnly: true }), true);
});

test('a plain week: seven rows, hours on the days worked', () => {
  const shifts = [];
  for (let d = 7; d <= 11; d++) {
    // Mon–Fri, 7:00–15:30 with a lunch split 12:00–12:30: 8h paid.
    shifts.push(
      shift({
        clockInAt: at(2026, 9, d, 7),
        clockOutAt: at(2026, 9, d, 12),
        durationMinutes: 300,
        machineNo: '140',
      }),
      shift({
        clockInAt: at(2026, 9, d, 12, 30),
        clockOutAt: at(2026, 9, d, 15, 30),
        durationMinutes: 180,
        machineNo: '657',
      }),
    );
  }

  const cards = buildTimecards('2026-09-13', shifts);
  assert.equal(cards.length, 1);
  const [card] = cards;

  assert.equal(card.name, 'R. Florez');
  assert.equal(card.weekEnding, '2026-09-13');
  assert.deepEqual(card.jobs, ['Coburn Yard']);
  assert.equal(card.days.length, 7);

  const monday = card.days[0];
  assert.equal(monday.regular, 8);
  assert.equal(monday.overtime, 0);
  // Two stints land in the form's two in/out pairs.
  assert.equal(monday.in1.toDate().getHours(), 7);
  assert.equal(monday.out1.toDate().getHours(), 12);
  assert.equal(monday.in2.toDate().getHours(), 12);
  assert.equal(monday.out2.toDate().getHours(), 15);
  assert.deepEqual(monday.machines, ['140', '657']);

  // Saturday and Sunday are off: printed blank, not zero-filled.
  assert.equal(card.days[5].regular, 0);
  assert.equal(card.days[5].in1, null);
  assert.equal(card.days[6].regular, 0);

  assert.equal(card.totals.regularHours, 40);
  assert.equal(card.totals.overtimeHours, 0);
});

test('daily overtime lands on the day it was worked', () => {
  const cards = buildTimecards('2026-09-13', [
    shift({
      clockInAt: at(2026, 9, 8, 6),
      clockOutAt: at(2026, 9, 8, 16),
      durationMinutes: 600,
    }),
  ]);
  const tuesday = cards[0].days[1];
  assert.equal(tuesday.regular, 8);
  assert.equal(tuesday.overtime, 2);
  assert.equal(cards[0].totals.overtimeHours, 2);
});

test('weekly overtime: hours past the 40th become OVT on the later days', () => {
  // Six 9-hour days: 8+1 daily each, then Saturday's straight time crosses 40.
  const shifts = [];
  for (let d = 7; d <= 12; d++) {
    shifts.push(
      shift({
        clockInAt: at(2026, 9, d, 7),
        clockOutAt: at(2026, 9, d, 16),
        durationMinutes: 540,
      }),
    );
  }
  const [card] = buildTimecards('2026-09-13', shifts);
  const saturday = card.days[5];
  assert.equal(saturday.regular, 0);
  assert.equal(saturday.overtime, 9);
  assert.equal(card.totals.regularHours, 40);
  assert.equal(card.totals.overtimeHours, 14);
  // The printed columns add up to the printed totals.
  const reg = card.days.reduce((s, day) => s + day.regular, 0);
  const ovt = card.days.reduce((s, day) => s + day.overtime, 0);
  assert.equal(reg, card.totals.regularHours);
  assert.equal(ovt, card.totals.overtimeHours);
});

test('show-up pay: turning out at all credits four hours, once per day', () => {
  const [card] = buildTimecards('2026-09-13', [
    shift({
      clockInAt: at(2026, 9, 7, 7),
      clockOutAt: at(2026, 9, 7, 8),
      durationMinutes: 60,
    }),
    shift({
      clockInAt: at(2026, 9, 7, 13),
      clockOutAt: at(2026, 9, 7, 14),
      durationMinutes: 60,
    }),
  ]);
  // Two one-hour stints in one day make the four-hour minimum once, not twice.
  assert.equal(card.days[0].regular, 4);
});

test('still on the clock: times print, hours wait', () => {
  const [card] = buildTimecards('2026-09-13', [
    shift({
      clockInAt: at(2026, 9, 7, 7),
      clockOutAt: null,
      durationMinutes: null,
      status: 'open',
    }),
  ]);
  const monday = card.days[0];
  assert.equal(monday.stillOnTheClock, true);
  assert.equal(monday.in1.toDate().getHours(), 7);
  assert.equal(monday.out1, null);
  assert.equal(monday.regular, 0);
});

test('one card per employee, sorted by name', () => {
  const cards = buildTimecards('2026-09-13', [
    shift({
      userId: 'u2',
      userDisplayName: 'Z. Adams',
      clockInAt: at(2026, 9, 7, 7),
      clockOutAt: at(2026, 9, 7, 15),
      durationMinutes: 480,
    }),
    shift({
      clockInAt: at(2026, 9, 7, 7),
      clockOutAt: at(2026, 9, 7, 15),
      durationMinutes: 480,
    }),
  ]);
  assert.deepEqual(
    cards.map((c) => c.name),
    ['R. Florez', 'Z. Adams'],
  );
});
