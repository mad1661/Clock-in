import type { Timecard } from './timecard.ts';

/**
 * The weekly timecard as a fillable Adobe PDF form.
 *
 * The office wanted a file rather than the browser's print dialog, and one
 * they can correct: a truck number typed in, an hour amended, a machine added.
 * So every box on the card is a real PDF form field, pre-filled from the
 * clock, that opens editable in Acrobat or Reader — and the signature box is
 * where Fill & Sign goes. The ruled lines and headings are drawn as vector
 * text and lines, so it prints crisp and identical on every device.
 *
 * Kept free of DOM access so it can be exercised from Node in the tests.
 */

// Letter, portrait, half-inch margins, one card per page. Points throughout.
// pdf-lib measures from the bottom-left corner, so the drawing code below
// works top-down and converts with `up()`.
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 36;
const CONTENT_W = PAGE_W - MARGIN * 2;

// Day | Regular | OVT | Dbl | In | Out | In | Out | Machines — sums to CONTENT_W.
const COLS = [70, 42, 42, 42, 50, 50, 50, 50, 144];
const HEAD_H = 14;
const ROW_H = 20;
const TOTAL_H = 28;

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_NAMES = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

const CONFIRMATION =
  'I confirm that I have received all my required breaks to include lunch. ' +
  'I have NO injuries to report during this work period.';

const time = (t: { toDate: () => Date } | null) =>
  t
    ? t
        .toDate()
        .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        .replace(/\s/g, '')
    : '';

const hrs = (n: number) => (n === 0 ? '' : String(Number(n.toFixed(2))));

const longDate = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString();

const up = (y: number) => PAGE_H - y;

/**
 * Builds the file: one page per card, every box a form field. `logo` is the
 * PNG bytes of the company mark, or null to leave the space blank.
 */
