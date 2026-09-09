import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { errorMessage } from '../../lib/errors';
import { withTimestamps } from '../../lib/snapshot';
import { openPrintDialog } from '../../lib/print';
import {
  buildTimecards,
  isTimecardSite,
  weekBounds,
  weekEndingKey,
  type Timecard,
} from '../../lib/timecard';
import { Banner, Card, EmptyState, Spinner } from '../../components/ui';
import type { JobSite, Shift } from '../../lib/types';

const DAY_NAMES = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
];

const time = (t: { toDate: () => Date } | null) =>
  t
    ? t
        .toDate()
        .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        .replace(/\s/g, '')
    : '';

/** Hours as the card prints them: blank when zero, whole numbers left whole. */
const hrs = (n: number) => (n === 0 ? '' : String(Number(n.toFixed(2))));

const longDate = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString();

/**
 * Weekly timecards for the yard.
 *
 * Hours worked at the yard are payroll, not billing, so they stay off the
 * Daily Rental Ticket and land here instead: one card per employee per
 * Monday-to-Sunday week, laid out like the paper form the office has always
 * used, so a printed copy is what an auditor expects to be handed. The
 * employee signs the printed sheet.
 */
export default function Timecards() {
  const [sites, setSites] = useState<JobSite[] | null>(null);
  const [weekEnding, setWeekEnding] = useState(() => weekEndingKey(new Date()));
  const [cards, setCards] = useState<Timecard[] | null>(null);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    void (async () => {
      const snap = await getDocs(collection(db, 'jobSites'));
      setSites(snap.docs.map((d) => ({ ...(d.data() as JobSite), id: d.id })));
    })().catch((err) => setError(errorMessage(err)));
  }, []);

  const yardSites = useMemo(() => (sites ?? []).filter(isTimecardSite), [sites]);

  const load = useCallback(async () => {
    if (!sites) return;
    if (yardSites.length === 0) {
      setCards([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { start, end } = weekBounds(weekEnding);
      const snaps = await Promise.all(
        yardSites.map((site) =>
          getDocs(
            query(
              collection(db, 'shifts'),
              where('jobSiteId', '==', site.id),
              where('clockInAt', '>=', start),
              where('clockInAt', '<=', end),
            ),
          ),
        ),
      );
      const shifts = snaps.flatMap((snap) => snap.docs.map((d) => withTimestamps<Shift>(d)));
      setCards(buildTimecards(weekEnding, shifts));
    } catch (err) {
      setError(errorMessage(err));
      setCards(null);
    } finally {
      setLoading(false);
    }
  }, [sites, yardSites, weekEnding]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(
    () => (cards ?? []).filter((c) => !selected || c.userId === selected),
    [cards, selected],
  );

  function shiftWeek(weeks: number) {
    const [y, m, d] = weekEnding.split('-').map(Number);
    setWeekEnding(weekEndingKey(new Date(y, m - 1, d + weeks * 7, 12)));
  }

  if (!sites) return <Spinner label="Loading job sites…" />;

  const { start } = weekBounds(weekEnding);

  return (
    <>
      <Card title="Timecards" className="no-print">
        {error && <Banner kind="error">{error}</Banner>}

        {yardSites.length === 0 && (
          <Banner kind="warning" title="No timecard site set up">
            Timecards cover sites whose hours are payroll rather than billing — the yard. Tick{' '}
            <em>Hours go on weekly timecards</em> on the yard&rsquo;s site under{' '}
            <Link to="/admin/sites">Job sites</Link>.
          </Banner>
        )}

        <div className="field">
          <label htmlFor="tc-week">Week ending (Sunday)</label>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button type="button" className="small" onClick={() => shiftWeek(-1)}>
              ← Previous
            </button>
            <input
              id="tc-week"
              type="date"
              value={weekEnding}
              onChange={(e) => {
                if (!e.target.value) return;
                const [y, m, d] = e.target.value.split('-').map(Number);
                // Whatever day they tap lands on that day's week.
                setWeekEnding(weekEndingKey(new Date(y, m - 1, d, 12)));
              }}
            />
            <button type="button" className="small" onClick={() => shiftWeek(1)}>
              Next →
            </button>
          </div>
          <p className="hint">
            Monday {start.toLocaleDateString()} to Sunday {longDate(weekEnding)}.
          </p>
        </div>

        <div className="field">
          <label htmlFor="tc-worker">Employee</label>
          <select id="tc-worker" value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">
              Everyone with yard hours this week{cards ? ` (${cards.length})` : ''}
            </option>
            {(cards ?? []).map((card) => (
              <option key={card.userId} value={card.userId}>
                {card.name}
              </option>
            ))}
          </select>
        </div>

        <div className="row-actions" style={{ marginTop: '0.9rem' }}>
          <button
            type="button"
            className="small primary"
            onClick={() => openPrintDialog(setPrinting)}
            disabled={loading || printing || shown.length === 0}
          >
            {printing ? 'Preparing…' : 'Print / PDF'}
          </button>
        </div>

        {printing && (
          <div className="print-status" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>
              <strong>Building the printable timecards…</strong>
              <br />
              Your print dialog will open when it is ready.
            </span>
          </div>
        )}

        <p className="hint">
          Built from the clock, one card per employee, each on its own page. Print the stack — or
          pick one employee for an auditor&rsquo;s copy — and choose &ldquo;Save as PDF&rdquo; in
          the print dialog for a file. The employee signs the printed sheet.
        </p>
      </Card>

      {loading && <Spinner label="Building the timecards…" />}

      {!loading && cards && shown.length === 0 && yardSites.length > 0 && (
        <Card className="no-print">
          <EmptyState>
            No yard hours in the week ending {longDate(weekEnding)}
            {selected ? ' for that employee' : ''}.
          </EmptyState>
        </Card>
      )}

      {!loading &&
        shown.map((card) => (
          <div key={card.userId} className="timecard-sheet">
            <header className="timecard-head">
              <img src="/coburn-logo.png" alt="" />
              <div className="timecard-title">
                <strong>COBURN EQUIPMENT</strong>
                <span>WEEKLY TIME CARD</span>
              </div>
            </header>

            <div className="timecard-meta">
              <div>
                <span className="k">Print name:</span>
                <span className="v">{card.name}</span>
              </div>
              <div>
                <span className="k">Week ending:</span>
                <span className="v">{longDate(card.weekEnding)}</span>
              </div>
              <div>
                <span className="k">Job:</span>
                <span className="v">{card.jobs.join(', ')}</span>
              </div>
              <div>
                <span className="k">Truck #:</span>
                <span className="v" />
              </div>
            </div>

            <table className="timecard-table">
              <thead>
                <tr>
                  <th />
                  <th colSpan={3} className="timecard-group">
                    Paycheck hours
                  </th>
                  <th colSpan={4} />
                  <th rowSpan={2} className="timecard-machines">
                    Machine(s) operated
                  </th>
                </tr>
                <tr>
                  <th />
                  <th>Regular</th>
                  <th>OVT</th>
                  <th>Dbl time</th>
                  <th>Time in</th>
                  <th>Time out</th>
                  <th>Time in</th>
                  <th>Time out</th>
                </tr>
              </thead>
              <tbody>
                {card.days.map((day, i) => (
                  <tr key={day.date}>
                    <td className="timecard-day">
                      {DAY_NAMES[i]}
                      {day.stillOnTheClock && (
                        <span className="ticket-open" title="Still on the clock">
                          *
                        </span>
                      )}
                    </td>
                    <td>{hrs(day.regular)}</td>
                    <td>{hrs(day.overtime)}</td>
                    <td>{hrs(day.doubleTime)}</td>
                    <td>{time(day.in1)}</td>
                    <td>{time(day.out1)}</td>
                    <td>{time(day.in2)}</td>
                    <td>{time(day.out2)}</td>
                    <td className="timecard-machines">{day.machines.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th />
                  <th>Total reg</th>
                  <th>Ttl OVT</th>
                  <th>Ttl dbl</th>
                  <th colSpan={5} className="timecard-sig-label">
                    Signature: (Required)
                  </th>
                </tr>
                <tr>
                  <td className="timecard-day">TOTALS</td>
                  <td>{hrs(card.totals.regularHours)}</td>
                  <td>{hrs(card.totals.overtimeHours)}</td>
                  <td>{hrs(card.totals.doubleTimeHours)}</td>
                  <td colSpan={5} className="timecard-sig-line" />
                </tr>
              </tfoot>
            </table>

            {card.days.some((d) => d.stillOnTheClock) && (
              <p className="ticket-note">
                * still on the clock — hours are not final until they clock out
              </p>
            )}

            <p className="timecard-confirm">
              I confirm that I have received all my required breaks to include lunch. I have NO
              injuries to report during this work period.
            </p>
          </div>
        ))}
    </>
  );
}
