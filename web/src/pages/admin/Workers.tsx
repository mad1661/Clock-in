import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useAuth } from '../../auth/AuthProvider';
import {
  createWorker,
  sendWorkerPasswordReset,
  setWorkerActive,
  updateWorker,
} from '../../lib/actions';
import { errorMessage } from '../../lib/errors';
import { Banner, Card, EmptyState, Modal, Spinner } from '../../components/ui';
import type { JobSite, Role, UserDoc } from '../../lib/types';

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
  const { profile } = useAuth();
  const [workers, setWorkers] = useState<UserDoc[] | null>(null);
  const [sites, setSites] = useState<JobSite[]>([]);
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
                  {worker.role === 'admin' && <span className="pill pill-success">Admin</span>}
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
                  {worker.uid !== profile?.uid && (
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
  existing,
  onClose,
  onSaved,
}: {
  sites: JobSite[];
  existing?: UserDoc;
  onClose: () => void;
  onSaved: (credential?: IssuedCredential) => void;
}) {
  const [email, setEmail] = useState(existing?.email ?? '');
  const [displayName, setDisplayName] = useState(existing?.displayName ?? '');
  const [role, setRole] = useState<Role>(existing?.role ?? 'worker');
  const [jobSiteIds, setJobSiteIds] = useState<string[]>(existing?.jobSiteIds ?? []);
  const [wage, setWage] = useState(existing?.hourlyRate == null ? '' : String(existing.hourlyRate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const hourlyRate = wage.trim() === '' ? null : Number(wage);
      if (existing) {
        await updateWorker(existing.uid, { displayName, role, jobSiteIds, hourlyRate });
        onSaved();
      } else {
        const generated = makePassword();
        await createWorker({
          email,
          displayName,
          role,
          jobSiteIds,
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
