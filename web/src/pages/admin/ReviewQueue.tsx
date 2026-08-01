import { useEffect, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { api, errorMessage } from '../../lib/api';
import { Banner, Card, EmptyState, Modal, Spinner } from '../../components/ui';
import { ShiftDetail } from '../../components/ShiftDetail';
import { fmtDate, fmtDuration } from '../../lib/format';
import { FLAG_LABELS } from '../../lib/policy';
import type { Shift } from '../../lib/types';

export default function ReviewQueue() {
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [open, setOpen] = useState<Shift | null>(null);
  const [error, setError] = useState<string | null>(null);

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
