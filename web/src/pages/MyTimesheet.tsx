import { useEffect, useMemo, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../auth/AuthProvider';
import { Card, EmptyState, FlagList, Spinner, StatusPill } from '../components/ui';
import { fmtDate, fmtDuration, fmtTime } from '../lib/format';
import type { Shift } from '../lib/types';

export default function MyTimesheet() {
  const { user } = useAuth();
  const [shifts, setShifts] = useState<Shift[] | null>(null);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(
      query(
        collection(db, 'shifts'),
        where('userId', '==', user.uid),
        orderBy('clockInAt', 'desc'),
        limit(60),
      ),
      (snap) => setShifts(snap.docs.map((d) => ({ ...(d.data() as Shift), id: d.id }))),
      () => setShifts([]),
    );
  }, [user]);

  const totalMinutes = useMemo(
    () => (shifts ?? []).reduce((sum, s) => sum + (s.durationMinutes ?? 0), 0),
    [shifts],
  );

  if (!shifts) return <Spinner label="Loading your hours…" />;

  return (
    <Card title="My hours">
      <div className="totals">
        <span>
          Last {shifts.length} shift{shifts.length === 1 ? '' : 's'}
        </span>
        <span>
          Total: <strong>{fmtDuration(totalMinutes)}</strong>
        </span>
      </div>

      {shifts.length === 0 ? (
        <EmptyState>Nothing recorded yet. Your shifts will show up here.</EmptyState>
      ) : (
        <ul className="list" style={{ marginTop: '0.9rem' }}>
          {shifts.map((shift) => (
            <li key={shift.id} className="row">
              <div className="row-head">
                <span className="title">{shift.jobSiteName}</span>
                {shift.status === 'open' ? (
                  <span className="pill pill-muted">On shift</span>
                ) : (
                  <StatusPill shift={shift} />
                )}
              </div>
              <div className="row-meta">
                <span>{fmtDate(shift.clockInAt)}</span>
                <span>
                  {fmtTime(shift.clockInAt)} → {shift.clockOutAt ? fmtTime(shift.clockOutAt) : '…'}
                </span>
                <span>{fmtDuration(shift.durationMinutes)}</span>
              </div>
              <FlagList flags={shift.flags} />
              {shift.review.status === 'rejected' && shift.review.note && (
                <p className="hint" style={{ color: 'var(--danger)' }}>
                  Rejected: {shift.review.note}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
