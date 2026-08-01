import { useState, type FormEvent } from 'react';
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
} from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { Banner, Card } from '../components/ui';

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
      await api.acknowledgePasswordChange({});
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
