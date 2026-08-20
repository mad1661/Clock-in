import { useEffect, useMemo, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from '../../firebase';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';
import { Banner, Card, EmptyState, Spinner } from '../../components/ui';
import type { Timestamp } from 'firebase/firestore';

/**
 * Who changed what, and when.
 *
 * The app has always written this trail; there was simply no way to read it,
 * which makes it worth about as much as not having one. Every entry is stamped
 * with the server's clock and the signed-in account, and the rules refuse
 * updates and deletes — so an entry cannot be edited or quietly removed after
 * the fact, including by whoever wrote it.
 */
interface AuditEntry {
  id: string;
  action: string;
  actorUid: string;
  actorEmail: string | null;
  targetUserId: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  at: Timestamp;
}

const LABELS: Record<string, string> = {
  'company.claimed': 'Company set up',
  'company.owner_added': 'Owner added',
  'company.owner_removed': 'Owner removed',
  'company.support_changed': 'Problem reports handed over',
  // Written by the older single-owner version. Kept so entries from before
  // ownership could be shared still read as something.
  'company.owner_changed': 'Ownership handed over',
  'worker.create': 'Employee added',
  'worker.update': 'Employee edited',
  'worker.activate': 'Employee reactivated',
  'worker.deactivate': 'Employee deactivated',
  'worker.password_reset': 'Password reset sent',
  'jobsite.upsert': 'Job site added or edited',
  'jobsite.delete': 'Job site retired',
  'equipment.upsert': 'Machine added or edited',
  'equipment.retire': 'Machine retired',
  'shift.review': 'Shift approved or rejected',
  'shift.manual_edit': 'Hours changed by a supervisor',
  'shift.edit_requested': 'Correction requested by the worker',
  'shift.edit_withdrawn': 'Correction withdrawn',
  'shift.edit_reviewed': 'Correction ruled on',
  'shift.auto_close': 'Stuck shift closed',
  'ticket.save': 'Rental ticket saved',
  'ticket.sign': 'Rental ticket signed',
  'ticket.unsign': 'Ticket signature removed',
  'ticket.counter_set': 'Ticket numbering changed',
  'signature.saved': 'Signature stored',
  'signature.deleted': 'Signature deleted',
};

/** The changes worth flagging in a list you scan rather than read. */
const NOTABLE = new Set([
  'company.owner_added',
  'company.owner_removed',
  'company.support_changed',
  'company.owner_changed',
  'shift.auto_close',
  'shift.manual_edit',
  'shift.edit_reviewed',
  'worker.deactivate',
  'ticket.unsign',
  'ticket.counter_set',
]);

const time = (iso: unknown) =>
  typeof iso === 'string' ? new Date(iso).toLocaleString() : '—';

/** Renders a before/after pair when the entry carries one. */
function Change({ details }: { details: Record<string, unknown> }) {
  const from = details.from as Record<string, unknown> | undefined;
  const to = details.to as Record<string, unknown> | undefined;
  if (!from && !to) return null;
  return (
    <div className="audit-change">
      <div>
        <span className="k">Was</span> {time(from?.clockInAt)} → {time(from?.clockOutAt)}
      </div>
      <div>
        <span className="k">Now</span>{' '}
        {to ? `${time(to.clockInAt)} → ${time(to.clockOutAt)}` : 'unchanged (turned down)'}
      </div>
    </div>
  );
}

export default function Activity() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [onlyNotable, setOnlyNotable] = useState(false);

  useEffect(() => {
    return onSnapshot(
      query(collection(db, 'auditLogs'), orderBy('at', 'desc'), limit(300)),
      (snap) =>
        setEntries(snap.docs.map((d) => ({ ...(d.data() as AuditEntry), id: d.id }))),
      (err) => {
        setEntries([]);
        setError(errorMessage(err));
      },
    );
  }, []);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (entries ?? []).filter((e) => {
      if (onlyNotable && !NOTABLE.has(e.action)) return false;
      if (!term) return true;
      const hay = [
        LABELS[e.action] ?? e.action,
        e.actorEmail ?? '',
        JSON.stringify(e.details ?? {}),
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(term);
    });
  }, [entries, search, onlyNotable]);

  function exportCsv() {
    const rows = [
      ['When', 'Who', 'What', 'Details'],
      ...visible.map((e) => [
        e.at ? e.at.toDate().toISOString() : '',
        e.actorEmail ?? e.actorUid,
        LABELS[e.action] ?? e.action,
        JSON.stringify(e.details ?? {}),
      ]),
    ];
    const csv = rows
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `activity-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!entries) return <Spinner label="Loading activity…" />;

  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}

      <Card
        title={`Activity (${visible.length})`}
        actions={
          <>
            <button
              type="button"
              className="small ghost"
              onClick={() => setOnlyNotable((v) => !v)}
            >
              {onlyNotable ? 'Show everything' : 'Only changes to hours'}
            </button>
            <button type="button" className="small" onClick={exportCsv}>
              Export CSV
            </button>
          </>
        }
      >
        <p className="hint" style={{ marginTop: 0 }}>
          Every change anyone makes, newest first. Entries cannot be edited or deleted by anybody,
          including whoever made them, and each is stamped with the server's clock.
        </p>

        <div className="field">
          <label htmlFor="a-search">Search</label>
          <input
            id="a-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="A name, an email, a machine…"
            autoComplete="off"
          />
        </div>

        {visible.length === 0 ? (
          <EmptyState>Nothing recorded yet.</EmptyState>
        ) : (
          <ul className="list">
            {visible.map((entry) => (
              <li key={entry.id} className="row">
                <div className="row-head">
                  <span className="title">{LABELS[entry.action] ?? entry.action}</span>
                  {NOTABLE.has(entry.action) && <span className="pill pill-warning">Hours</span>}
                </div>
                <div className="row-meta">
                  <span>{entry.at ? fmtDateTime(entry.at) : '—'}</span>
                  <span className="mono">{entry.actorEmail ?? entry.actorUid}</span>
                  {typeof entry.details?.worker === 'string' && (
                    <span>for {entry.details.worker}</span>
                  )}
                </div>
                <Change details={entry.details ?? {}} />
                {typeof entry.details?.note === 'string' && entry.details.note && (
                  <div className="row-meta">
                    <span>Note: {entry.details.note}</span>
                  </div>
                )}
                {typeof entry.details?.reason === 'string' && entry.details.reason && (
                  <div className="row-meta">
                    <span>Reason: {entry.details.reason}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {entries.length >= 300 && (
          <p className="hint">
            Showing the most recent 300. Export the CSV for the full record.
          </p>
        )}
      </Card>
    </>
  );
}
