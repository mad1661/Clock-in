import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useAuth } from '../../auth/AuthProvider';
import { errorMessage } from '../../lib/errors';
import { withTimestamps } from '../../lib/snapshot';
import { dayBounds, dayKey } from '../../lib/ticket';
import { isTimecardSite } from '../../lib/timecard';
import { elapsedSince } from '../../lib/format';
import { Banner, Card, Spinner } from '../../components/ui';
import type { Equipment, JobSite, Shift, UserDoc } from '../../lib/types';

/**
 * Where a supervisor lands.
 *
 * They used to land on the clock screen — a page most of them never use — and
 * had to know which of nine tabs answered their question. This answers the
 * three they actually open the app for: who is out there, what needs signing
 * off, and where is today's ticket. On a fresh company it answers a fourth:
 * what still has to be set up before any of it works.
 */
export default function Home() {
  const { profile } = useAuth();
  const [openShifts, setOpenShifts] = useState<Shift[] | null>(null);
  const [todayShifts, setTodayShifts] = useState<Shift[]>([]);
  const [needsReview, setNeedsReview] = useState(0);
  const [pendingEdits, setPendingEdits] = useState(0);
  const [sites, setSites] = useState<JobSite[] | null>(null);
  const [machines, setMachines] = useState<Equipment[] | null>(null);
  const [crew, setCrew] = useState<UserDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const today = dayKey(new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const fail = (err: Error) => setError(errorMessage(err));
    const unsubs = [
      onSnapshot(
        query(collection(db, 'shifts'), where('status', '==', 'open')),
        (snap) => setOpenShifts(snap.docs.map((d) => withTimestamps<Shift>(d))),
        (err) => {
          setOpenShifts([]);
          fail(err);
        },
      ),
      onSnapshot(
        query(collection(db, 'shifts'), where('needsReview', '==', true)),
        (snap) => setNeedsReview(snap.size),
        () => setNeedsReview(0),
      ),
      onSnapshot(
        query(collection(db, 'shifts'), where('hasPendingEdit', '==', true)),
        (snap) => setPendingEdits(snap.size),
        () => setPendingEdits(0),
      ),
      onSnapshot(
        query(collection(db, 'jobSites')),
        (snap) => setSites(snap.docs.map((d) => ({ ...(d.data() as JobSite), id: d.id }))),
        () => setSites([]),
      ),
      onSnapshot(
        query(collection(db, 'equipment')),
        (snap) => setMachines(snap.docs.map((d) => ({ ...(d.data() as Equipment), id: d.id }))),
        () => setMachines([]),
      ),
      onSnapshot(
        query(collection(db, 'users')),
        (snap) => setCrew(snap.docs.map((d) => ({ ...(d.data() as UserDoc), uid: d.id }))),
        () => setCrew([]),
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  // Everything clocked in today, so the home page can say which sites have a
  // ticket worth opening. Bounded to the day rather than listening to the whole
  // shifts collection.
  useEffect(() => {
    const { start, end } = dayBounds(today);
    return onSnapshot(
      query(
        collection(db, 'shifts'),
        where('clockInAt', '>=', start),
        where('clockInAt', '<=', end),
      ),
      (snap) => setTodayShifts(snap.docs.map((d) => withTimestamps<Shift>(d))),
      () => setTodayShifts([]),
    );
  }, [today]);

  const activeSites = useMemo(() => (sites ?? []).filter((s) => s.active), [sites]);

  /** What is still missing before the app can do its job. */
  const setupSteps = useMemo(() => {
    if (!sites || !machines || !crew) return [];
    return [
      {
        done: crew.filter((u) => u.active).length > 1,
        label: 'Add your crew',
        detail: 'Nobody can clock in until they have a login.',
        to: '/admin/workers',
      },
      {
        done: activeSites.length > 0,
        label: 'Add a job site',
        detail: 'The boundary is what confirms somebody is actually there.',
        to: '/admin/sites',
      },
      {
        done: machines.filter((m) => m.active).length > 0,
        label: 'Add your equipment',
        detail: 'Needed for the rental ticket. Skip it if you only track hours.',
        to: '/admin/equipment',
      },
    ];
  }, [sites, machines, crew, activeSites]);

  const outstanding = setupSteps.filter((s) => !s.done);

  const ticketSites = useMemo(() => {
    const counts = new Map<string, { name: string; people: Set<string> }>();
    for (const shift of todayShifts) {
      const entry = counts.get(shift.jobSiteId) ?? {
        name: shift.jobSiteName,
        people: new Set<string>(),
      };
      entry.people.add(shift.userId);
      counts.set(shift.jobSiteId, entry);
    }
    // Yard hours are payroll, not billing — their day goes on the weekly
    // timecard, so the row here points there instead of at a rental ticket.
    const yardIds = new Set((sites ?? []).filter(isTimecardSite).map((s) => s.id));
    return [...counts.entries()].map(([id, v]) => ({
      id,
      name: v.name,
      people: v.people.size,
      timecards: yardIds.has(id),
    }));
  }, [todayShifts, sites]);

  if (openShifts === null || sites === null) return <Spinner label="Loading…" />;

  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}

      {outstanding.length > 0 && (
        <Card title="Finish setting up">
          <p className="hint" style={{ marginTop: 0 }}>
            {outstanding.length} of {setupSteps.length} still to do.
          </p>
          <ul className="list">
            {setupSteps.map((step) => (
              <li key={step.to} className="row">
                <div className="row-head">
                  <span className="title">
                    {step.done ? '✓ ' : ''}
                    {step.label}
                  </span>
                  {step.done && <span className="pill pill-success">Done</span>}
                </div>
                <div className="row-meta">
                  <span>{step.detail}</span>
                </div>
                {!step.done && (
                  <div className="row-actions">
                    <Link className="small primary" to={step.to}>
                      {step.label}
                    </Link>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title={`On site now (${openShifts.length})`}
        actions={
          <Link className="small" to="/admin/on-site">
            Open board
          </Link>
        }
      >
        {openShifts.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            Nobody is clocked in.
          </p>
        ) : (
          <ul className="list">
            {openShifts.slice(0, 6).map((shift) => (
              <li key={shift.id} className="row">
                <div className="row-head">
                  <span className="title">{shift.userDisplayName}</span>
                  <span>{elapsedSince(shift.clockInAt.toMillis(), now)}</span>
                </div>
                <div className="row-meta">
                  <span>{shift.jobSiteName}</span>
                  {shift.equipmentType && (
                    <span>
                      {shift.equipmentType}
                      {shift.machineNo ? `-${shift.machineNo}` : ''}
                    </span>
                  )}
                </div>
              </li>
            ))}
            {openShifts.length > 6 && (
              <li className="row">
                <span className="hint">and {openShifts.length - 6} more…</span>
              </li>
            )}
          </ul>
        )}
      </Card>

      {(needsReview > 0 || pendingEdits > 0) && (
        <Card title="Waiting on you">
          <ul className="list">
            {needsReview > 0 && (
              <li className="row">
                <div className="row-head">
                  <span className="title">
                    {needsReview} shift{needsReview === 1 ? '' : 's'} to approve
                  </span>
                </div>
                <div className="row-meta">
                  <span>The app could not confirm these were on site.</span>
                </div>
                <div className="row-actions">
                  <Link className="small primary" to="/admin/review">
                    Review
                  </Link>
                </div>
              </li>
            )}
            {pendingEdits > 0 && (
              <li className="row">
                <div className="row-head">
                  <span className="title">
                    {pendingEdits} correction{pendingEdits === 1 ? '' : 's'} requested
                  </span>
                </div>
                <div className="row-meta">
                  <span>Hours do not move until you approve them.</span>
                </div>
                <div className="row-actions">
                  <Link className="small primary" to="/admin/review">
                    Review
                  </Link>
                </div>
              </li>
            )}
          </ul>
        </Card>
      )}

      <Card
        title="Today's rental tickets"
        actions={
          <Link className="small" to="/admin/ticket">
            All tickets
          </Link>
        }
      >
        {ticketSites.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            Nobody has clocked in today yet, so there is nothing to bill.
          </p>
        ) : (
          <ul className="list">
            {ticketSites.map((site) => (
              <li key={site.id} className="row">
                <div className="row-head">
                  <span className="title">{site.name}</span>
                </div>
                <div className="row-meta">
                  <span>
                    {site.people} {site.people === 1 ? 'person' : 'people'} today
                  </span>
                </div>
                <div className="row-actions">
                  {site.timecards ? (
                    <Link className="small primary" to="/admin/timecards">
                      Open timecards
                    </Link>
                  ) : (
                    <Link
                      className="small primary"
                      to={`/admin/ticket?site=${site.id}&date=${today}`}
                    >
                      Open ticket
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Your own hours">
        <p className="hint" style={{ marginTop: 0 }}>
          Signed in as {profile?.displayName ?? profile?.email}.
        </p>
        <div className="row-actions">
          <Link className="small" to="/clock">
            Clock in or out
          </Link>
          <Link className="small" to="/timesheet">
            My hours
          </Link>
        </div>
      </Card>
    </>
  );
}
