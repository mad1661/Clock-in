import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from '../../firebase';
import { retireEquipment, upsertEquipment } from '../../lib/actions';
import { errorMessage } from '../../lib/errors';
import { Banner, Card, EmptyState, Modal, Spinner } from '../../components/ui';
import { equipmentLabel, type Equipment as Machine } from '../../lib/types';

/**
 * The yard's machine list.
 *
 * Kept separate from job sites on purpose: a machine moves between jobs over
 * its life, and the rental ticket has to keep naming the same D8T-2 wherever it
 * happens to be that week.
 */
export default function Equipment() {
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [editing, setEditing] = useState<Machine | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRetired, setShowRetired] = useState(false);

  useEffect(() => {
    return onSnapshot(
      query(collection(db, 'equipment'), orderBy('type')),
      (snap) => setMachines(snap.docs.map((d) => ({ ...(d.data() as Machine), id: d.id }))),
      (err) => {
        setMachines([]);
        setError(errorMessage(err));
      },
    );
  }, []);

  const visible = useMemo(
    () => (machines ?? []).filter((m) => showRetired || m.active),
    [machines, showRetired],
  );

  if (!machines) return <Spinner label="Loading equipment…" />;

  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}

      {editing && (
        <MachineForm
          machine={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}

      <Card
        title={`Equipment (${visible.length})`}
        actions={
          <>
            <button type="button" className="small ghost" onClick={() => setShowRetired((v) => !v)}>
              {showRetired ? 'Hide retired' : 'Show retired'}
            </button>
            <button type="button" className="small primary" onClick={() => setEditing('new')}>
              + Add machine
            </button>
          </>
        }
      >
        <p className="hint" style={{ marginTop: 0 }}>
          Machines added here can be assigned to a job site, and an operator picks the one they are
          on when they clock in. That is what fills in the rental ticket.
        </p>

        {visible.length === 0 ? (
          <EmptyState>No equipment yet. Add your first machine.</EmptyState>
        ) : (
          <ul className="list">
            {visible.map((machine) => (
              <li key={machine.id} className="row">
                <div className="row-head">
                  <span className="title">{equipmentLabel(machine)}</span>
                  {!machine.active && <span className="pill pill-error">Retired</span>}
                </div>
                <div className="row-meta">
                  {machine.description && <span>{machine.description}</span>}
                  <span>
                    {machine.hourlyRate == null ? 'No rate set' : `$${machine.hourlyRate}/hr`}
                  </span>
                </div>
                <div className="row-actions">
                  <button type="button" className="small" onClick={() => setEditing(machine)}>
                    Edit
                  </button>
                  {machine.active && (
                    <button
                      type="button"
                      className="small danger"
                      onClick={() =>
                        void (async () => {
                          if (!window.confirm(`Retire ${equipmentLabel(machine)}?`)) return;
                          try {
                            await retireEquipment(machine.id, equipmentLabel(machine));
                          } catch (err) {
                            setError(errorMessage(err));
                          }
                        })()
                      }
                    >
                      Retire
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function MachineForm({
  machine,
  onClose,
  onSaved,
}: {
  machine: Machine | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState(machine?.type ?? '');
  const [machineNo, setMachineNo] = useState(machine?.machineNo ?? '');
  const [description, setDescription] = useState(machine?.description ?? '');
  const [active, setActive] = useState(machine?.active ?? true);
  const [rate, setRate] = useState(machine?.hourlyRate == null ? '' : String(machine.hourlyRate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await upsertEquipment({
        ...(machine ? { id: machine.id } : {}),
        type,
        machineNo,
        description,
        active,
        hourlyRate: rate.trim() === '' ? null : Number(rate),
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={machine ? `Edit ${equipmentLabel(machine)}` : 'Add machine'} onClose={onClose}>
      {error && <Banner kind="error">{error}</Banner>}
      <form onSubmit={onSubmit} style={{ marginTop: error ? '0.9rem' : 0 }}>
        <div className="field">
          <label htmlFor="e-type">Type of equipment</label>
          <input
            id="e-type"
            required
            value={type}
            onChange={(e) => setType(e.target.value)}
            placeholder="D8T"
            autoComplete="off"
          />
          <p className="hint">Exactly as it should print on the ticket.</p>
        </div>

        <div className="field">
          <label htmlFor="e-no">Machine number</label>
          <input
            id="e-no"
            value={machineNo}
            onChange={(e) => setMachineNo(e.target.value)}
            placeholder="2"
            autoComplete="off"
          />
        </div>

        <div className="field">
          <label htmlFor="e-desc">Note (optional)</label>
          <input
            id="e-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Water pull"
            autoComplete="off"
          />
        </div>

        <div className="field">
          <label htmlFor="e-rate">Rental rate ($ per hour)</label>
          <input
            id="e-rate"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="185.00"
          />
          <p className="hint">What the customer is charged for this machine. Change it any time.</p>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', margin: '0.9rem 0' }}>
          <input
            type="checkbox"
            style={{ width: 20, height: 20, minHeight: 20, flex: '0 0 auto' }}
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          In service
        </label>

        <button type="submit" className="primary block" disabled={busy}>
          {busy ? 'Saving…' : machine ? 'Save changes' : 'Add machine'}
        </button>
      </form>
    </Modal>
  );
}
