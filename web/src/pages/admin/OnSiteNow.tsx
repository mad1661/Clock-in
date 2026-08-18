import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { db } from '../../firebase';
import { useAuth } from '../../auth/AuthProvider';
import { forceCloseShift, shiftIsStuck, STUCK_SHIFT_HOURS } from '../../lib/actions';
import { errorMessage } from '../../lib/errors';
import { Banner, Card, EmptyState, FlagList, Modal, Spinner } from '../../components/ui';
import { ShiftDetail } from '../../components/ShiftDetail';
import { elapsedSince, fmtDistance, fmtTime } from '../../lib/format';
import { shortDeviceId } from '../../lib/device';
import { withTimestamps } from '../../lib/snapshot';
import { dayKey } from '../../lib/ticket';
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

      {ending && <EndShiftModal shift={ending} onClose={() => setEnding(null)} />}

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
                      On the clock over {STUCK_SHIFT_HOURS} hours. This is almost certainly a
                      forgotten clock-out{isOwner ? ' — you can end it for them.' : '. An owner can end it for them.'}
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

/**
 * Ends a forgotten shift.
 *
 * Asks for the time the worker actually stopped rather than assuming one. Hours
 * worked have to be recorded and paid whether or not somebody remembered to
 * press a button, so closing a shift at a guessed-low time is not a neutral
 * act — and closing it at no time at all leaves the shift unpaid until the real
 * hours are entered, which the wording here says out loud.
 */
function EndShiftModal({ shift, onClose }: { shift: Shift; onClose: () => void }) {
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = (endedAt: Date | null) =>
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await forceCloseShift(shift, { endedAt, note });
        onClose();
      } catch (err) {
        setError(errorMessage(err));
        setBusy(false);
      }
    })();

  return (
    <Modal title={`End ${shift.userDisplayName}'s shift`} onClose={onClose}>
      {error && <Banner kind="error">{error}</Banner>}
      <p>
        They clocked in at <strong>{fmtTime(shift.clockInAt)}</strong> on{' '}
        {shift.clockInAt.toDate().toLocaleDateString()} and never clocked out.
      </p>
      <label className="field">
        <span>When did they actually finish?</span>
        <input
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          disabled={busy}
        />
      </label>
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
          disabled={busy || !when}
          onClick={() => finish(new Date(when))}
        >
          {busy ? 'Ending…' : 'End shift at that time'}
        </button>
        <button type="button" disabled={busy} onClick={() => finish(null)}>
          I don't know
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
      <p className="hint">
        Without a finish time the shift is recorded with no hours and left in Review, unpaid, until
        somebody enters the real ones.
      </p>
    </Modal>
  );
}
