/**
 * Tests for the fillable timecard PDF.
 *
 * What matters is that the file really is a PDF form: one page per card,
 * every box a named field an office can edit in Acrobat, pre-filled with the
 * clock's numbers.
 *
 *   npm --prefix web run test:timecard-pdf
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';

import { buildTimecards } from './src/lib/timecard.ts';
import { buildTimecardsPdf, timecardsFilename } from './src/lib/timecardPdf.ts';

const at = (y, mo, d, h, m = 0) => {
  const date = new Date(y, mo - 1, d, h, m);
  return { toDate: () => date, toMillis: () => date.getTime() };
};

let n = 0;
const shift = (over = {}) => ({
  id: `s${n++}`,
  userId: 'u1',
  userDisplayName: 'R. Florez',
  userEmail: 'rf@example.com',
  jobSiteId: 'yard',
  jobSiteName: 'Coburn Yard',
  status: 'closed',
  ...over,
});

const cards = buildTimecards('2026-09-13', [
  shift({ clockInAt: at(2026, 9, 7, 7), clockOutAt: at(2026, 9, 7, 17), durationMinutes: 600, machineNo: '140' }),
  shift({
    userId: 'u2',
    userDisplayName: 'Z. Adams',
    clockInAt: at(2026, 9, 8, 6),
    clockOutAt: null,
    durationMinutes: null,
    status: 'open',
  }),
]);

test('one page per card, every box a pre-filled form field', async () => {
  const logo = new Uint8Array(readFileSync('./public/apple-touch-icon.png'));
  const bytes = await buildTimecardsPdf(cards, logo);
  assert.equal(String.fromCharCode(...bytes.slice(0, 5)), '%PDF-');

  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 2);

  const form = pdf.getForm();
  const value = (name) => form.getTextField(name).getText() ?? '';
  assert.equal(value('card1.name'), 'R. Florez');
  assert.equal(value('card1.job'), 'Coburn Yard');
  assert.equal(value('card1.truck'), ''); // left for the office to fill in
  // Monday's ten hours: eight straight, two overtime, and the machine.
  assert.equal(value('card1.mon.regular'), '8');
  assert.equal(value('card1.mon.overtime'), '2');
  assert.equal(value('card1.mon.machines'), '140');
  assert.equal(value('card1.tue.regular'), '');
  assert.equal(value('card1.total.regular'), '8');
  assert.equal(value('card1.total.overtime'), '2');
  // The second card is its own set of fields.
  assert.equal(value('card2.name'), 'Z. Adams');
  assert.equal(value('card2.tue.regular'), ''); // still on the clock: no hours yet
  assert.equal(value('card2.signature'), '');

  // 4 written lines + 7 days × 8 boxes + 3 totals + signature, per card.
  assert.equal(form.getFields().length, 2 * (4 + 7 * 8 + 3 + 1));
});

test('fields stay editable: a corrected value survives a save', async () => {
  const bytes = await buildTimecardsPdf(cards);
  const pdf = await PDFDocument.load(bytes);
  pdf.getForm().getTextField('card1.truck').setText('T-14');
  const again = await PDFDocument.load(await pdf.save());
  assert.equal(again.getForm().getTextField('card1.truck').getText(), 'T-14');
});

test('the filename says who and which week', () => {
  assert.equal(timecardsFilename(cards, '2026-09-13'), 'timecards-week-ending-2026-09-13.pdf');
  assert.equal(timecardsFilename([cards[0]], '2026-09-13'), 'timecard-r-florez-2026-09-13.pdf');
});
