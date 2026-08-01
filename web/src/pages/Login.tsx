import { useState, type FormEvent } from 'react';
import { signInWithEmailAndPassword, sendPasswordResetEmail } from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { auth } from '../firebase';
import { Banner } from '../components/ui';

function friendlyAuthError(err: unknown): string {
  if (err instanceof FirebaseError) {
    switch (err.code) {
      case 'auth/invalid-credential':
      case 'auth/wrong-password':
      case 'auth/user-not-found':
        // Deliberately identical for all three so the form cannot be used to
        // work out which email addresses have accounts.
        return 'That email and password do not match.';
      case 'auth/user-disabled':
        return 'This account has been deactivated. Contact your administrator.';
      case 'auth/too-many-requests':
        return 'Too many attempts. Wait a few minutes and try again.';
      case 'auth/network-request-failed':
        return 'No connection. Check your signal and try again.';
      case 'auth/invalid-email':
        return 'That does not look like a valid email address.';
      default:
        return 'Could not sign you in. Please try again.';
    }
  }
  return 'Could not sign you in. Please try again.';
}

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  async function onForgotPassword() {
    setError(null);
    setNotice(null);
    if (!email.trim()) {
      setError('Enter your email address first, then tap "Forgot password".');
      return;
    }
    try {
      await sendPasswordResetEmail(auth, email.trim().toLowerCase());
    } catch {
      // Swallowed on purpose: reporting "no such user" here would leak the
      // employee roster to anyone who can load the page.
    }
    setNotice(
      'If that email has an account, a reset link is on its way. If nothing arrives, ask your administrator to reset it for you.',
    );
  }

  return (
    <div className="centered">
      <div className="card" style={{ width: '100%', maxWidth: 400 }}>
        <h1>⏱ Clock In</h1>
        <p className="hint" style={{ marginBottom: '1rem' }}>
          Sign in with the details your administrator gave you.
        </p>

        {error && <Banner kind="error">{error}</Banner>}
        {notice && <Banner kind="info">{notice}</Banner>}

        <form onSubmit={onSubmit} style={{ marginTop: '1rem' }}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <button type="submit" className="primary block" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <button
          type="button"
          className="ghost block small"
          style={{ marginTop: '0.75rem' }}
          onClick={() => void onForgotPassword()}
        >
          Forgot password
        </button>
      </div>
    </div>
  );
}
