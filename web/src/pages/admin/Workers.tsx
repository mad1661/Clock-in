import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useAuth } from '../../auth/AuthProvider';
import {
  createWorker,
  sendWorkerPasswordReset,
  setWorkerActive,
  transferOwnership,
  updateWorker,
} from '../../lib/actions';
import { errorMessage } from '../../lib/errors';
import { Banner, Card, EmptyState, Modal, Spinner } from '../../components/ui';
import { equipmentLabel, type Equipment, type JobSite, type Role, type UserDoc } from '../../lib/types';

// Avoids 0/O and 1/l/I, which get misread off a screen and mistyped on a phone.
const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function makePassword(length = 14): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
}

interface IssuedCredential {
  displayName: string;
  email: string;
  password: string;
}

export default function Workers() {
  const { profile, ownerUid, isOwner } = useAuth();
  const [workers, setWorkers] = useState<UserDoc[] | null>(null);
  const [sites, setSites] = useState<JobSite[]>([]);
  const [machines, setMachines] = useState<Equipment[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<UserDoc | null>(null);
  const [credential, setCredential] = useState<IssuedCredential | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  useEffect(() => {
    return onSnapshot(
      query(collection(db, 'users'), orderBy('displayName')),
      (snap) => setWorkers(snap.docs.map((d) => ({ ...(d.data() as UserDoc), uid: d.id }))),
      (err) => {
        setWorkers([]);
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
    return onSnapshot(query(collection(db, 'equipment'), where('active', '==', true)), (snap) =>
      setMachines(snap.docs.map((d) => ({ ...(d.data() as Equipment), id: d.id }))),
    );
  }, []);

  const visible = useMemo(
    () => (workers ?? []).filter((w) => showInactive || w.active),
    [workers, showInactive],
  );

  async function run(fn: () => Promise<void>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (!workers) return <Spinner label="Loading employees…" />;

  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}

      {credential && (
        <Modal title="One-time password" onClose={() => setCredential(null)}>
          <Banner kind="warning" title="Copy this now">
            This password is shown once and is not stored anywhere. If you lose it, reset it from
            this page.
          </Banner>
          <div style={{ marginTop: '0.9rem' }}>
            <p>
              <strong>{credential.displayName}</strong>
              <br />
              <span className="mono">{credential.email}</span>
            </p>
            <div className="credential">
              <span className="mono">{credential.password}</span>
              <button
                type="button"
                className="small"
                onClick={() => void navigator.clipboard?.writeText(credential.password)}
              >
                Copy
              </button>
            </div>
            <p className="hint">
              Tell them to sign in and change it straight away from the Account tab.
            </p>
          </div>
          <button
            type="button"
            className="primary block"
            style={{ marginTop: '0.9rem' }}
            onClick={() => setCredential(null)}
          >
            Done
          </button>
        </Modal>
      )}

      {showAdd && (
        <WorkerForm
          sites={sites}
          machines={machines}
          onClose={() => setShowAdd(false)}
          onSaved={(cred) => {
            setShowAdd(false);
            setCredential(cred ?? null);
          }}
        />
      )}

      {editing && (
        <WorkerForm
          sites={sites}
          machines={machines}
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}

      <Card
        title={`Employees (${visible.length})`}
        actions={
          <>
            <button type="button" className="small ghost" onClick={() => setShowInactive((v) => !v)}>
              {showInactive ? 'Hide deactivated' : 'Show deactivated'}
            </button>
            <button type="button" className="small primary" onClick={() => setShowAdd(true)}>
              + Add employee
            </button>
          </>
        }
      >
        {visible.length === 0 ? (
          <EmptyState>No employees yet. Add your first one.</EmptyState>
        ) : (
          <ul className="list">
            {visible.map((worker) => (
              <li key={worker.uid} className="row">
                <div className="row-head">
                  <span className="title">{worker.displayName}</span>
                  {worker.uid === ownerUid && <span className="pill pill-success">Owner</span>}
                  {worker.role === 'admin' && worker.uid !== ownerUid && (
                    <span className="pill pill-success">Supervisor</span>
                  )}
                  {!worker.active && <span className="pill pill-error">Deactivated</span>}
                  {worker.mustChangePassword && (
                    <span className="pill pill-warning">Temp password</span>
                  )}
                </div>
                <div className="row-meta">
                  <span className="mono">{worker.email}</span>
                  <span>
                    {worker.jobSiteIds?.length
                      ? `${worker.jobSiteIds.length} assigned site${worker.jobSiteIds.length === 1 ? '' : 's'}`
                      : 'All sites'}
                  </span>
                  {worker.equipmentIds?.length ? (
                    <span>
                      {machines
                        .filter((m) => worker.equipmentIds?.includes(m.id))
                        .map((m) => equipmentLabel(m))
                        .join(', ') || `${worker.equipmentIds.length} machines`}
                    </span>
                  ) : null}
                </div>
                <div className="row-actions">
                  <button type="button" className="small" onClick={() => setEditing(worker)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="small"
                    onClick={() =>
                      void run(async () => {
                        if (
                          !window.confirm(
                            `Email a password reset link to ${worker.email}?`,
                          )
                        )
                          return;
                        await sendWorkerPasswordReset(worker.email);
                        window.alert(
                          `A password reset link has been emailed to ${worker.email}.`,
                        );
                      })
                    }
                  >
                    Send reset link
                  </button>
                  {/* Only the owner hands ownership on, and only to a
                      supervisor: a worker made owner could not use any of it. */}
                  {isOwner && worker.uid !== ownerUid && worker.role === 'admin' && worker.active && (
                    <button
                      type="button"
                      className="small"
                      onClick={() =>
                        void run(async () => {
                          if (
                            !window.confirm(
                              `Make ${worker.displayName} the owner?\n\nYou will stay a supervisor, ` +
                                `but they take over as owner and you cannot undo this yourself — ` +
                                `only they can hand it back.`,
                            )
                          )
                            return;
                          await transferOwnership(worker.uid, worker.displayName);
                        })
                      }
                    >
                      Make owner
                    </button>
                  )}
                  {/* The owner cannot be switched off, by anyone, themselves
                      included — a company with no reachable owner is not a
                      state worth being able to reach. */}
                  {worker.uid !== profile?.uid && worker.uid !== ownerUid && (
                    <button
                      type="button"
                      className={`small ${worker.active ? 'danger' : ''}`}
                      onClick={() =>
                        void run(async () => {
                          if (
                            worker.active &&
                            !window.confirm(
                              `Deactivate ${worker.displayName}? They will no longer be able to clock in or see anything in the app.`,
                            )
                          )
                            return;
                          await setWorkerActive(worker.uid, !worker.active);
                        })
                      }
                    >
                      {worker.active ? 'Deactivate' : 'Reactivate'}
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

function WorkerForm({
  sites,
  machines,
  existing,
  onClose,
  onSaved,
}: {
  sites: JobSite[];
  machines: Equipment[];
  existing?: UserDoc;
  onClose: () => void;
  onSaved: (credential?: IssuedCredential) => void;
}) {
  const [email, setEmail] = useState(existing?.email ?? '');
  const [displayName, setDisplayName] = useState(existing?.displayName ?? '');
  const [role, setRole] = useState<Role>(existing?.role ?? 'worker');
  const [jobSiteIds, setJobSiteIds] = useState<string[]>(existing?.jobSiteIds ?? []);
  const [wage, setWage] = useState(existing?.hourlyRate == null ? '' : String(existing.hourlyRate));
  const [equipmentIds, setEquipmentIds] = useState<string[]>(existing?.equipmentIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const hourlyRate = wage.trim() === '' ? null : Number(wage);
      if (existing) {
        await updateWorker(existing.uid, {
          displayName,
          role,
          jobSiteIds,
          equipmentIds,
          hourlyRate,
        });
        onSaved();
      } else {
        const generated = makePassword();
        await createWorker({
          email,
          displayName,
          role,
          jobSiteIds,
          equipmentIds,
          password: generated,
          hourlyRate,
        });
        onSaved({ displayName, email: email.trim().toLowerCase(), password: generated });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={existing ? `Edit ${existing.displayName}` : 'Add employee'} onClose={onClose}>
      {error && <Banner kind="error">{error}</Banner>}
      <form onSubmit={onSubmit} style={{ marginTop: error ? '0.9rem' : 0 }}>
        <div className="field">
          <label htmlFor="w-name">Full name</label>
          <input
            id="w-name"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="field">
          <label htmlFor="w-email">Email (their username)</label>
          <input
            id="w-email"
            type="email"
            required
            value={email}
            disabled={Boolean(existing)}
            onChange={(e) => setEmail(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
          />
          {existing && <p className="hint">Email cannot be changed after the account is created.</p>}
        </div>

        <div className="field">
          <label htmlFor="w-role">Role</label>
          <select id="w-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="worker">Worker — can clock in and out</option>
            <option value="admin">Administrator — full access</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="w-wage">Hourly wage ($)</label>
          <input
            id="w-wage"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={wage}
            onChange={(e) => setWage(e.target.value)}
            placeholder="38.50"
          />
          <p className="hint">
            Used for labour totals on the timesheet. Never appears on a customer's ticket.
          </p>
        </div>

        <div className="field">
          <label>Assigned job sites</label>
          <p className="hint" style={{ marginTop: 0 }}>
            Leave all unticked to allow every active site.
          </p>
          {sites.length === 0 ? (
            <p className="hint">No active job sites yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {sites.map((site) => (
                <label
                  key={site.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.6rem',
                    color: 'var(--text)',
                    fontWeight: 500,
                  }}
                >
                  <input
                    type="checkbox"
                    style={{ width: 20, height: 20, minHeight: 20, flex: '0 0 auto' }}
                    checked={jobSiteIds.includes(site.id)}
                    onChange={(e) =>
                      setJobSiteIds((prev) =>
                        e.target.checked ? [...prev, site.id] : prev.filter((id) => id !== site.id),
                      )
                    }
                  />
                  {site.name}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="field">
          <label>Usual equipment</label>
          <p className="hint" style={{ marginTop: 0 }}>
            Their regular machine is picked for them when they clock in, so nobody has to hunt
            through the yard list. They can still change it on the day.
          </p>
          {machines.length === 0 ? (
            <p className="hint">
              No machines in service yet. Add them under <strong>Equipment</strong>.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {machines.map((machine) => (
                <label
                  key={machine.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.6rem',
                    color: 'var(--text)',
                    fontWeight: 500,
                  }}
                >
                  <input
                    type="checkbox"
                    style={{ width: 20, height: 20, minHeight: 20, flex: '0 0 auto' }}
                    checked={equipmentIds.includes(machine.id)}
                    onChange={(e) =>
                      setEquipmentIds((prev) =>
                        e.target.checked
                          ? [...prev, machine.id]
                          : prev.filter((id) => id !== machine.id),
                      )
                    }
                  />
                  {equipmentLabel(machine)}
                  {machine.description ? ` — ${machine.description}` : ''}
                </label>
              ))}
            </div>
          )}
        </div>

        <button type="submit" className="primary block" disabled={busy}>
          {busy ? 'Saving…' : existing ? 'Save changes' : 'Create account'}
        </button>
        {!existing && (
          <p className="hint">
            A one-time password is generated and shown to you once. Nothing is emailed.
          </p>
        )}
      </form>
    </Modal>
  );
}
