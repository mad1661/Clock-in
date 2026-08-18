import { useState, type FormEvent } from 'react';
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
} from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { useAuth } from '../auth/AuthProvider';
import { acknowledgePasswordChange, saveMySignature } from '../lib/actions';
import { errorMessage } from '../lib/errors';
import { Banner, Card } from '../components/ui';
import { SignatureMark, SignaturePad, type SignatureStrokes } from '../components/SignaturePad';

const MIN_PASSWORD_LENGTH = 10;

export default function Account() {
  const { user, profile } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);

    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setError('The two new passwords do not match.');
      return;
    }
    if (next === current) {
      setError('Your new password must be different from the current one.');
      return;
    }
    if (!user?.email) return;

    setBusy(true);
    try {
      // Firebase requires a recent sign-in before a password change; doing the
      // reauth inline means the worker is never bounced back to the login page
      // half-way through.
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, current));
      await updatePassword(user, next);
      await acknowledgePasswordChange();
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      if (err instanceof FirebaseError) {
        if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password') {
          setError('Your current password is not right.');
        } else if (err.code === 'auth/weak-password') {
          setError('That password is too weak. Try a longer one.');
        } else if (err.code === 'auth/too-many-requests') {
          setError('Too many attempts. Wait a few minutes and try again.');
        } else {
          setError('Could not change your password. Please try again.');
        }
      } else {
        setError('Could not change your password. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card title="Account">
        <div className="row-meta">
          <span>{profile?.displayName}</span>
          <span>{profile?.email}</span>
          <span>{profile?.role === 'admin' ? 'Administrator' : 'Worker'}</span>
        </div>
      </Card>

      {profile?.role === 'admin' && <MySignature />}

      <Card title="Change password">
        {profile?.mustChangePassword && (
          <Banner kind="warning">
            You are still using the temporary password you were given. Set your own now.
          </Banner>
        )}
        {done && <Banner kind="success">Password changed.</Banner>}
        {error && <Banner kind="error">{error}</Banner>}

        <form onSubmit={onSubmit} style={{ marginTop: '0.9rem' }}>
          <div className="field">
            <label htmlFor="current">Current password</label>
            <input
              id="current"
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="next">New password</label>
            <input
              id="next"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
            <p className="hint">At least {MIN_PASSWORD_LENGTH} characters.</p>
          </div>
          <div className="field">
            <label htmlFor="confirm">Repeat new password</label>
            <input
              id="confirm"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          <button type="submit" className="primary block" disabled={busy}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </form>
      </Card>
    </>
  );
}


/**
 * The supervisor's own signature, stored once and reused.
 *
 * Redrawing the same mark on a phone for every ticket is how a signature
 * feature stops getting used, so it is kept on their employee record and
 * applied with one tap when they sign.
 */
function MySignature() {
  const { profile } = useAuth();
  const [drawing, setDrawing] = useState(false);
  const [drawn, setDrawn] = useState<SignatureStrokes | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await fn();
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="My signature">
      {error && <Banner kind="error">{error}</Banner>}
      {saved && <Banner kind="success">Saved.</Banner>}

      <p className="hint" style={{ marginTop: 0 }}>
        Sign once here and every rental ticket you sign off uses it — no redrawing
        on site.
      </p>

      {profile?.signature && !drawing && (
        <div className="saved-signature">
          <SignatureMark signature={profile.signature} />
        </div>
      )}

      {drawing ? (
        <>
          <SignaturePad onChange={setDrawn} />
          <div className="row-actions" style={{ marginTop: '0.75rem' }}>
            <button
              type="button"
              className="small primary"
              disabled={busy || !drawn}
              onClick={() =>
                void run(async () => {
                  await saveMySignature(drawn);
                  setDrawing(false);
                  setDrawn(null);
                })
              }
            >
              {busy ? 'Saving…' : 'Save signature'}
            </button>
            <button type="button" className="small" onClick={() => setDrawing(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="row-actions">
          <button type="button" className="small primary" onClick={() => setDrawing(true)}>
            {profile?.signature ? 'Replace signature' : 'Add my signature'}
          </button>
          {profile?.signature && (
            <button
              type="button"
              className="small danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (!window.confirm('Delete your saved signature?')) return;
                  await saveMySignature(null);
                })
              }
            >
              Delete
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