export async function buildTimecardsPdf(
  cards: Timecard[],
  logo: Uint8Array | null = null,
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, TextAlignment, rgb } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.setTitle('Coburn Equipment weekly time cards');
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const mark = logo ? await pdf.embedPng(logo) : null;
  const form = pdf.getForm();
  const black = rgb(0, 0, 0);
  const shade = rgb(242 / 255, 244 / 255, 248 / 255);

  cards.forEach((card, n) => {
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    const left = MARGIN;
    const right = MARGIN + CONTENT_W;
    // Field names must be unique across the file; the row number does that.
    const fieldName = (key: string) => `card${n + 1}.${key}`;

    /** A text field sitting in a drawn box, pre-filled and centred. */
    const field = (
      key: string,
      value: string,
      x: number,
      top: number,
      w: number,
      h: number,
      opts: { align?: 'left' | 'center'; size?: number } = {},
    ) => {
      const f = form.createTextField(fieldName(key));
      f.setAlignment(opts.align === 'left' ? TextAlignment.Left : TextAlignment.Center);
      if (value) f.setText(value);
      f.addToPage(page, {
        x: x + 1,
        y: up(top + h) + 1,
        width: w - 2,
        height: h - 2,
        borderWidth: 0,
        font: regular,
      });
      // After placement: the size lives in the default appearance the
      // placement creates, and setting it earlier has nothing to write to.
      f.setFontSize(opts.size ?? 9);
    };

    const text = (s: string, x: number, baseline: number, size: number, font = regular) =>
      page.drawText(s, { x, y: up(baseline), size, font, color: black });
    const centred = (s: string, cx: number, baseline: number, size: number, font = regular) =>
      text(s, cx - font.widthOfTextAtSize(s, size) / 2, baseline, size, font);
    const rightAligned = (s: string, rx: number, baseline: number, size: number, font = regular) =>
      text(s, rx - font.widthOfTextAtSize(s, size), baseline, size, font);
    const box = (x: number, top: number, w: number, h: number, fill = false) =>
      page.drawRectangle({
        x,
        y: up(top + h),
        width: w,
        height: h,
        borderColor: black,
        borderWidth: 0.6,
        ...(fill ? { color: shade } : {}),
      });
    const rule = (x1: number, x2: number, y: number) =>
      page.drawLine({ start: { x: x1, y: up(y) }, end: { x: x2, y: up(y) }, thickness: 0.6, color: black });
    const heading = (s: string, cx: number, bottom: number) => centred(s, cx, bottom - 4.2, 6.5, bold);

    // Header: logo, company, form title.
    let titleX = left;
    if (mark) {
      const h = 36;
      const w = (h * mark.width) / mark.height;
      page.drawImage(mark, { x: left, y: up(MARGIN + h), width: w, height: h });
      titleX = left + w + 8;
    }
    text('COBURN EQUIPMENT', titleX, MARGIN + 22, 13, bold);
    rightAligned('WEEKLY TIME CARD', right, MARGIN + 22, 11, bold);

    // The written-on lines of the form, each an editable field on a rule.
    const metaTop = MARGIN + 48;
    const split = left + 310;
    const written = (label: string, key: string, value: string, from: number, to: number, y: number) => {
      text(label, from, y, 7.5, bold);
      const start = from + bold.widthOfTextAtSize(label, 7.5) + 5;
      rule(start, to, y + 2.5);
      field(key, value, start, y - 10, to - start, 13, { align: 'left', size: 9.5 });
    };
    written('PRINT NAME:', 'name', card.name, left, split - 20, metaTop);
    written('WEEK ENDING:', 'weekEnding', longDate(card.weekEnding), split, right, metaTop);
    written('JOB:', 'job', card.jobs.join(', '), left, split - 20, metaTop + 18);
    written('TRUCK #:', 'truck', '', split, right, metaTop + 18);

    // The grid.
    const x = COLS.reduce<number[]>((acc, w) => [...acc, acc[acc.length - 1] + w], [left]);
    const cx = (i: number) => (x[i] + x[i + 1]) / 2;
    let y = metaTop + 18 + 14;

    // Heading rows: "Paycheck hours" over the pay columns, the machines heading
    // spanning both rows, then the individual column names.
    box(x[0], y, COLS[0], HEAD_H, true);
    box(x[1], y, x[4] - x[1], HEAD_H, true);
    box(x[4], y, x[8] - x[4], HEAD_H, true);
    box(x[8], y, COLS[8], HEAD_H * 2, true);
    heading('PAYCHECK HOURS', (x[1] + x[4]) / 2, y + HEAD_H);
    heading('MACHINE(S) OPERATED', cx(8), y + HEAD_H * 1.5);
    y += HEAD_H;
    ['', 'REGULAR', 'OVT', 'DBL TIME', 'TIME IN', 'TIME OUT', 'TIME IN', 'TIME OUT'].forEach(
      (label, i) => {
        box(x[i], y, COLS[i], HEAD_H, true);
        if (label) heading(label, cx(i), y + HEAD_H);
      },
    );
    y += HEAD_H;

    // One row per day, Monday first; every value box is a field.
    card.days.forEach((day, d) => {
      COLS.forEach((w, i) => box(x[i], y, w, ROW_H));
      text(DAY_NAMES[d] + (day.stillOnTheClock ? ' *' : ''), x[0] + 4, y + ROW_H / 2 + 2.6, 7.5, bold);
      const key = DAY_KEYS[d];
      const values: [string, string][] = [
        ['regular', hrs(day.regular)],
        ['overtime', hrs(day.overtime)],
        ['doubleTime', hrs(day.doubleTime)],
        ['in1', time(day.in1)],
        ['out1', time(day.out1)],
        ['in2', time(day.in2)],
        ['out2', time(day.out2)],
      ];
      values.forEach(([name, v], i) => field(`${key}.${name}`, v, x[i + 1], y, COLS[i + 1], ROW_H));
      field(`${key}.machines`, day.machines.join(', '), x[8], y, COLS[8], ROW_H, { size: 8 });
      y += ROW_H;
    });

    // Totals heading row, with the signature label across the right-hand side.
    ['', 'TOTAL REG', 'TTL OVT', 'TTL DBL'].forEach((label, i) => {
      box(x[i], y, COLS[i], HEAD_H, true);
      if (label) heading(label, cx(i), y + HEAD_H);
    });
    box(x[4], y, x[9] - x[4], HEAD_H, true);
    text('SIGNATURE: (REQUIRED)', x[4] + 4, y + HEAD_H - 4, 6.5, bold);
    y += HEAD_H;

    // Totals row; the signature box is a field too, for a typed name, and is
    // where Acrobat's Fill & Sign places a drawn signature.
    COLS.slice(0, 4).forEach((w, i) => box(x[i], y, w, TOTAL_H));
    box(x[4], y, x[9] - x[4], TOTAL_H);
    text('TOTALS', x[0] + 4, y + TOTAL_H / 2 + 2.6, 7.5, bold);
    field('total.regular', hrs(card.totals.regularHours), x[1], y, COLS[1], TOTAL_H);
    field('total.overtime', hrs(card.totals.overtimeHours), x[2], y, COLS[2], TOTAL_H);
    field('total.doubleTime', hrs(card.totals.doubleTimeHours), x[3], y, COLS[3], TOTAL_H);
    field('signature', '', x[4], y, x[9] - x[4], TOTAL_H, { align: 'left', size: 11 });
    y += TOTAL_H;

    // The declaration the employee signs to.
    const words = CONFIRMATION.split(' ');
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (bold.widthOfTextAtSize(next, 8) > 400 && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    lines.forEach((l, i) => text(l, left, y + 16 + i * 10, 8, bold));
    y += 8 + lines.length * 10;

    if (card.days.some((d) => d.stillOnTheClock)) {
      text('* still on the clock — hours are not final until they clock out', left, y + 12, 7, italic);
    }
  });

  // Appearances are what a viewer shows before anyone clicks into a field.
  form.updateFieldAppearances(regular);
  return pdf.save();
}

/** A filename that says what is inside, for the downloads folder. */
export function timecardsFilename(cards: Timecard[], weekEnding: string): string {
  if (cards.length === 1) {
    const who = cards[0].name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `timecard-${who}-${weekEnding}.pdf`;
  }
  return `timecards-week-ending-${weekEnding}.pdf`;
}
