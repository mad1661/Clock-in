/**
 * Tests for the daily rental ticket.
 *
 * This is the document the customer is billed from, so the arithmetic in it is
 * worth pinning down: the four-hour minimum, the two in/out pairs, and the rule
 * that machine hours are never inflated to match operator hours.
 *
 *   npm --prefix web run test:ticket
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// The module imports firebase/firestore only for the Timestamp type, so a
// stand-in with the two methods the builder uses keeps this a plain unit test.
const ts = (h, m = 0) => {
  const ms = Date.UTC(2026, 7, 3, h, m) ;
  return { toMillis: () => ms };
};

import { buildTicketRows, ticketHours, operatorHoursFor } from './src/lib/ticket.ts';

function shift(over = {}) {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    userId: 'u1',
    userDisplayName: 'B. Kuntz',
    userEmail: 'bk@example.com',
    status: 'closed',
    clockInAt: ts(7),
    clockOutAt: ts(12),
    durationMinutes: 300,
    equipmentId: 'e1',
    ...over,
  };
}

const EQUIP = [{ id: 'e1', type: 'D8T', machineNo: '2', active: true }];

test('quarter hours', () => {
  assert.equal(ticketHours(480), 8);
  assert.equal(ticketHours(300), 5);
  assert.equal(ticketHours(310), 5.25);
});

test('an operator who turns out at all is credited four hours', () => {
  assert.equal(operatorHoursFor(60), 4);
  assert.equal(operatorHoursFor(239), 4);
  assert.equal(operatorHoursFor(240), 4);
  assert.equal(operatorHoursFor(480), 8);
  // Nobody there means nothing owed.
  assert.equal(operatorHoursFor(0), 0);
});

test('morning and afternoon become one line with two in/out pairs', () => {
  const rows = buildTicketRows(
    [
      shift({ id: 'a', clockInAt: ts(7), clockOutAt: ts(12), durationMinutes: 300 }),
      shift({ id: 'b', clockInAt: ts(12, 30), clockOutAt: ts(15, 30), durationMinutes: 180 }),
    ],
    EQUIP,
  );
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.operatorHours, 8);
  assert.equal(row.equipmentType, 'D8T');
  assert.equal(row.machineNo, '2');
  assert.equal(row.in1.toMillis(), ts(7).toMillis());
  assert.equal(row.out1.toMillis(), ts(12).toMillis());
  assert.equal(row.in2.toMillis(), ts(12, 30).toMillis());
  assert.equal(row.out2.toMillis(), ts(15, 30).toMillis());
  assert.deepEqual(row.shiftIds, ['a', 'b']);
});

test('a half day is billed at the four-hour minimum but machine hours are not', () => {
  const rows = buildTicketRows(
    [shift({ clockInAt: ts(7), clockOutAt: ts(9), durationMinutes: 120 })],
    EQUIP,
  );
  assert.equal(rows[0].operatorHours, 4);
  // The machine genuinely ran two hours. Billing four would overcharge.
  assert.equal(rows[0].tractorHours, 2);
});

test('a supervisor’s hour-meter reading is kept', () => {
  const rows = buildTicketRows([shift({ tractorHours: 6.5 })], EQUIP);
  assert.equal(rows[0].tractorHours, 6.5);
});

test('moving onto a second machine gets its own line', () => {
  const rows = buildTicketRows(
    [
      shift({ id: 'a', equipmentId: 'e1', clockInAt: ts(7), clockOutAt: ts(11), durationMinutes: 240 }),
      shift({ id: 'b', equipmentId: 'e2', clockInAt: ts(12), clockOutAt: ts(16), durationMinutes: 240 }),
    ],
    [...EQUIP, { id: 'e2', type: '637', machineNo: '21', active: true }],
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.machineNo).sort(), ['2', '21']);
  // Each machine is billed its own time; neither line absorbs the other.
  assert.deepEqual(rows.map((r) => r.operatorHours), [4, 4]);
});

test('clock in, out, and back in stays on ONE line', () => {
  // Exactly what a lunch break looks like before the afternoon is finished.
  const rows = buildTicketRows(
    [
      shift({ id: 'a', clockInAt: ts(7), clockOutAt: ts(12), durationMinutes: 300 }),
      shift({ id: 'b', status: 'open', clockInAt: ts(12, 30), clockOutAt: null, durationMinutes: null }),
    ],
    EQUIP,
  );
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.in1.toMillis(), ts(7).toMillis());
  assert.equal(row.out1.toMillis(), ts(12).toMillis());
  assert.equal(row.in2.toMillis(), ts(12, 30).toMillis());
  // Still out there, so no finish time yet.
  assert.equal(row.out2, null);
  assert.equal(row.stillOnTheClock, true);
  // Five hours banked; the afternoon is not earned until they clock out.
  assert.equal(row.operatorHours, 5);
});

test('someone still on the clock is on the ticket, not missing from it', () => {
  const rows = buildTicketRows(
    [shift({ status: 'open', clockInAt: ts(7), clockOutAt: null, durationMinutes: null })],
    EQUIP,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].out1, null);
  assert.equal(rows[0].stillOnTheClock, true);
  assert.equal(rows[0].operatorHours, 0);
});

test('a stint with no machine picked stays on the operator’s line', () => {
  // Picked the machine in the morning, forgot to after lunch. One line, not two.
  const rows = buildTicketRows(
    [
      shift({ id: 'a', equipmentId: 'e1', clockInAt: ts(7), clockOutAt: ts(12), durationMinutes: 300 }),
      shift({ id: 'b', equipmentId: null, clockInAt: ts(12, 30), clockOutAt: ts(15, 30), durationMinutes: 180 }),
    ],
    EQUIP,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].machineNo, '2');
  assert.equal(rows[0].operatorHours, 8);
  assert.equal(rows[0].out2.toMillis(), ts(15, 30).toMillis());
});

test('an operator with no machine still gets a line', () => {
  const rows = buildTicketRows([shift({ equipmentId: null })], EQUIP);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].equipmentType, '');
  assert.equal(rows[0].operatorHours, 5);
});

test('three stints in a day still fit the form’s two pairs', () => {
  const rows = buildTicketRows(
    [
      shift({ id: 'a', clockInAt: ts(7), clockOutAt: ts(11), durationMinutes: 240 }),
      shift({ id: 'b', clockInAt: ts(12), clockOutAt: ts(15), durationMinutes: 180 }),
      shift({ id: 'c', clockInAt: ts(16), clockOutAt: ts(18), durationMinutes: 120 }),
    ],
    EQUIP,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].in2.toMillis(), ts(12).toMillis());
  // The last finish wins, so no hours are lost off the end of the line.
  assert.equal(rows[0].out2.toMillis(), ts(18).toMillis());
  assert.equal(rows[0].operatorHours, 9);
});

test('lines come out in the order the crew started', () => {
  const rows = buildTicketRows(
    [
      shift({ userId: 'u2', userDisplayName: 'M. Parra', equipmentId: 'e2', clockInAt: ts(6), clockOutAt: ts(12), durationMinutes: 360 }),
      shift({ userId: 'u1', userDisplayName: 'B. Kuntz', clockInAt: ts(7), clockOutAt: ts(12), durationMinutes: 300 }),
    ],
    [...EQUIP, { id: 'e2', type: '637 W/P', machineNo: '', active: true }],
  );
  assert.deepEqual(rows.map((r) => r.operatorName), ['M. Parra', 'B. Kuntz']);
});
