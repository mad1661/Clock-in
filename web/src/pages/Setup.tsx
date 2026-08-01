import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { api, errorMessage } from '../lib/api';
import { Banner } from '../components/ui';

/**
 * First-run screen.
 *
 * Reached when someone is signed in to Firebase Auth but has no employee
 * record. That is either the very first administrator (who created their own
 * account in the Firebase console) or an account added by hand later. The
 * bootstrap callable only promotes the first case — once any admin exists it
 * refuses — so this page cannot be used to escalate.
 */
export default function Setup() {
  const { user, signOut } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      await api.bootstrapAdmin({ displayName: displayName.trim() || undefined });
      // The new custom claim only lands in a refreshed ID token.
      await user?.getIdToken(true);
      setDone(true);
      window.location.assign('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="centered">
      <div className="card" style={{ width: '100%', maxWidth: 460 }}>
        <h1>Set up your company</h1>
        <p className="hint">
          Signed in as <strong>{user?.email}</strong>, but this account is not linked to an employee
          record yet.
        </p>

        {error && (
          <div style={{ marginTop: '1rem' }}>
            <Banner kind="error" title="Could not continue">
              {error}
              <p className="hint" style={{ marginTop: '0.5rem' }}>
                If an administrator already exists, ask them to create an account for you, then sign
                in with those details.
              </p>
            </Banner>
          </div>
        )}

        {done && <Banner kind="success">You are set up. Redirecting…</Banner>}

        <div className="field" style={{ marginTop: '1rem' }}>
          <label htmlFor="name">Your name</label>
          <input
            id="name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Alex Morgan"
            autoComplete="name"
          />
        </div>

        <button type="button" className="primary block" disabled={busy} onClick={() => void claim()}>
          {busy ? 'Setting up…' : 'Make me the administrator'}
        </button>

        <button
          type="button"
          className="ghost block small"
          style={{ marginTop: '0.75rem' }}
          onClick={() => void signOut()}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
