import type { Role } from './types.ts';

/**
 * The employee import sheet.
 *
 * The office fills the downloaded template in Excel and uploads it back; this
 * module turns what the spreadsheet library read — rows of cells — into a
 * checked list of accounts to create. All judgement lives here, away from the
 * file format, so it can be tested with plain arrays.
 */

/** The template's columns, in order. Matching on upload is by heading, not position. */
export const TEMPLATE_COLUMNS = [
  'Full name',
  'Email',
  'Role (worker or admin)',
  'Hourly wage ($)',
] as const;

export interface RosterRow {
  /** 1-based row number in the uploaded sheet, for pointing at problems. */
  line: number;
  name: string;
  email: string;
  role: Role;
  hourlyRate: number | null;
  /**
   * ready    — will be created
   * existing — already on the roster, skipped
   * example  — the template's sample row, skipped
   * error    — cannot be created as written; `problem` says why
   */
  status: 'ready' | 'existing' | 'example' | 'error';
  problem: string | null;
}

const EMAIL_SHAPE = /^\S+@\S+\.\S+$/;

function normaliseRole(value: string): Role | null {
  const v = value.trim().toLowerCase();
  if (v === '' || v === 'worker') return 'worker';
  // The words people actually write in the box, not just the stored value.
  if (v === 'admin' || v === 'administrator' || v === 'supervisor') return 'admin';
  return null;
}

/**
 * Finds the heading row and says which column holds what. Headings rather than
 * positions, so a sheet that gained a column or lost one still reads right —
 * and a file that is not the template at all is refused with a plain answer.
 */
function findColumns(rows: unknown[][]): {
  headerAt: number;
  name: number;
  email: number;
  role: number;
  wage: number;
} | null {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const cells = rows[r].map((c) => String(c ?? '').trim().toLowerCase());
    const name = cells.findIndex((c) => /\bname\b/.test(c));
    const email = cells.findIndex((c) => /\bemail\b/.test(c));
    if (name === -1 || email === -1) continue;
    return {
      headerAt: r,
      name,
      email,
      role: cells.findIndex((c) => /\brole\b/.test(c)),
      wage: cells.findIndex((c) => /\bwage\b|\brate\b|\bpay\b/.test(c)),
    };
  }
  return null;
}

/**
 * Reads the uploaded sheet into a checked roster.
 *
 * Deliberate judgements: a row already on the roster is skipped rather than
 * failed — re-uploading the whole sheet after adding two people at the bottom
 * is exactly how this will be used. The template's own example rows (their
 * emails end in @example.com) are skipped the same way, so forgetting to
 * delete them does not create pretend employees.
 */
export function parseRoster(rows: unknown[][], existingEmails: Iterable<string>): RosterRow[] {
  const columns = findColumns(rows);
  if (!columns) {
    throw new Error(
      'Could not find the "Full name" and "Email" headings. Use the downloaded template, ' +
        'with the headings left in place.',
    );
  }

  const taken = new Set([...existingEmails].map((e) => e.trim().toLowerCase()));
  const inFile = new Set<string>();
  const roster: RosterRow[] = [];

  for (let r = columns.headerAt + 1; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    const cell = (i: number) => (i === -1 ? '' : String(cells[i] ?? '').trim());
    const name = cell(columns.name);
    const email = cell(columns.email).toLowerCase();
    const roleText = cell(columns.role);
    const wageText = cell(columns.wage);
    if (!name && !email && !roleText && !wageText) continue; // blank line, not an error

    const row: RosterRow = {
      line: r + 1,
      name,
      email,
      role: normaliseRole(roleText) ?? 'worker',
      hourlyRate: null,
      status: 'ready',
      problem: null,
    };
    const fail = (why: string) => {
      row.status = 'error';
      row.problem = why;
    };

    const wage = wageText.replace(/^\$/, '');
    if (wageText !== '') {
      if (!Number.isFinite(Number(wage)) || Number(wage) < 0) {
        fail(`"${wageText}" is not an hourly wage`);
      } else {
        row.hourlyRate = Number(wage);
      }
    }
    if (normaliseRole(roleText) === null) {
      fail(`role must be worker or admin, not "${roleText}"`);
    }
    if (!name) fail('no name');
    if (!EMAIL_SHAPE.test(email)) {
      fail(email ? `"${email}" does not look like an email address` : 'no email address');
    }

    if (row.status === 'ready') {
      if (email.endsWith('@example.com')) {
        row.status = 'example';
        row.problem = 'the template’s example row';
      } else if (taken.has(email)) {
        row.status = 'existing';
        row.problem = 'already on the roster';
      } else if (inFile.has(email)) {
        fail('appears twice in this file');
      } else {
        inFile.add(email);
      }
    }

    roster.push(row);
  }

  return roster;
}
