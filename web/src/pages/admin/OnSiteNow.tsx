import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { db } from '../../firebase';
import { useAuth } from '../../auth/AuthProvider';
import {
  forceCloseShift,
  shiftIsStuck,
  STUCK_SHIFT_HOURS,
  type WorkedDay,
} from '../../lib/actions';
import { errorMessage } from '../../lib/errors';
import { Banner, Card, EmptyState, FlagList, Modal, Spinner } from '../../components/ui';
import { ShiftDetail } from '../../components/ShiftDetail';
import { elapsedSince, fmtDistance, fmtTime } from '../../lib/format';
import { shortDeviceId } from '../../lib/device';
import { withTimestamps } from '../../lib/snapshot';
import { dayKey } from '../../lib/ticket';
import { parseTimeOfDay } from '../../lib/policy';
import type { JobSite, Shift } from '../../lib/types';

/**
 * Who is clocked in, where, and for how long.
 *
 * This is the question a supervisor actually opens the app to answer, and it
 * was previously only answerable by filtering a timesheet. Live via onSnapshot,
 * so a clock-in on site shows up here within a second.
 */
export default function OnSiteNow() {
  const { isOwner } = useAuth();
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [ending, setEnding] = useState<Shift | null>(null);
  const [sites, setSites] = useState<JobSite[]>([]);
  const [open, setOpen] = useState<Shift | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    return onSnapshot(
      query(collection(db, 'shifts'), where('status', '==', 'open'), orderBy('clockInAt', 'asc')),
      (snap) => setShifts(snap.docs.map((d) => withTimestamps<Shift>(d))),
      (err) => {
        setShifts([]);
        setError(errorMessage(err));
      },
    );
  }, []);

  useEffect(() => {
    return onSnapshot(query(collection(db, 'jobSites'), where('active', '==', true)), (snap) =>
      setSites(snap.docs.map((d) => ({ ...(d.data() as JobSite), id: d.id }))),
    );
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  /** Grouped by site, because that is how a supervisor thinks about a crew. */
  const bySite = useMemo(() => {
    const groups = new Map<string, { name: string; shifts: Shift[] }>();
    for (const shift of shifts ?? []) {
      const group = groups.get(shift.jobSiteId) ?? { name: shift.jobSiteName, shifts: [] };
      group.shifts.push(shift);
      groups.set(shift.jobSiteId, group);
    }
    return [...groups.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [shifts]);

  const totalMinutes = useMemo(
    () => (shifts ?? []).reduce((sum, s) => sum + (now - s.clockInAt.toMillis()) / 60000, 0),
    [shifts, now],
  );

  if (!shifts) return <Spinner label="Loading the board…" />;

  const idleSites = sites.filter((site) => !bySite.some(([id]) => id === site.id));

  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}

      {open && (
        <Modal title={`${open.userDisplayName} — on shift`} onClose={() => setOpen(null)}>
          <ShiftDetail shift={open} />
        </Modal>
      )}

      {ending && (
        <EndShiftModal
          shift={ending}
          site={sites.find((s) => s.id === ending.jobSiteId) ?? null}
          onClose={() => setEnding(null)}
        />
      )}

      <Card title={`On site now (${shifts.length})`}>
        {shifts.length === 0 ? (
          <EmptyState>Nobody is clocked in right now.</EmptyState>
        ) : (
          <div className="totals">
            <span>
              <strong>{shifts.length}</strong> on the clock
            </span>
            <span>
              across <strong>{bySite.length}</strong> site{bySite.length === 1 ? '' : 's'}
            </span>
            <span>
              <strong>{(totalMinutes / 60).toFixed(1)}</strong> crew-hours so far today
            </span>
          </div>
        )}
      </Card>

      {bySite.map(([siteId, group]) => (
        <Card
          key={siteId}
          title={`${group.name} — ${group.shifts.length}`}
          actions={
            <Link className="small" to={`/admin/ticket?site=${siteId}&date=${dayKey(new Date())}`}>
              Today's ticket
            </Link>
          }
        >
          <ul className="list">
            {group.shifts.map((shift) => {
              const longRun = now - shift.clockInAt.toMillis() > 10 * 3600 * 1000;
              const stuck = shiftIsStuck(shift, new Date(now));
              return (
                <li key={shift.id} className="row">
                  <div className="row-head">
                    <span className="title">{shift.userDisplayName}</span>
                    <span className={`pill ${longRun ? 'pill-warning' : 'pill-success'}`}>
                      {elapsedSince(shift.clockInAt.toMillis(), now)}
                    </span>
                  </div>
                  <div className="row-meta">
                    <span>Since {fmtTime(shift.clockInAt)}</span>
                    <span>
                      {shift.clockIn.method === 'gps' &&
                        `Location confirmed${
                          shift.clockIn.distanceMeters != null
                            ? ` — ${fmtDistance(shift.clockIn.distanceMeters)} out`
                            : ''
                        }`}
                      {shift.clockIn.method === 'photo' && 'Photo evidence'}
                      {shift.clockIn.method === 'unverified' && 'Location unconfirmed'}
                    </span>
                  </div>
                  <div className="device-line">
                    <span aria-hidden="true">📱</span>
                    <span className="device-name">
                      {shift.clockIn.device?.label ?? 'Unknown device'}
                    </span>
                    {shortDeviceId(shift.clockIn.device?.id) && (
                      <span className="pill pill-muted">
                        {shortDeviceId(shift.clockIn.device?.id)}
                      </span>
                    )}
                  </div>
                  {longRun && !stuck && (
                    <p className="hint">
                      On the clock over 10 hours — check they have not forgotten to clock out.
                    </p>
                  )}
                  {stuck && (
                    <p className="hint">
                      On the clock {daysOpen(shift, now) > 1
                        ? `since ${shift.clockInAt.toDate().toLocaleDateString(undefined, { weekday: 'long' })} — ${daysOpen(shift, now)} days`
                        : `over ${STUCK_SHIFT_HOURS} hours`}
                      . This is almost certainly a forgotten clock-out
                      {isOwner ? ' — you can end it for them.' : '. An owner can end it for them.'}
                    </p>
                  )}
                  <FlagList flags={shift.flags} />
                  <div className="row-actions">
                    <button type="button" className="small" onClick={() => setOpen(shift)}>
                      Details
                    </button>
                    {/* Owners only, and only past the cut-off: ending a shift
                        for somebody who is still working takes hours off them
                        that they are owed. */}
                    {isOwner && stuck && (
                      <button type="button" className="small danger" onClick={() => setEnding(shift)}>
                        End shift
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ))}

      {idleSites.length > 0 && (
        <Card title="Nobody on site">
          <div className="row-meta">
            {idleSites.map((site) => (
              <span key={site.id}>{site.name}</span>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

/** How many calendar days a shift has been open across, counting today. */
function daysOpen(shift: Shift, nowMs: number): number {
  const start = shift.clockInAt.toDate();
  start.setHours(0, 0, 0, 0);
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - start.getTime()) / 86400000) + 1;
}

/**
 * Ends a forgotten shift.
 *
 * Asks for the hours the worker actually worked rather than assuming any. Hours
 * worked have to be recorded and paid whether or not somebody remembered to
 * press a button, so closing a shift at a guessed-low time is not a neutral
 * act — and closing it at no time at all leaves the shift unpaid until the real
 * hours are entered, which the wording here says out loud.
 *
 * A shift left open across several days is asked about a day at a time, because
 * that is what actually happened: somebody on the clock since Monday went home
 * each night. One record spanning the lot would put every hour on Monday, read
 * as a seventy-two hour day to the overtime split, and leave the other days'
 * rental tickets showing nobody on site.
 */
function EndShiftModal({
  shift,
  site,
  onClose,
}: {
  shift: Shift;
  site: JobSite | null;
  onClose: () => void;
}) {
  const started = shift.clockInAt.toDate();

  // Every calendar day the shift has been open for, first to today.
  const days = useMemo(() => {
    const out: Date[] = [];
    const cursor = new Date(started);
    cursor.setHours(0, 0, 0, 0);
    const last = new Date();
    last.setHours(0, 0, 0, 0);
    while (cursor <= last && out.length < 31) {
      out.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }, [started]);

  const multiDay = days.length > 1;

  /** "17:30" for a time input, from a Date. */
  const asTimeValue = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  // Later days start out prefilled with the site's own hours when it keeps
  // them, because that is the likeliest answer and the owner can correct it.
  // Never the first day's start, which is the punch that actually happened —
  // and never its finish either when the site's knocking-off time is already
  // past by the time they clocked in, which would prefill a day that ended
  // before it began.
  const startedMinutes = started.getHours() * 60 + started.getMinutes();
  const [entries, setEntries] = useState(() => {
    const siteEnd = site?.shiftEnd ?? '';
    const siteEndMinutes = parseTimeOfDay(siteEnd);
    return days.map((day, i) => ({
      key: dayKey(day),
      start: i === 0 ? asTimeValue(started) : (site?.shiftStart ?? ''),
      end:
        i === 0
          ? multiDay && siteEndMinutes != null && siteEndMinutes > startedMinutes
            ? siteEnd
            : ''
          : siteEnd,
    }));
  });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setEntry = (i: number, patch: Partial<(typeof entries)[number]>) =>
    setEntries((prev) => prev.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  const at = (day: Date, minutes: number) => {
    const d = new Date(day);
    d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    return d;
  };

  /**
   * The filled-in rows, as real dates. A row with no finish time is a day they
   * did not work — including the first, which is somebody who clocked in and
   * went home again.
   */
  const worked = () => {
    const firstEnd = parseTimeOfDay(entries[0].end);
    const extra: WorkedDay[] = [];
    days.forEach((day, i) => {
      if (i === 0) return;
      const startMinutes = parseTimeOfDay(entries[i].start);
      const endMinutes = parseTimeOfDay(entries[i].end);
      if (startMinutes == null || endMinutes == null) return;
      extra.push({ start: at(day, startMinutes), end: at(day, endMinutes) });
    });
    return {
      firstDayEnd: firstEnd == null ? null : at(days[0], firstEnd),
      extraDays: extra,
    };
  };

  const finish = (input: { firstDayEnd: Date | null; extraDays: WorkedDay[] }) =>
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await forceCloseShift(shift, { ...input, note });
        onClose();
      } catch (err) {
        setError(errorMessage(err));
        setBusy(false);
      }
    })();

  const filled = worked();
  const dayCount = (filled.firstDayEnd ? 1 : 0) + filled.extraDays.length;

  return (
    <Modal title={`End ${shift.userDisplayName}'s shift`} onClose={onClose}>
      {error && <Banner kind="error">{error}</Banner>}
      <p>
        They clocked in at <strong>{fmtTime(shift.clockInAt)}</strong> on{' '}
        {started.toLocaleDateString()} and never clocked out
        {multiDay ? ` — ${days.length} days ago.` : '.'}
      </p>

      {multiDay && (
        <p className="hint" style={{ marginTop: 0 }}>
          Fill in the hours they actually worked each day. Each day is recorded as its own shift,
          so the timesheet, the overtime split and each day's rental ticket all come out right.
          Leave a day blank if they did not work it.
        </p>
      )}

      {days.map((day, i) => (
        <label className="field" key={entries[i].key}>
          <span>
            {multiDay
              ? day.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
              : 'When did they actually finish?'}
          </span>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {multiDay && (
              <>
                <input
                  type="time"
                  aria-label={`Start on ${entries[i].key}`}
                  value={entries[i].start}
                  disabled={busy || i === 0}
                  onChange={(e) => setEntry(i, { start: e.target.value })}
                />
                <span>to</span>
              </>
            )}
            <input
              type="time"
              aria-label={`Finish on ${entries[i].key}`}
              value={entries[i].end}
              disabled={busy}
              onChange={(e) => setEntry(i, { end: e.target.value })}
            />
          </div>
          {multiDay && i === 0 && (
            <p className="hint">Their real clock-in. It cannot be moved from here.</p>
          )}
        </label>
      ))}

      <label className="field">
        <span>Note (optional)</span>
        <input
          type="text"
          value={note}
          placeholder="Left the yard at six, phone was dead"
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
        />
      </label>

      <div className="row-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || dayCount === 0}
          onClick={() => finish(filled)}
        >
          {busy
            ? 'Ending…'
            : multiDay
              ? `End shift — ${dayCount} day${dayCount === 1 ? '' : 's'} worked`
              : 'End shift at that time'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => finish({ firstDayEnd: null, extraDays: [] })}
        >
          I don't know
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
      <p className="hint">
        Without any hours the shift is recorded with none, and left in Review, unpaid, until
        somebody enters the real ones.
      </p>
    </Modal>
  );
}
