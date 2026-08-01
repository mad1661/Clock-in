import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../auth/AuthProvider';
import { api, errorMessage } from '../lib/api';
import { Banner, Card, EmptyState, FlagList, Modal, Spinner, StatusPill } from '../components/ui';
import { fmtDate, fmtDateTime, fmtDuration, fmtTime, localDateTimeInput } from '../lib/format';
import type { Shift } from '../lib/types';

/** Mirrors POLICY.maxEditRequestAgeDays in functions/src/config.ts. */
const MAX_EDIT_AGE_DAYS = 14;

export default function MyTimesheet() {
  const { user } = useAuth();
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [editing, setEditing] = useState<Shift | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <>
      {error && <Banner kind="error">{error}</Banner>}

      {editing && (
        <RequestChangeModal shift={editing} onClose={() => setEditing(null)} />
      )}

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
                  {shift.hasPendingEdit && (
                    <span className="pill pill-brand">Change requested</span>
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

                <EditState shift={shift} onError={setError} />
                <EditActions shift={shift} onRequest={() => setEditing(shift)} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function shiftAgeDays(shift: Shift): number {
  return (Date.now() - shift.clockInAt.toMillis()) / 86400000;
}

/** Shows a pending request, or how the last one was resolved. */
function EditState({ shift, onError }: { shift: Shift; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);

  if (shift.pendingEdit) {
    const p = shift.pendingEdit;
    return (
      <div className="edit-note edit-note-pending">
        <strong>Waiting on your supervisor</strong>
        <div className="row-meta">
          <span>
            You asked for {fmtTime(p.requestedClockInAt)} →{' '}
            {p.requestedClockOutAt ? fmtTime(p.requestedClockOutAt) : '…'}
          </span>
          <span>Sent {fmtDateTime(p.requestedAt)}</span>
        </div>
        <p className="hint">“{p.reason}”</p>
        <button
          type="button"
          className="small"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api
              .cancelShiftEdit({ shiftId: shift.id })
              .catch((err) => onError(errorMessage(err)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Withdrawing…' : 'Withdraw request'}
        </button>
      </div>
    );
  }

  const last = shift.lastEdit;
  if (!last || last.status === 'withdrawn') return null;

  return (
    <div className={`edit-note edit-note-${last.status}`}>
      <strong>
        {last.status === 'approved'
          ? 'Your change was approved'
          : 'Your change was turned down'}
      </strong>
      <p className="hint" style={{ marginTop: '0.15rem' }}>
        You asked: “{last.reason}”
        {last.note ? ` — Supervisor: “${last.note}”` : ''}
      </p>
    </div>
  );
}

function EditActions({ shift, onRequest }: { shift: Shift; onRequest: () => void }) {
  if (shift.status === 'open' || shift.hasPendingEdit) return null;

  if (shiftAgeDays(shift) > MAX_EDIT_AGE_DAYS) {
    return (
      <p className="hint">
        Too old to correct yourself — ask your supervisor to adjust this one.
      </p>
    );
  }

  return (
    <div className="row-actions">
      <button type="button" className="small" onClick={onRequest}>
        Request a change
      </button>
    </div>
  );
}

/**
 * A worker proposes corrected times.
 *
 * They cannot change their own hours — the request goes to a supervisor, and
 * the shift is untouched until it is approved. That is the whole point: if
 * workers could edit their own timesheets, every location check in this app
 * would be decoration.
 */
function RequestChangeModal({ shift, onClose }: { shift: Shift; onClose: () => void }) {
  const [clockInAt, setClockInAt] = useState(localDateTimeInput(shift.clockInAt.toDate()));
  const [clockOutAt, setClockOutAt] = useState(
    shift.clockOutAt ? localDateTimeInput(shift.clockOutAt.toDate()) : '',
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);

    if (!reason.trim()) {
      setLocalError('Tell your supervisor what happened — they need a reason to approve it.');
      return;
    }

    setBusy(true);
    try {
      await api.requestShiftEdit({
        shiftId: shift.id,
        clockInAt: new Date(clockInAt).getTime(),
        ...(clockOutAt ? { clockOutAt: new Date(clockOutAt).getTime() } : {}),
        reason: reason.trim(),
      });
      onClose();
    } catch (err) {
      setLocalError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Request a change" onClose={onClose}>
      <Banner kind="info">
        Your supervisor has to approve this before your hours change. Nothing on this shift moves
        until they do.
      </Banner>

      {localError && (
        <div style={{ marginTop: '0.9rem' }}>
          <Banner kind="error">{localError}</Banner>
        </div>
      )}

      <div className="row" style={{ marginTop: '0.9rem' }}>
        <div className="row-head">
          <span className="title">{shift.jobSiteName}</span>
        </div>
        <div className="row-meta">
          <span>Recorded: {fmtDateTime(shift.clockInAt)}</span>
          <span>→ {shift.clockOutAt ? fmtTime(shift.clockOutAt) : '—'}</span>
          <span>{fmtDuration(shift.durationMinutes)}</span>
        </div>
      </div>

      <form onSubmit={onSubmit} style={{ marginTop: '0.9rem' }}>
        <div className="field">
          <label htmlFor="e-in">Start time it should be</label>
          <input
            id="e-in"
            type="datetime-local"
            required
            value={clockInAt}
            onChange={(e) => setClockInAt(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="e-out">Finish time it should be</label>
          <input
            id="e-out"
            type="datetime-local"
            value={clockOutAt}
            onChange={(e) => setClockOutAt(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="e-reason">What happened? (required)</label>
          <textarea
            id="e-reason"
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. My phone died at 3pm — I actually finished at 4:30."
          />
        </div>
        <button type="submit" className="primary block" disabled={busy}>
          {busy ? 'Sending…' : 'Send to my supervisor'}
        </button>
      </form>
    </Modal>
  );
}
