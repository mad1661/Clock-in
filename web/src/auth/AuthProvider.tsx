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
  /** True when the signed-in account has no employee profile yet. */
  missingProfile: boolean;
  loading: boolean;
  isAdmin: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserDoc | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const [profileResolved, setProfileResolved] = useState(false);

  useEffect(() => {
    return onAuthStateChanged(auth, (next) => {
      setUser(next);
      setAuthResolved(true);
      if (!next) {
        setProfile(null);
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
    return onSnapshot(
      doc(db, 'users', user.uid),
      (snap) => {
        setProfile(snap.exists() ? ({ ...(snap.data() as UserDoc), uid: snap.id }) : null);
        setProfileResolved(true);
      },
      () => {
        setProfile(null);
        setProfileResolved(true);
      },
    );
  }, [user]);

  // Custom claims drive the security rules but are baked into the ID token, so a
  // freshly created worker or a just-promoted admin carries stale claims until
  // the token refreshes. Force a refresh when the profile and token disagree.
  useEffect(() => {
    if (!user || !profile) return;
    let cancelled = false;
    void (async () => {
      const token = await user.getIdTokenResult();
      if (cancelled) return;
      if (token.claims.role !== profile.role || token.claims.active !== profile.active) {
        await user.getIdToken(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, profile]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      profile,
      missingProfile: Boolean(user) && profileResolved && profile === null,
      loading: !authResolved || (Boolean(user) && !profileResolved),
      isAdmin: profile?.role === 'admin' && profile.active,
      signOut: async () => {
        await fbSignOut(auth);
      },
    }),
    [user, profile, authResolved, profileResolved],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
