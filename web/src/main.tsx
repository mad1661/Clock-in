import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

// Registered outside the app bootstrap so a service-worker failure — an old
// browser, a locked-down enterprise phone — can never stop the clock loading.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');
const root = createRoot(container);

// The Firebase modules throw on import when the environment is not configured.
// Loading them dynamically means that failure renders a readable setup message
// instead of a blank page and a stack trace in the console.
void (async () => {
  try {
    const [{ App }, { AuthProvider }, { BrowserRouter }] = await Promise.all([
      import('./App'),
      import('./auth/AuthProvider'),
      import('react-router-dom'),
    ]);

    root.render(
      <StrictMode>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </StrictMode>,
    );
  } catch (err) {
    root.render(
      <div className="centered">
        <div className="card" style={{ maxWidth: 520 }}>
          <h1>Not configured yet</h1>
          <p>{err instanceof Error ? err.message : 'The app failed to start.'}</p>
          <p className="hint">
            Copy <code>web/.env.example</code> to <code>web/.env</code>, fill in your Firebase web
            config, and rebuild. See <code>SETUP.md</code>.
          </p>
        </div>
      </div>,
    );
  }
})();
