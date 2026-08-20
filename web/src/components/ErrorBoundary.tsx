import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from '../lib/report';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * The last line of defence.
 *
 * A render that throws takes React's whole tree down with it, and what the
 * person holding the phone sees is a white screen — no message, no button, no
 * way to tell anybody what happened. That has happened in this app before, and
 * without something here it is also the one failure that reports nothing, since
 * the code that would have reported it is the code that just died.
 *
 * So: a readable card, a way out, and the fault on its way to the Problems tab.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error, {
      kind: 'render-crash',
      // Which components were on screen. Far more useful than the raw stack
      // once a build has been minified.
      componentStack: info.componentStack?.split('\n').slice(0, 12).join('\n').slice(0, 1500) ?? null,
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="centered">
        <div className="card" style={{ maxWidth: 460 }}>
          <h1>Something went wrong</h1>
          <p>
            This screen ran into a fault and could not finish loading. It has been reported
            automatically — you do not need to do anything.
          </p>
          <button
            type="button"
            className="primary block"
            onClick={() => window.location.assign('/')}
          >
            Back to the clock
          </button>
          <button
            type="button"
            className="block"
            style={{ marginTop: '0.6rem' }}
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
          <p className="hint" style={{ marginTop: '0.9rem' }}>
            {this.state.error.message}
          </p>
        </div>
      </div>
    );
  }
}
