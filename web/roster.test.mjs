/**
 * Tests for the employee import sheet.
 *
 * Thirty logins get created off this parse, so the judgement calls are worth
 * pinning down: what counts as a duplicate, what is skipped rather than
 * failed, and that a file which is not the template at all is refused.
 *
 *   npm --prefix web run test:roster
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRoster, TEMPLATE_COLUMNS } from './src/lib/roster.ts';

const HEADER = [...TEMPLATE_COLUMNS];

test('a filled-in template reads clean', () => {
  const roster = parseRoster(
    [
      HEADER,
      ['Pat Doyle', 'pat@site.com', 'worker', '38.50'],
      ['Dana Reid', 'Dana@Site.com', 'Admin', ''],
    ],
    [],
  );
  assert.equal(roster.length, 2);
  assert.deepEqual(
    roster.map((r) => r.status),
    ['ready', 'ready'],
  );
  assert.equal(roster[0].hourlyRate, 38.5);
  assert.equal(roster[1].email, 'dana@site.com'); // emails are usernames: lowercased
  assert.equal(roster[1].role, 'admin');
  assert.equal(roster[1].hourlyRate, null);
});

test('the words people write for roles are understood', () => {
  const roster = parseRoster(
    [
      HEADER,
      ['A', 'a@site.com', 'Supervisor', ''],
      ['B', 'b@site.com', '', ''],
      ['C', 'c@site.com', 'boss', ''],
    ],
    [],
  );
  assert.equal(roster[0].role, 'admin');
  assert.equal(roster[1].role, 'worker');
  assert.equal(roster[2].status, 'error');
  assert.match(roster[2].problem, /worker or admin/);
});

test('rows that cannot become accounts say why', () => {
  const roster = parseRoster(
    [
      HEADER,
      ['', 'x@site.com', '', ''],
      ['No Email', '', '', ''],
      ['Bad Email', 'not-an-email', '', ''],
      ['Bad Wage', 'w@site.com', '', 'call me'],
    ],
    [],
  );
  assert.deepEqual(
    roster.map((r) => r.status),
    ['error', 'error', 'error', 'error'],
  );
  assert.equal(roster[0].problem, 'no name');
  assert.equal(roster[1].problem, 'no email address');
  assert.match(roster[3].problem, /not an hourly wage/);
});

test('already-on-the-roster and example rows are skipped, not failed', () => {
  const roster = parseRoster(
    [
      HEADER,
      ['Pat Doyle', 'pat@example.com', 'worker', '38.50'],
      ['Old Hand', 'old@site.com', '', ''],
      ['New Hire', 'new@site.com', '', ''],
    ],
    ['OLD@site.com'],
  );
  assert.equal(roster[0].status, 'example');
  assert.equal(roster[1].status, 'existing');
  assert.equal(roster[2].status, 'ready');
});

test('the same email twice in one file is an error, once', () => {
  const roster = parseRoster(
    [HEADER, ['A', 'same@site.com', '', ''], ['B', 'Same@site.com', '', '']],
    [],
  );
  assert.equal(roster[0].status, 'ready');
  assert.equal(roster[1].status, 'error');
  assert.match(roster[1].problem, /twice/);
});

test('blank lines and a title above the headings are tolerated', () => {
  const roster = parseRoster(
    [
      ['Our crew list 2026'],
      [],
      HEADER,
      ['Pat Doyle', 'pat@site.com', '', ''],
      [],
      ['', '', '', ''],
    ],
    [],
  );
  assert.equal(roster.length, 1);
  assert.equal(roster[0].status, 'ready');
  assert.equal(roster[0].line, 4); // numbered as Excel numbers them
});

test('columns are matched by heading, not position', () => {
  const roster = parseRoster(
    [
      ['Email', 'Hourly wage ($)', 'Full name'],
      ['pat@site.com', '38.50', 'Pat Doyle'],
    ],
    [],
  );
  assert.equal(roster[0].name, 'Pat Doyle');
  assert.equal(roster[0].email, 'pat@site.com');
  assert.equal(roster[0].hourlyRate, 38.5);
  assert.equal(roster[0].role, 'worker'); // no role column at all
});

test('a file that is not the template is refused with a plain answer', () => {
  assert.throws(() => parseRoster([['Timesheet'], ['Monday', '8']], []), /template/);
});

test('a dollar sign on the wage is fine', () => {
  const roster = parseRoster([HEADER, ['A', 'a@site.com', '', '$41.25']], []);
  assert.equal(roster[0].hourlyRate, 41.25);
});
