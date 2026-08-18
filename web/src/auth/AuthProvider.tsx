import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { onAuthStateChanged, signOut as fbSignOut, type User } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db } from '../firebase';
import type { UserDoc } from '../lib/types';

interface AuthState {
  /** null once resolved and signed out; undefined while still resolving. */
  user: User | null;
  profile: UserDoc | null;
  /** True when the signed-in account genuinely has no employee profile yet. */
  missingProfile: boolean;
  /** Set when the profile could not be read at all — a fault, not an absence. */
  profileError: Error | null;
  loading: boolean;
  isAdmin: boolean;
  /** The uids recorded on the company as its owners, once known. */
  ownerUids: string[];
  /** True for anyone who can decide who else owns the company. */
  isOwner: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserDoc | null>(null);
  const [profileError, setProfileError] = useState<Error | null>(null);
  const [ownerUids, setOwnerUids] = useState<string[]>([]);
  const [authResolved, setAuthResolved] = useState(false);
  const [profileResolved, setProfileResolved] = useState(false);

  useEffect(() => {
    return onAuthStateChanged(auth, (next) => {
      setUser(next);
      setAuthResolved(true);
      if (!next) {
        setProfile(null);
        setProfileError(null);
        setProfileResolved(true);
      } else {
        setProfileResolved(false);
      }
    });
  }, []);

  useEffect(() => {
    if (!user) return;

    // A live subscription rather than a one-off read: when an admin deactivates
    // someone or changes their role, the open tab reacts within a second instead
    // of staying usable until the next reload.
    setProfileError(null);
    let confirmed = false;
    let cancelled = false;
    const unsubscribe = onSnapshot(
      doc(db, 'users', user.uid),
      // Metadata changes are required, not incidental: the snapshot that
      // confirms a write reached the server carries no data change, so without
      // this the confirmation below would never arrive.
      { includeMetadataChanges: true },
      (snap) => {
        // A profile that exists only as an unacknowledged local write is not
        // real yet. Acting on one lets the app show somebody the full admin
        // interface off the back of a write that is still in flight — close the
        // tab or lose signal and it is discarded, dropping them back on the
        // first-run setup screen as though they had never set anything up.
        // Once a confirmed profile has been seen, later local edits are fine to
        // reflect immediately.
        if (!confirmed && snap.metadata.hasPendingWrites) return;

        // A profile that has already been seen can never legitimately vanish:
        // firestore.rules forbids deleting a user document, and switching
        // somebody off is an update to `active`, not a delete. So a snapshot
        // claiming the record is gone is a glitch — a listener catching up
        // after a reconnect — and acting on it would drop a signed-in employee
        // onto the first-run setup screen for no reason. Keep what we have.
        if (confirmed && !snap.exists()) return;

        if (cancelled) return;
        confirmed = true;
        setProfile(snap.exists() ? ({ ...(snap.data() as UserDoc), uid: snap.id }) : null);
        setProfileError(null);
        setProfileResolved(true);
      },
      (err) => {
        // Emphatically NOT the same as "this account has no employee record".
        // Treating a failed read as a missing profile sends a real employee to
        // the first-run setup screen, where the only button fails because the
        // company is already claimed — which looks exactly like being locked
        // out of your own account.
        console.error('Could not read the signed-in profile', err);
        setProfileError(err);
        setProfileResolved(true);
      },
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [user]);

  // Who owns the company. Live, so making somebody an owner — or taking it
  // back off them — takes effect in their open tab rather than at their next
  // reload. A company claimed before ownership could be shared still carries a
  // single `ownerUid`; read either shape, exactly as firestore.rules does.
  useEffect(() => {
    if (!user) {
      setOwnerUids([]);
      return;
    }
    // A Firestore listener is torn down for good when it errors, so without
    // this an owner who hits one dropped connection silently stops being an
    // owner — the buttons vanish and stay vanished until they reload, with
    // nothing on screen to say why. Resubscribe instead.
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let retry: number | undefined;

    const listen = () => {
      if (cancelled) return;
      unsubscribe = onSnapshot(
        doc(db, 'config', 'company'),
        (snap) => {
          const data = snap.data();
          const list = Array.isArray(data?.ownerUids)
            ? (data.ownerUids as string[])
            : data?.ownerUid
              ? [data.ownerUid as string]
              : [];
          setOwnerUids(list);
        },
        (err) => {
          console.error('Could not read the company record', err);
          retry = window.setTimeout(listen, 2000);
        },
      );
    };
    listen();

    return () => {
      cancelled = true;
      window.clearTimeout(retry);
      unsubscribe?.();
    };
  }, [user]);

  // No custom claims to reconcile: with no Cloud Functions the role lives in
  // the user document, which the rules read directly and this provider already
  // subscribes to above.

  const value = useMemo<AuthState>(
    () => ({
      user,
      profile,
      missingProfile: Boolean(user) && profileResolved && profile === null && !profileError,
      profileError,
      loading: !authResolved || (Boolean(user) && !profileResolved),
      isAdmin: profile?.role === 'admin' && profile.active,
      ownerUids,
      isOwner: Boolean(user && profile?.active && ownerUids.includes(user.uid)),
      signOut: async () => {
        await fbSignOut(auth);
      },
    }),
    [user, profile, profileError, authResolved, profileResolved, ownerUids],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
