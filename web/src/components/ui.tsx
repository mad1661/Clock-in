import type { ReactNode } from 'react';
import { FLAG_LABELS } from '../lib/policy';

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label && <span className="spinner-label">{label}</span>}
    </div>
  );
}

export function Banner({
  kind,
  title,
  children,
}: {
  kind: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`banner banner-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {title && <strong className="banner-title">{title}</strong>}
      <div>{children}</div>
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** Extra classes — `no-print` keeps a card off the printed page. */
  className?: string;
}) {
  return (
    <section className={className ? `card ${className}` : 'card'}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function FlagList({ flags }: { flags: string[] }) {
  if (!flags?.length) return null;
  return (
    <ul className="flag-list">
      {flags.map((flag) => (
        <li key={flag} className="flag">
          {FLAG_LABELS[flag] ?? flag}
        </li>
      ))}
    </ul>
  );
}

export function StatusPill({ shift }: { shift: { needsReview: boolean; review: { status: string } } }) {
  if (shift.needsReview) return <span className="pill pill-warning">Needs review</span>;
  if (shift.review.status === 'rejected') return <span className="pill pill-error">Rejected</span>;
  return <span className="pill pill-success">Approved</span>;
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal">
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
