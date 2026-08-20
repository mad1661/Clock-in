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
import Home from './pages/admin/Home';
import Activity from './pages/admin/Activity';
import Equipment from './pages/admin/Equipment';
import Problems from './pages/admin/Problems';
import DailyTicket from './pages/admin/DailyTicket';

function Shell({ children }: { children: React.ReactNode }) {
  const { profile, isAdmin, isSupport, signOut } = useAuth();

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
        {isAdmin ? (
          <>
            <NavLink to="/" end>
              Home
            </NavLink>
            <NavLink to="/clock">Clock</NavLink>
          </>
        ) : (
          <NavLink to="/" end>
            Clock
          </NavLink>
        )}
        <NavLink to="/timesheet">My hours</NavLink>
        {isAdmin && <NavLink to="/admin/on-site">On site</NavLink>}
        {isAdmin && <NavLink to="/admin/review">Review</NavLink>}
        {isAdmin && <NavLink to="/admin/ticket">Rental ticket</NavLink>}
        {isAdmin && <NavLink to="/admin/timesheets">Timesheets</NavLink>}
        {isAdmin && <NavLink to="/admin/workers">Workers</NavLink>}
        {isAdmin && <NavLink to="/admin/sites">Job sites</NavLink>}
        {isAdmin && <NavLink to="/admin/equipment">Equipment</NavLink>}
        {isAdmin && <NavLink to="/admin/activity">Activity</NavLink>}
        {/* One person only. A problem report carries a stack trace and names
            whose account hit it — that is for whoever fixes the app, not for
            everybody who runs the yard. */}
        {isSupport && <NavLink to="/admin/problems">Problems</NavLink>}
        <NavLink to="/account">Account</NavLink>
      </nav>

      <main>{children}</main>
    </div>
  );
}

function RequireSupport({ children }: { children: React.ReactNode }) {
  const { isSupport } = useAuth();
  if (!isSupport) {
    return (
      <Banner kind="error" title="Not your section">
        Problem reports go to one person, and it is not this account.
      </Banner>
    );
  }
  return <>{children}</>;
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
  const { user, profile, missingProfile, profileError, loading, isAdmin } = useAuth();
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

  // The profile could not be read. Never fall through to setup here: an
  // employee whose record failed to load would be shown the first-run screen
  // and, on tapping its one button, told the company already exists — which
  // reads as being locked out of their own account.
  if (profileError) {
    return (
      <div className="centered">
        <div className="card" style={{ maxWidth: 460 }}>
          <h1>Could not load your account</h1>
          <p>
            You are signed in as <strong>{user.email}</strong>, but we could not read your employee
            record. This is usually a dropped connection.
          </p>
          <button type="button" className="primary block" onClick={() => window.location.reload()}>
            Try again
          </button>
          <div style={{ marginTop: '0.75rem' }}>
            <SignOutButton />
          </div>
        </div>
      </div>
    );
  }

  // Signed in to Firebase Auth but no employee record. Either this is the very
  // first admin running setup, or someone was created in the console by hand.
  // Rendered directly rather than behind a redirect to /setup. Bouncing the URL
  // here and then bouncing it back once the profile lands produced a chain of
  // redirects that could land on top of whatever the new administrator tapped
  // first, making that tap do nothing. Setup sets the URL to "/" itself when it
  // succeeds, so by the time the profile arrives there is nothing left to move.
  if (missingProfile) {
    return <Setup />;
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
        {/* Supervisors land somewhere useful; workers land on the one button
            they came for. Both can still reach the other. */}
        <Route path="/" element={isAdmin ? <Home /> : <ClockPage />} />
        <Route path="/clock" element={<ClockPage />} />
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
        <Route
          path="/admin/equipment"
          element={
            <RequireAdmin>
              <Equipment />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/ticket"
          element={
            <RequireAdmin>
              <DailyTicket />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/activity"
          element={
            <RequireAdmin>
              <Activity />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/problems"
          element={
            <RequireSupport>
              <Problems />
            </RequireSupport>
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
