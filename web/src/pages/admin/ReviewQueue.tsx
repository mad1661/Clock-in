import { useEffect, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { api, errorMessage } from '../../lib/api';
import { Banner, Card, EmptyState, Modal, Spinner } from '../../components/ui';
import { ShiftDetail } from '../../components/ShiftDetail';
import { fmtDate, fmtDateTime, fmtDuration, fmtTime } from '../../lib/format';
import { FLAG_LABELS } from '../../lib/policy';
import type { Shift } from '../../lib/types';

export default function ReviewQueue() {
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [edits, setEdits] = useState<Shift[] | null>(null);
  const [open, setOpen] = useState<Shift | null>(null);
  const [openEdit, setOpenEdit] = useState<Shift | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Worker-requested corrections are a separate queue from unverified punches:
  // an approved shift can still have a change waiting on it, and a supervisor
  // ruling on hours is a different decision from vouching for a location.
  useEffect(() => {
    return onSnapshot(
      query(
        collection(db, 'shifts'),
        where('hasPendingEdit', '==', true),
        orderBy('clockInAt', 'desc'),
        limit(100),
      ),
      (snap) => setEdits(snap.docs.map((d) => ({ ...(d.data() as Shift), id: d.id }))),
      (err) => {
        setEdits([]);
        setError(errorMessage(err));
      },
    );
  }, []);

  useEffect(() => {
    return onSnapshot(
      query(
        collection(db, 'shifts'),
        where('needsReview', '==', true),
        orderBy('clockInAt', 'desc'),
        limit(100),
      ),
      (snap) => setShifts(snap.docs.map((d) => ({ ...(d.data() as Shift), id: d.id }))),
      (err) => {
        setShifts([]);
        setError(errorMessage(err));
      },
    );
  }, []);

  if (!shifts) return <Spinner label="Loading review queue…" />;

  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}

      {openEdit && (
        <EditReviewModal
          shift={openEdit}
          onClose={() => setOpenEdit(null)}
          onError={(msg) => setError(msg)}
        />
      )}

      <Card title={`Change requests (${edits?.length ?? 0})`}>
        <p className="hint" style={{ marginTop: 0 }}>
          Workers cannot change their own hours. These are corrections they have asked you to
          approve — nothing moves on the timesheet until you do.
        </p>

        {!edits ? (
          <Spinner label="Loading change requests…" />
        ) : edits.length === 0 ? (
          <EmptyState>No outstanding change requests.</EmptyState>
        ) : (
          <ul className="list">
            {edits.map((shift) => (
              <li key={shift.id} className="row">
                <div className="row-head">
                  <span className="title">{shift.userDisplayName}</span>
                  <span className="pill pill-brand">Change requested</span>
                </div>
                <div className="row-meta">
                  <span>{shift.jobSiteName}</span>
                  <span>{fmtDate(shift.clockInAt)}</span>
                </div>
                {shift.pendingEdit && (
                  <div className="row-meta">
                    <span>
                      {fmtTime(shift.pendingEdit.originalClockInAt)} →{' '}
                      {shift.pendingEdit.originalClockOutAt
                        ? fmtTime(shift.pendingEdit.originalClockOutAt)
                        : '—'}
                    </span>
                    <span aria-hidden="true">becomes</span>
                    <strong>
                      {fmtTime(shift.pendingEdit.requestedClockInAt)} →{' '}
                      {shift.pendingEdit.requestedClockOutAt
                        ? fmtTime(shift.pendingEdit.requestedClockOutAt)
                        : '—'}
                    </strong>
                  </div>
                )}
                <div className="row-actions">
                  <button type="button" className="small primary" onClick={() => setOpenEdit(shift)}>
                    Review change
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {open && (
        <ReviewModal
          shift={open}
          onClose={() => setOpen(null)}
          onError={(msg) => setError(msg)}
        />
      )}

      <Card title={`Needs review (${shifts.length})`}>
        <p className="hint" style={{ marginTop: 0 }}>
          Anything the app could not verify automatically lands here. Nothing is thrown away — the
          hours are already recorded, they just need your sign-off.
        </p>

        {shifts.length === 0 ? (
          <EmptyState>Nothing to review. Everything has been verified automatically.</EmptyState>
        ) : (
          <ul className="list">
            {shifts.map((shift) => (
              <li key={shift.id} className="row">
                <div className="row-head">
                  <span className="title">{shift.userDisplayName}</span>
                  {shift.status === 'open' && <span className="pill pill-muted">Still on shift</span>}
                </div>
                <div className="row-meta">
                  <span>{shift.jobSiteName}</span>
                  <span>{fmtDate(shift.clockInAt)}</span>
                  <span>{fmtDuration(shift.durationMinutes)}</span>
                </div>
                <div className="row-meta">
                  <span>{shift.flags.map((f) => FLAG_LABELS[f] ?? f).join(' · ')}</span>
                </div>
                <div className="row-actions">
                  <button type="button" className="small primary" onClick={() => setOpen(shift)}>
                    Review
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function ReviewModal({
  shift,
  onClose,
  onError,
}: {
  shift: Shift;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function decide(decision: 'approved' | 'rejected') {
    if (decision === 'rejected' && !note.trim()) {
      onError('Add a reason before rejecting — the worker sees it on their timesheet.');
      return;
    }
    setBusy(true);
    try {
      await api.reviewShift({ shiftId: shift.id, decision, note: note.trim() || undefined });
      onClose();
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Review shift" onClose={onClose}>
      <ShiftDetail shift={shift} />

      {shift.status === 'open' ? (
        <Banner kind="info">
          This shift is still open. It can be reviewed once the worker clocks out, or after the
          nightly sweep closes it.
        </Banner>
      ) : (
        <>
          <div className="field" style={{ marginTop: '1rem' }}>
            <label htmlFor="review-note">Note (required to reject)</label>
            <textarea
              id="review-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Confirmed with the site foreman that Sam was on site."
            />
          </div>

          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button
              type="button"
              className="success"
              style={{ flex: 1 }}
              disabled={busy}
              onClick={() => void decide('approved')}
            >
              Approve
            </button>
            <button
              type="button"
              className="danger"
              style={{ flex: 1 }}
              disabled={busy}
              onClick={() => void decide('rejected')}
            >
              Reject
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

/**
 * Supervisor decision on a worker's requested correction.
 *
 * Shows the recorded times against the proposed ones, and the full evidence
 * underneath, so the call is made on what was actually captured rather than on
 * the worker's account of it alone.
 */
function EditReviewModal({
  shift,
  onClose,
  onError,
}: {
  shift: Shift;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = shift.pendingEdit;

  if (!pending) return null;

  const newDurationMinutes = pending.requestedClockOutAt
    ? Math.round(
        (pending.requestedClockOutAt.toMillis() - pending.requestedClockInAt.toMillis()) / 60000,
      )
    : null;

  async function decide(decision: 'approved' | 'rejected') {
    if (decision === 'rejected' && !note.trim()) {
      onError('Add a reason before turning it down — the worker sees it on their timesheet.');
      return;
    }
    setBusy(true);
    try {
      await api.reviewShiftEdit({ shiftId: shift.id, decision, note: note.trim() || undefined });
      onClose();
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`${shift.userDisplayName} — requested change`} onClose={onClose}>
      <Banner kind="info" title="Their reason">
        “{pending.reason}”
        <p className="hint" style={{ marginTop: '0.35rem' }}>
          Requested {fmtDateTime(pending.requestedAt)}
        </p>
      </Banner>

      <div className="compare" style={{ marginTop: '0.9rem' }}>
        <div className="compare-side">
          <div className="k">Recorded</div>
          <div className="v">{fmtTime(pending.originalClockInAt)}</div>
          <div className="v">
            {pending.originalClockOutAt ? fmtTime(pending.originalClockOutAt) : '—'}
          </div>
          <div className="hint">{fmtDuration(shift.durationMinutes)}</div>
        </div>
        <div className="compare-arrow" aria-hidden="true">
          →
        </div>
        <div className="compare-side compare-proposed">
          <div className="k">Requested</div>
          <div className="v">{fmtTime(pending.requestedClockInAt)}</div>
          <div className="v">
            {pending.requestedClockOutAt ? fmtTime(pending.requestedClockOutAt) : '—'}
          </div>
          <div className="hint">{fmtDuration(newDurationMinutes)}</div>
        </div>
      </div>

      <details style={{ marginTop: '0.9rem' }}>
        <summary className="hint" style={{ cursor: 'pointer' }}>
          What was actually captured
        </summary>
        <div style={{ marginTop: '0.6rem' }}>
          <ShiftDetail shift={shift} />
        </div>
      </details>

      <div className="field" style={{ marginTop: '1rem' }}>
        <label htmlFor="edit-note">Note (required to turn down)</label>
        <textarea
          id="edit-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Confirmed with the foreman that Pat stayed until 16:30."
        />
      </div>

      <div style={{ display: 'flex', gap: '0.6rem' }}>
        <button
          type="button"
          className="success"
          style={{ flex: 1 }}
          disabled={busy}
          onClick={() => void decide('approved')}
        >
          Approve change
        </button>
        <button
          type="button"
          className="danger"
          style={{ flex: 1 }}
          disabled={busy}
          onClick={() => void decide('rejected')}
        >
          Turn down
        </button>
      </div>
    </Modal>
  );
}
