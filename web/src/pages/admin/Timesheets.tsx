import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Timestamp,
  collection,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type QueryConstraint,
} from 'firebase/firestore';
import { db } from '../../firebase';
import { adjustShift } from '../../lib/actions';
import { errorMessage } from '../../lib/errors';
import { Banner, Card, EmptyState, Modal, Spinner, StatusPill } from '../../components/ui';
import { ShiftDetail } from '../../components/ShiftDetail';
import {
  fmtDate,
  fmtDuration,
  fmtTime,
  localDateInput,
  localDateTimeInput,
} from '../../lib/format';
import { shortDeviceId } from '../../lib/device';
import { overtimeByWorker } from '../../lib/overtime';
import { withTimestamps } from '../../lib/snapshot';
import type { Shift, UserDoc } from '../../lib/types';

const PAGE_SIZE = 300;

function startOfDay(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
}

function endOfDay(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999);
}

export default function Timesheets() {
  const today = new Date();
  const twoWeeksAgo = new Date(today.getTime() - 13 * 86400000);

  const [from, setFrom] = useState(localDateInput(twoWeeksAgo));
  const [to, setTo] = useState(localDateInput(today));
  const [userId, setUserId] = useState('');
  const [workers, setWorkers] = useState<UserDoc[]>([]);
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [open, setOpen] = useState<Shift | null>(null);
  const [editing, setEditing] = useState<Shift | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return onSnapshot(query(collection(db, 'users'), orderBy('displayName')), (snap) =>
      setWorkers(snap.docs.map((d) => ({ ...(d.data() as UserDoc), uid: d.id }))),
    );
  }, []);

  useEffect(() => {
    setShifts(null);
    setError(null);

    const constraints: QueryConstraint[] = [
      where('clockInAt', '>=', Timestamp.fromDate(startOfDay(from))),
      where('clockInAt', '<=', Timestamp.fromDate(endOfDay(to))),
    ];
    if (userId) constraints.unshift(where('userId', '==', userId));

    // A live subscription here would re-render the whole table every time
    // anyone on site taps a button, so this view reads once per filter change.
    void getDocs(
      query(collection(db, 'shifts'), ...constraints, orderBy('clockInAt', 'desc'), limit(PAGE_SIZE)),
    )
      .then((snap) => setShifts(snap.docs.map((d) => withTimestamps<Shift>(d))))
      .catch((err) => {
        setShifts([]);
        setError(errorMessage(err));
      });
  }, [from, to, userId, editing]);

  const overtime = useMemo(() => overtimeByWorker(shifts ?? []), [shifts]);

  const totals = useMemo(() => {
    const list = shifts ?? [];
    const wages = new Map(workers.map((w) => [w.uid, w.hourlyRate ?? null]));

    // Labour cost at each worker's own rate. Anyone with no wage on file is
    // counted separately rather than silently valued at zero — a total that
    // quietly leaves people out is worse than one that says who is missing.
    let cost = 0;
    let unpriced = 0;
    for (const shift of list) {
      const rate = wages.get(shift.userId) ?? null;
      const minutes = shift.durationMinutes ?? 0;
      if (rate == null) {
        if (minutes > 0) unpriced += 1;
      } else {
        cost += (minutes / 60) * rate;
      }
    }

    return {
      count: list.length,
      minutes: list.reduce((sum, s) => sum + (s.durationMinutes ?? 0), 0),
      flagged: list.filter((s) => s.needsReview).length,
      cost,
      unpriced,
    };
  }, [shifts, workers]);

  function exportCsv() {
    const rows = [
      [
        'Worker',
        'Email',
        'Job site',
        'Date',
        'Clock in',
        'Clock out',
        'Minutes',
        'Hours',
        'In method',
        'Out method',
        'In device',
        'In device id',
        'Out device',
        'Out device id',
        'In distance (m)',
        'Out distance (m)',
        'Status',
        'Flags',
        'Review note',
        'Pending change',
        'Offline sync delay (min)',
      ],
      ...(shifts ?? []).map((s) => [
        s.userDisplayName,
        s.userEmail,
        s.jobSiteName,
        fmtDate(s.clockInAt),
        fmtTime(s.clockInAt),
        s.clockOutAt ? fmtTime(s.clockOutAt) : '',
        String(s.durationMinutes ?? ''),
        s.durationMinutes != null ? (s.durationMinutes / 60).toFixed(2) : '',
        s.clockIn.method,
        s.clockOut?.method ?? '',
        s.clockIn.device?.label ?? '',
        shortDeviceId(s.clockIn.device?.id) ?? '',
        s.clockOut?.device?.label ?? '',
        shortDeviceId(s.clockOut?.device?.id) ?? '',
        s.clockIn.distanceMeters != null ? String(s.clockIn.distanceMeters) : '',
        s.clockOut?.distanceMeters != null ? String(s.clockOut.distanceMeters) : '',
        s.needsReview ? 'needs review' : s.review.status,
        s.flags.join(' | '),
        s.review.note ?? '',
        s.hasPendingEdit ? 'yes' : '',
        s.clockIn.offline ? String(s.clockIn.offline.delayMinutes) : '',
      ]),
      [],
      ['California overtime summary — cross-check against payroll, not a payroll calculation'],
      ['Worker', 'Regular hours', 'Overtime (1.5x)', 'Double time (2x)', 'Total hours'],
      ...overtime.map((w) => [
        w.displayName,
        w.split.regularHours.toFixed(2),
        w.split.overtimeHours.toFixed(2),
        w.split.doubleTimeHours.toFixed(2),
        w.split.totalHours.toFixed(2),
      ]),
    ];

    const csv = rows
      .map((row) =>
        row
          // A leading =, +, - or @ makes a spreadsheet treat the cell as a
          // formula, so prefix those with a quote.
          .map((cell) => {
            const safe = /^[=+\-@]/.test(cell) ? `'${cell}` : cell;
            return `"${safe.replace(/"/g, '""')}"`;
          })
          .join(','),
      )
      .join('\r\n');

    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `timesheet-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}

      {open && (
        <Modal title="Shift detail" onClose={() => setOpen(null)}>
          <ShiftDetail shift={open} />
        </Modal>
      )}

      {editing && (
        <AdjustModal
          shift={editing}
          onClose={() => setEditing(null)}
          onError={(msg) => setError(msg)}
        />
      )}

      <Card title="Timesheets">
        <div className="filters">
          <div>
            <label htmlFor="t-from">From</label>
            <input id="t-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label htmlFor="t-to">To</label>
            <input id="t-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <label htmlFor="t-worker">Worker</label>
            <select id="t-worker" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Everyone</option>
              {workers.map((w) => (
                <option key={w.uid} value={w.uid}>
                  {w.displayName}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="totals" style={{ marginTop: '0.9rem' }}>
          <span>
            <strong>{totals.count}</strong> shifts
          </span>
          <span>
            <strong>{fmtDuration(totals.minutes)}</strong> total
          </span>
          <span>
            <strong>{(totals.minutes / 60).toFixed(2)}</strong> hours
          </span>
          {totals.cost > 0 && (
            <span>
              <strong>
                {totals.cost.toLocaleString(undefined, { style: 'currency', currency: 'USD' })}
              </strong>{' '}
              labour
            </span>
          )}
          {totals.unpriced > 0 && (
            <span title="Set an hourly wage under Workers">
              <strong>{totals.unpriced}</strong> shifts with no wage set
            </span>
          )}
          {totals.flagged > 0 && (
            <span>
              <strong>{totals.flagged}</strong> awaiting review
            </span>
          )}
          <button
            type="button"
            className="small"
            onClick={exportCsv}
            disabled={!shifts?.length}
            style={{ marginLeft: 'auto' }}
          >
            Export CSV
          </button>
        </div>
      </Card>

      {overtime.length > 0 && (
        <Card title="California overtime">
          <p className="hint" style={{ marginTop: 0 }}>
            Split week by week using California's daily rules — over 8 hours in a day is overtime
            even when the week totals 40. A cross-check for payroll, not a payroll calculation:
            it does not know about alternative workweek agreements, exempt staff or meal premiums.
          </p>
          <ul className="list">
            {overtime.map((w) => (
              <li key={w.userId} className="row">
                <div className="row-head">
                  <span className="title">{w.displayName}</span>
                  <span className="pill pill-muted">{w.split.totalHours.toFixed(2)} h</span>
                </div>
                <div className="status-grid">
                  <div className="stat">
                    <div className="k">Regular</div>
                    <div className="v">{w.split.regularHours.toFixed(2)}</div>
                  </div>
                  <div className="stat">
                    <div className="k">Overtime 1.5&times;</div>
                    <div className="v">{w.split.overtimeHours.toFixed(2)}</div>
                  </div>
                  <div className="stat">
                    <div className="k">Double 2&times;</div>
                    <div className="v">{w.split.doubleTimeHours.toFixed(2)}</div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!shifts ? (
        <Spinner label="Loading shifts…" />
      ) : shifts.length === 0 ? (
        <Card>
          <EmptyState>No shifts in that range.</EmptyState>
        </Card>
      ) : (
        <Card>
          {shifts.length === PAGE_SIZE && (
            <Banner kind="info">
              Showing the most recent {PAGE_SIZE} shifts. Narrow the dates to see the rest.
            </Banner>
          )}
          <ul className="list">
            {shifts.map((shift) => (
              <li key={shift.id} className="row">
                <div className="row-head">
                  <span className="title">{shift.userDisplayName}</span>
                  {shift.status === 'open' ? (
                    <span className="pill pill-muted">On shift</span>
                  ) : (
                    <StatusPill shift={shift} />
                  )}
                  {shift.hasPendingEdit && (
                    <span className="pill pill-brand">Change requested</span>
                  )}
                </div>
                <div className="row-meta">
                  <span>{shift.jobSiteName}</span>
                  <span>{fmtDate(shift.clockInAt)}</span>
                  <span>
                    {fmtTime(shift.clockInAt)} → {shift.clockOutAt ? fmtTime(shift.clockOutAt) : '…'}
                  </span>
                  <span>{fmtDuration(shift.durationMinutes)}</span>
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
                  {/* Clocking out on a different handset is worth seeing at a
                      glance; the model names are often identical, so the id is
                      what actually distinguishes them. */}
                  {shift.clockOut?.device?.id &&
                    shift.clockOut.device.id !== shift.clockIn.device?.id && (
                      <>
                        <span>· out on {shift.clockOut.device.label ?? 'another device'}</span>
                        <span className="pill pill-muted">
                          {shortDeviceId(shift.clockOut.device.id)}
                        </span>
                      </>
                    )}
                </div>
                <div className="row-actions">
                  <button type="button" className="small" onClick={() => setOpen(shift)}>
                    Details
                  </button>
                  <button type="button" className="small" onClick={() => setEditing(shift)}>
                    Adjust times
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function AdjustModal({
  shift,
  onClose,
  onError,
}: {
  shift: Shift;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [clockInAt, setClockInAt] = useState(localDateTimeInput(shift.clockInAt.toDate()));
  const [clockOutAt, setClockOutAt] = useState(
    shift.clockOutAt ? localDateTimeInput(shift.clockOutAt.toDate()) : '',
  );
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!note.trim()) {
      onError('A reason is required for every manual adjustment.');
      return;
    }
    setBusy(true);
    try {
      await adjustShift(
        shift,
        {
          clockInAt: new Date(clockInAt),
          clockOutAt: clockOutAt ? new Date(clockOutAt) : null,
        },
        note,
      );
      onClose();
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Adjust ${shift.userDisplayName}'s shift`} onClose={onClose}>
      <Banner kind="warning">
        The original location, photo and device evidence is never changed — only the times. Every
        adjustment is recorded in the audit log with your name against it.
      </Banner>

      <form onSubmit={onSubmit} style={{ marginTop: '0.9rem' }}>
        <div className="field">
          <label htmlFor="a-in">Clock in</label>
          <input
            id="a-in"
            type="datetime-local"
            required
            value={clockInAt}
            onChange={(e) => setClockInAt(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="a-out">Clock out</label>
          <input
            id="a-out"
            type="datetime-local"
            value={clockOutAt}
            onChange={(e) => setClockOutAt(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="a-note">Reason (required)</label>
          <textarea
            id="a-note"
            required
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Phone died at 16:00; foreman confirmed Sam left site at 17:30."
          />
        </div>
        <button type="submit" className="primary block" disabled={busy}>
          {busy ? 'Saving…' : 'Save adjustment'}
        </button>
      </form>
    </Modal>
  );
}
