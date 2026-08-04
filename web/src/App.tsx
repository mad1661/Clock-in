import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import { Spinner, Banner } from './components/ui';
import Login from './pages/Login';
import Setup from './pages/Setup';
import ClockPage from './pages/ClockPage';
import MyTimesheet from './pages/MyTimesheet';
import Account from './pages/Account';
import Workers from './pages/admin/Workers';
import JobSites from './pages/admin/JobSites';
import Timesheets from './pages/admin/Timesheets';
import ReviewQueue from './pages/admin/ReviewQueue';
import OnSiteNow from './pages/admin/OnSiteNow';

function Shell({ children }: { children: React.ReactNode }) {
  const { profile, isAdmin, signOut } = useAuth();

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <img src="/coburn-logo.png" alt="Coburn Equipment Rentals" />
          <span className="brand-text">
            <span className="brand-name">Coburn Equipment Rentals</span>
            <span className="brand-sub">Time clock</span>
          </span>
        </span>
        <span className="who">{profile?.displayName ?? profile?.email}</span>
        <button type="button" className="small ghost" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>

      <nav className="nav" aria-label="Sections">
        <NavLink to="/" end>
          Clock
        </NavLink>
        <NavLink to="/timesheet">My hours</NavLink>
        {isAdmin && <NavLink to="/admin/on-site">On site</NavLink>}
        {isAdmin && <NavLink to="/admin/review">Review</NavLink>}
        {isAdmin && <NavLink to="/admin/timesheets">Timesheets</NavLink>}
        {isAdmin && <NavLink to="/admin/workers">Workers</NavLink>}
        {isAdmin && <NavLink to="/admin/sites">Job sites</NavLink>}
        <NavLink to="/account">Account</NavLink>
      </nav>

      <main>{children}</main>
    </div>
  );
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) {
    return (
      <Banner kind="error" title="Administrators only">
        You do not have access to this section.
      </Banner>
    );
  }
  return <>{children}</>;
}

export function App() {
  const { user, profile, missingProfile, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="centered">
        <Spinner label="Loading…" />
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location }} />} />
      </Routes>
    );
  }

  // Signed in to Firebase Auth but no employee record. Either this is the very
  // first admin running setup, or someone was created in the console by hand.
  if (missingProfile) {
    return (
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  if (profile && !profile.active) {
    return (
      <div className="centered">
        <div className="card" style={{ maxWidth: 460 }}>
          <h1>Account deactivated</h1>
          <p>This account can no longer clock in or out. Please contact your administrator.</p>
          <SignOutButton />
        </div>
      </div>
    );
  }

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<ClockPage />} />
        <Route path="/timesheet" element={<MyTimesheet />} />
        <Route path="/account" element={<Account />} />
        <Route
          path="/admin/workers"
          element={
            <RequireAdmin>
              <Workers />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/sites"
          element={
            <RequireAdmin>
              <JobSites />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/timesheets"
          element={
            <RequireAdmin>
              <Timesheets />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/on-site"
          element={
            <RequireAdmin>
              <OnSiteNow />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/review"
          element={
            <RequireAdmin>
              <ReviewQueue />
            </RequireAdmin>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

function SignOutButton() {
  const { signOut } = useAuth();
  return (
    <button type="button" className="block" onClick={() => void signOut()}>
      Sign out
    </button>
  );
}
