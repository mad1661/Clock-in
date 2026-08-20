import { useEffect, useMemo, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from '../../firebase';
import { errorMessage } from '../../lib/errors';
import { withTimestamps } from '../../lib/snapshot';
import { Banner, Card, EmptyState, Spinner } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';
import { shortDeviceId } from '../../lib/device';
import { handOverProblems, resolveProblem } from '../../lib/actions';
import { useAuth } from '../../auth/AuthProvider';
import type { UserDoc } from '../../lib/types';
import type { Timestamp } from 'firebase/firestore';

interface ProblemReport {
  id: string;
  fingerprint: string;
  message: string;
  code: string | null;
  stack: string | null;
  where: string;
  context: Record<string, unknown>;
  actorUid: string;
  actorEmail: string | null;
  build: string;
  device: {
    id: string | null;
    userAgent: string;
    platform: string;
    screen: string;
    language: string;
    timezone: string;
  } | null;
  online: boolean;
  resolved: boolean;
  at: Timestamp;
}

/** One fault, however many times it has happened. */
interface Group {
  fingerprint: string;
  reports: ProblemReport[];
  latest: ProblemReport;
  people: string[];
  resolved: boolean;
}

/** Plain English for the handful of faults that have a known cause. */
function explain(report: ProblemReport): string | null {
  if (report.code === 'permission-denied') {
    return 'The database refused this. Either they tried something their role does not allow — in which case the app should not have offered it — or a rule is stricter than the screen.';
  }
  if (report.code === 'failed-precondition' && /index/i.test(report.message)) {
    return 'A report needs a database index that is still building. This clears itself within a few minutes of a deploy.';
  }
  if (report.context?.kind === 'render-crash') {
    return 'A screen failed to draw. Whoever hit this saw an error card instead of the page.';
  }
  if (report.context?.kind === 'resource') {
    return 'A file the app needed did not load. Usually a phone holding an old cached copy after a deploy — a reload normally fixes it.';
  }
  if (report.code === 'unauthenticated') {
    return 'Their sign-in had expired by the time the write went out.';
  }
  return null;
}

const shortDevice = (report: ProblemReport) =>
  report.device?.userAgent?.match(/iPhone|iPad|Android|Windows|Macintosh|Linux/)?.[0] ?? 'Unknown';

/**
 * What has gone wrong for anybody using the app.
 *
 * Owner-only, and grouped by fault rather than listed by occurrence: sixty
 * copies of the same broken screen is one problem to fix, and a list that shows
 * it sixty times hides the other two.
 */
export default function Problems() {
  const { profile } = useAuth();
  const [reports, setReports] = useState<ProblemReport[] | null>(null);
  const [admins, setAdmins] = useState<UserDoc[]>([]);
  const [handingOver, setHandingOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    return onSnapshot(
      query(collection(db, 'errorLogs'), orderBy('at', 'desc'), limit(400)),
      (snap) => {
        setReports(snap.docs.map((d) => withTimestamps<ProblemReport>(d)));
        setError(null);
      },
      (err) => {
        setReports([]);
        setError(errorMessage(err));
      },
    );
  }, []);

  // Only to offer the hand-over list. Read lazily so the page does not pull the
  // roster for somebody who never opens that control.
  useEffect(() => {
    if (!handingOver) return;
    return onSnapshot(
      query(collection(db, 'users'), orderBy('displayName')),
      (snap) => setAdmins(snap.docs.map((d) => ({ ...(d.data() as UserDoc), uid: d.id }))),
      () => setAdmins([]),
    );
  }, [handingOver]);

  const groups = useMemo<Group[]>(() => {
    const byFault = new Map<string, ProblemReport[]>();
    for (const report of reports ?? []) {
      const list = byFault.get(report.fingerprint) ?? [];
      list.push(report);
      byFault.set(report.fingerprint, list);
    }
    return [...byFault.values()]
      .map((list) => ({
        fingerprint: list[0].fingerprint,
        reports: list,
        latest: list[0],
        people: [...new Set(list.map((r) => r.actorEmail ?? r.actorUid))],
        // A fault counts as dealt with only while nothing new has come in — a
        // report after it was ticked off means it is back.
        resolved: list.every((r) => r.resolved),
      }))
      .sort((a, b) => b.latest.at.toMillis() - a.latest.at.toMillis());
  }, [reports]);

  const visible = groups.filter((g) => showResolved || !g.resolved);
  const openProblems = groups.filter((g) => !g.resolved).length;

  async function tickOff(group: Group) {
    setBusy(group.fingerprint);
    setError(null);
    try {
      await Promise.all(
        group.reports.filter((r) => !r.resolved).map((r) => resolveProblem(r.id)),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function exportCsv() {
    const rows = [
      ['When', 'Problem', 'Code', 'Screen', 'Who', 'Build', 'Device', 'Times', 'Fixed'],
      ...groups.map((g) => [
        fmtDateTime(g.latest.at),
        g.latest.message,
        g.latest.code ?? '',
        g.latest.where,
        g.people.join(' '),
        g.latest.build,
        shortDevice(g.latest),
        String(g.reports.length),
        g.resolved ? 'yes' : 'no',
      ]),
    ];
    const csv = rows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'problems.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!reports) return <Spinner label="Loading problems…" />;

  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}

      <Card
        title={openProblems === 0 ? 'Problems' : `Problems (${openProblems})`}
        actions={
          <>
            <button type="button" className="small" onClick={() => setShowResolved((v) => !v)}>
              {showResolved ? 'Hide fixed' : 'Show fixed'}
            </button>
            <button type="button" className="small" onClick={exportCsv} disabled={!groups.length}>
              Export CSV
            </button>
          </>
        }
      >
        <p className="hint" style={{ marginTop: 0 }}>
          Faults the app hit while somebody was using it, reported automatically and grouped by
          cause, and visible to you alone — not to supervisors, and not to other owners. Nothing
          here carries hours, locations or customer detail: who it happened to, what broke, and
          which screen.
        </p>
        {handingOver ? (
          <div className="field">
            <label htmlFor="p-handover">Send problem reports to</label>
            <select
              id="p-handover"
              defaultValue=""
              onChange={(e) => {
                const next = admins.find((a) => a.uid === e.target.value);
                if (!next) return;
                if (
                  !window.confirm(
                    `Send problem reports to ${next.displayName}?\n\nThey will see this tab ` +
                      `instead of you, and only they will be able to hand it back.`,
                  )
                ) {
                  e.target.value = '';
                  return;
                }
                void (async () => {
                  try {
                    await handOverProblems(next.uid, next.displayName);
                    setHandingOver(false);
                  } catch (err) {
                    setError(errorMessage(err));
                  }
                })();
              }}
            >
              <option value="">Choose a supervisor…</option>
              {admins
                .filter((a) => a.role === 'admin' && a.active && a.uid !== profile?.uid)
                .map((a) => (
                  <option key={a.uid} value={a.uid}>
                    {a.displayName} — {a.email}
                  </option>
                ))}
            </select>
            <p className="hint">
              Only an active supervisor can take this on, and only the person holding it can pass
              it on — there is no way to help yourself to it.
            </p>
          </div>
        ) : (
          <button type="button" className="small ghost" onClick={() => setHandingOver(true)}>
            Hand this over to somebody else
          </button>
        )}
        {visible.length === 0 && (
          <EmptyState>
            {groups.length === 0
              ? 'Nothing has gone wrong. This is the screen you want to be empty.'
              : 'Nothing outstanding — everything reported has been ticked off.'}
          </EmptyState>
        )}
      </Card>

      {visible.map((group) => {
        const report = group.latest;
        const note = explain(report);
        const expanded = open === group.fingerprint;
        return (
          <Card key={group.fingerprint}>
            <div className="row-head">
              <span className="title">{report.message}</span>
              {group.resolved ? (
                <span className="pill pill-success">Fixed</span>
              ) : (
                <span className="pill pill-error">
                  {group.reports.length}&times;
                </span>
              )}
            </div>

            <div className="row-meta">
              <span>Last {fmtDateTime(report.at)}</span>
              <span>on {report.where}</span>
              <span>
                {group.people.length === 1
                  ? group.people[0]
                  : `${group.people.length} people`}
              </span>
              <span>{shortDevice(report)}</span>
              {report.code && <span className="mono">{report.code}</span>}
            </div>

            {note && <p className="hint">{note}</p>}

            <div className="row-actions">
              <button
                type="button"
                className="small"
                onClick={() => setOpen(expanded ? null : group.fingerprint)}
              >
                {expanded ? 'Hide detail' : 'Detail'}
              </button>
              {!group.resolved && (
                <button
                  type="button"
                  className="small"
                  disabled={busy === group.fingerprint}
                  onClick={() => void tickOff(group)}
                >
                  {busy === group.fingerprint ? 'Saving…' : 'Mark fixed'}
                </button>
              )}
            </div>

            {expanded && (
              <div className="row-meta" style={{ display: 'block' }}>
                <p className="hint" style={{ marginBottom: '0.3rem' }}>
                  Build {report.build} · {report.device?.screen} · {report.device?.timezone} ·{' '}
                  {shortDeviceId(report.device?.id) ?? 'unknown handset'} ·{' '}
                  {report.online ? 'online' : 'offline'}
                </p>
                {group.reports.length > 1 && (
                  <p className="hint" style={{ marginBottom: '0.3rem' }}>
                    First seen {fmtDateTime(group.reports[group.reports.length - 1].at)}
                  </p>
                )}
                {report.stack && (
                  <pre
                    className="mono"
                    style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem', overflowX: 'auto' }}
                  >
                    {report.stack}
                  </pre>
                )}
                {typeof report.context?.componentStack === 'string' && (
                  <pre
                    className="mono"
                    style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem', overflowX: 'auto' }}
                  >
                    {report.context.componentStack}
                  </pre>
                )}
              </div>
            )}
          </Card>
        );
      })}
    </>
  );
}
