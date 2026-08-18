import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { db } from '../../firebase';
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
  const [shifts, setShifts] = useState<Shift[] | null>(null);
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
                  {longRun && (
                    <p className="hint">
                      On the clock over 10 hours — check they have not forgotten to clock out.
                    </p>
                  )}
                  <FlagList flags={shift.flags} />
                  <div className="row-actions">
                    <button type="button" className="small" onClick={() => setOpen(shift)}>
                      Details
                    </button>
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
