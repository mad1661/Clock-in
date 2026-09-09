import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useAuth } from '../../auth/AuthProvider';
import { clearDailyTicketSignature, saveDailyTicket, signDailyTicket } from '../../lib/actions';
import { errorMessage } from '../../lib/errors';
import { withTimestamps } from '../../lib/snapshot';
import { dayBounds, dayKey, draftTicket, mergeTicket, ticketId } from '../../lib/ticket';
import { isTimecardSite } from '../../lib/timecard';
import { openPrintDialog } from '../../lib/print';
import { Banner, Card, Modal, Spinner } from '../../components/ui';
import { SignatureMark, SignaturePad, type SignatureStrokes } from '../../components/SignaturePad';
import type {
  DailyTicket as DailyTicketDoc,
  DailyTicket as Ticket,
  Equipment,
  JobSite,
  Shift,
  UserDoc,
} from '../../lib/types';

const time = (t: { toDate: () => Date } | null) =>
  t
    ? t
        .toDate()
        .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        .replace(/\s/g, '')
    : '';

const hours = (n: number | null) => (n == null ? '' : String(n));

const money = (n: number) =>
  n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });

/**
 * What the day comes to at the current rental rates.
 *
 * Deliberately NOT part of the printed ticket. The paper form the customer has
 * always received is a record of hours, with pricing handled on the invoice, and
 * quietly starting to print dollar figures on it would change what the customer
 * is being handed. It is here so the office can see the number.
 */
function RentalTotals({
  ticket,
  rates,
  wages,
}: {
  ticket: Omit<DailyTicketDoc, 'createdAt' | 'updatedAt'>;
  rates: Map<string, number | null>;
  wages: Map<string, number | null>;
}) {
  const lines = ticket.rows.map((row) => {
    const rate = row.equipmentId ? (rates.get(row.equipmentId) ?? null) : null;
    // Billed on machine hours, not operator hours: the four-hour show-up
    // minimum is something the yard pays its operator, not something the
    // customer is charged for a machine that sat still.
    const billable = row.tractorHours ?? 0;
    // Paid on operator hours, which is the other side of exactly that: the
    // four-hour minimum is in this number even when the machine never moved.
    const wage = wages.get(row.userId) ?? null;
    return {
      label: row.equipmentType
        ? `${row.equipmentType}${row.machineNo ? `-${row.machineNo}` : ''}`
        : row.operatorName,
      operator: row.operatorName,
      hours: billable,
      rate,
      amount: rate == null ? null : rate * billable,
      operatorHours: row.operatorHours,
      wage,
      labour: wage == null ? null : wage * row.operatorHours,
    };
  });

  const priced = lines.filter((l) => l.amount != null);
  const total = priced.reduce((sum, l) => sum + (l.amount ?? 0), 0);
  const unpriced = lines.length - priced.length;
  const paid = lines.filter((l) => l.labour != null);
  const labour = paid.reduce((sum, l) => sum + (l.labour ?? 0), 0);
  const unwaged = lines.length - paid.length;

  return (
    <Card title="Rental total (office copy)" className="no-print">
      {lines.length === 0 ? (
        <p className="hint" style={{ margin: 0 }}>
          Nothing to price yet.
        </p>
      ) : (
        <>
          <ul className="list">
            {lines.map((line, i) => (
              <li key={i} className="row">
                <div className="row-head">
                  <span className="title">{line.label}</span>
                  <span>{line.amount == null ? '—' : money(line.amount)}</span>
                </div>
                <div className="row-meta">
                  <span>{line.hours} machine hours</span>
                  <span>{line.rate == null ? 'No rate set' : `${money(line.rate)}/hr`}</span>
                </div>
                <div className="row-meta">
                  <span>
                    {line.operator} · {line.operatorHours} operator hours
                  </span>
                  <span>{line.wage == null ? 'No wage set' : `${money(line.wage)}/hr`}</span>
                  <span>{line.labour == null ? '—' : `${money(line.labour)} labour`}</span>
                </div>
              </li>
            ))}
          </ul>
          <div className="totals">
            <span>
              Rental <strong>{money(total)}</strong>
            </span>
            <span>
              Labour <strong>{money(labour)}</strong>
            </span>
            <span>
              Over labour <strong>{money(total - labour)}</strong>
            </span>
          </div>
          {unpriced > 0 && (
            <p className="hint">
              {unpriced} line{unpriced === 1 ? '' : 's'} not priced — set a rental rate under
              Equipment.
            </p>
          )}
          {unwaged > 0 && (
            <p className="hint">
              {unwaged} operator{unwaged === 1 ? '' : 's'} with no wage on file — set it under
              Workers.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * The Daily Rental Ticket & Equipment Report.
 *
 * Assembled from the day's shifts rather than typed out: who was on which
 * machine, and when, is already recorded by the clock. What a supervisor still
 * has to supply is the hour-meter readings and any downtime — the two things
 * the app cannot observe.
 *
 * Laid out to match the paper form it replaces, because it goes to the same
 * customers who have been reading that form for years.
 */
export default function DailyTicket() {
  const { profile } = useAuth();
  // Deep-linkable, so "Open ticket" from the home page lands on the right one.
  const [params, setParams] = useSearchParams();
  const [sites, setSites] = useState<JobSite[] | null>(null);
  const [siteId, setSiteId] = useState(params.get('site') ?? '');
  const [date, setDate] = useState(() => params.get('date') ?? dayKey(new Date()));

  const [ticket, setTicket] = useState<Omit<Ticket, 'createdAt' | 'updatedAt'> | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [rates, setRates] = useState<Map<string, number | null>>(new Map());
  const [wages, setWages] = useState<Map<string, number | null>>(new Map());
  const [signing, setSigning] = useState(false);
  const [drawn, setDrawn] = useState<SignatureStrokes | null>(null);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    void (async () => {
      const snap = await getDocs(collection(db, 'jobSites'));
      const all = snap.docs.map((d) => ({ ...(d.data() as JobSite), id: d.id }));
      all.sort((a, b) => a.name.localeCompare(b.name));
      setSites(all);
      // The yard never gets a rental ticket — its hours go on the weekly
      // timecards — so it is not offered here. It is still resolvable by id,
      // so an old deep link explains itself instead of 404ing.
      const rentals = all.filter((s) => !isTimecardSite(s));
      if (rentals.length && !all.some((s) => s.id === siteId)) {
        setSiteId(rentals.find((s) => s.active)?.id ?? rentals[0].id);
      }
    })().catch((err) => setError(errorMessage(err)));
    // Sites are picked once; a live subscription would fight the picker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const site = useMemo(() => sites?.find((s) => s.id === siteId) ?? null, [sites, siteId]);
  const rentalSites = useMemo(() => (sites ?? []).filter((s) => !isTimecardSite(s)), [sites]);
  const yardSelected = site ? isTimecardSite(site) : false;

  // Keep the address bar in step, so the page can be bookmarked or sent on.
  useEffect(() => {
    if (!siteId) return;
    setParams({ site: siteId, date }, { replace: true });
  }, [siteId, date, setParams]);

  const load = useCallback(async () => {
    if (!site) return;
    if (isTimecardSite(site)) {
      // Yard hours are payroll, not billing. Never assemble a rental ticket
      // for them — they belong on the weekly timecard.
      setTicket(null);
      return;
    }
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const { start, end } = dayBounds(date);
      const [shiftSnap, equipSnap, savedSnap, userSnap] = await Promise.all([
        getDocs(
          query(
            collection(db, 'shifts'),
            where('jobSiteId', '==', site.id),
            where('clockInAt', '>=', start),
            where('clockInAt', '<=', end),
          ),
        ),
        getDocs(collection(db, 'equipment')),
        getDoc(doc(db, 'dailyTickets', ticketId(site.id, date))),
        // For the labour side of the office copy. Read here rather than stored
        // on the ticket: a wage is what somebody is paid now, and freezing it
        // into the ticket would leave last month's tickets quoting last month's
        // rate as though it were still the answer.
        getDocs(collection(db, 'users')),
      ]);

      const shifts = shiftSnap.docs.map((d) => withTimestamps<Shift>(d));
      const equipment = equipSnap.docs.map((d) => ({ ...(d.data() as Equipment), id: d.id }));
      setRates(new Map(equipment.map((e) => [e.id, e.hourlyRate ?? null])));
      setWages(
        new Map(
          userSnap.docs.map((d) => [d.id, ((d.data() as UserDoc).hourlyRate ?? null) as number | null]),
        ),
      );
      const previous = savedSnap.exists() ? withTimestamps<Ticket>(savedSnap) : null;

      setTicket(mergeTicket(draftTicket(site, date, shifts, equipment), previous));
    } catch (err) {
      setError(errorMessage(err));
      setTicket(null);
    } finally {
      setLoading(false);
    }
  }, [site, date]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!ticket) return;
    setBusy(true);
    setError(null);
    try {
      // A signature attests to what was on the sheet when it was signed. Editing
      // the sheet afterwards and keeping the mark would put the supervisor's
      // name against figures they never saw, so an edit clears it.
      const wasSigned = Boolean(ticket.signature);
      const next = wasSigned
        ? { ...ticket, signature: null, supervisorName: null, signedAt: null }
        : ticket;
      const number = await saveDailyTicket(next);
      setTicket({ ...next, ticketNumber: number });
      setSaved(true);
      if (wasSigned) {
        setError('Saved. The ticket changed since it was signed, so it needs signing again.');
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearSignature() {
    if (!ticket?.signature) return;
    if (!window.confirm('Remove the signature from this ticket?')) return;
    setBusy(true);
    setError(null);
    try {
      await clearDailyTicketSignature(ticket.id);
      setTicket({ ...ticket, signature: null, supervisorName: null, signedAt: null });
      setSigning(false);
      setDrawn(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function sign(useInstead?: SignatureStrokes | null) {
    const mark = useInstead ?? drawn;
    if (!ticket || !mark) return;
    setBusy(true);
    setError(null);
    try {
      // Saved first: signing a ticket whose rows were never written would put a
      // signature against a document that does not exist yet.
      const number = await saveDailyTicket(ticket);
      const name = profile?.displayName ?? profile?.email ?? 'Supervisor';
      await signDailyTicket(ticket.id, name, mark);
      setTicket({ ...ticket, ticketNumber: number, supervisorName: name, signature: mark });
      setSigning(false);
      setDrawn(null);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!sites) return <Spinner label="Loading job sites…" />;
  if (!sites.length) {
    return <Banner kind="warning" title="No job sites yet">Add a job site first.</Banner>;
  }

  return (
    <>
      <Card title="Daily rental ticket" className="no-print">
        {error && <Banner kind="error">{error}</Banner>}
        {saved && <Banner kind="success">Saved.</Banner>}

        <div className="field">
          <label htmlFor="t-site">Job site</label>
          <select id="t-site" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            {/* A yard site deep-linked into the URL stays selectable so the
                picker does not silently show the wrong site's name. */}
            {(yardSelected && site ? [site, ...rentalSites] : rentalSites).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.active ? '' : ' (retired)'}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="t-date">Date</label>
          <input id="t-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>

        <div className="row-actions" style={{ marginTop: '0.9rem' }}>
          <button type="button" className="small" onClick={() => void load()} disabled={loading}>
            Rebuild from timesheet
          </button>
          <button type="button" className="small" onClick={() => void save()} disabled={busy || !ticket}>
            Save
          </button>
          <button
            type="button"
            className="small"
            onClick={() => setSigning(true)}
            disabled={busy || !ticket}
          >
            {ticket?.signature ? 'Re-sign' : 'Sign off'}
          </button>
          {ticket?.signature && (
            <button
              type="button"
              className="small danger"
              onClick={() => void clearSignature()}
              disabled={busy}
            >
              Clear signature
            </button>
          )}
          <button
            type="button"
            className="small primary"
            onClick={() => openPrintDialog(setPrinting)}
            disabled={!ticket || printing}
          >
            {printing ? 'Preparing…' : 'Print / PDF'}
          </button>
        </div>

        {printing && (
          <div className="print-status" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>
              <strong>Building the printable sheet…</strong>
              <br />
              Your print dialog will open when it is ready.
            </span>
          </div>
        )}

        {yardSelected && site && (
          <Banner kind="info" title={`${site.name} does not get a rental ticket`}>
            Hours at the yard are payroll, not billing, so they go on the weekly{' '}
            <Link to="/admin/timecards">Timecards</Link> instead.
          </Banner>
        )}

        <p className="hint">
          Rows come from the clock. Fill in the hour meters and any downtime, then save — that fixes
          the ticket number. Rebuilding picks up shifts corrected since, and keeps the readings you
          have already typed.
        </p>
      </Card>

      {loading && <Spinner label="Building the ticket…" />}

      {ticket && !loading && (
        <div className="ticket-sheet">
          <header className="ticket-head">
            <div>
              <div className="ticket-no-label">Ticket No.</div>
              <div className="ticket-no">{ticket.ticketNumber ?? '—'}</div>
            </div>
            <div className="ticket-brand">
              <img src="/coburn-logo.png" alt="" />
              <div>
                <strong>EQUIPMENT RENTAL</strong>
                <div className="ticket-title">Daily Rental Ticket &amp; Equipment Report</div>
              </div>
            </div>
            <div className="ticket-date">
              <div className="ticket-no-label">Date</div>
              <div>{new Date(`${ticket.date}T12:00:00`).toLocaleDateString()}</div>
              <div>
                {new Date(`${ticket.date}T12:00:00`).toLocaleDateString([], { weekday: 'long' })}
              </div>
            </div>
          </header>

          <div className="ticket-meta">
            <div>
              <span className="k">Customer:</span> {ticket.customer || '—'}
            </div>
            <div>
              <span className="k">Job No:</span> {ticket.jobNumber || '—'}
            </div>
            <div className="wide">
              <span className="k">Location:</span> {ticket.location || '—'}
            </div>
          </div>

          <table className="ticket-table">
            <thead>
              <tr>
                <th>Type of equipment</th>
                <th>Machine no.</th>
                <th>Tractor hours</th>
                <th>Name of operator</th>
                <th>Time in</th>
                <th>Time out</th>
                <th>Time in</th>
                <th>Time out</th>
                <th>Operator hours</th>
              </tr>
            </thead>
            <tbody>
              {ticket.rows.map((row, i) => (
                <tr key={`${row.userId}-${row.equipmentId ?? 'none'}`}>
                  <td>{row.equipmentType}</td>
                  <td>{row.machineNo}</td>
                  <td className="editable">
                    <input
                      type="number"
                      step="0.25"
                      min="0"
                      aria-label={`Tractor hours for ${row.operatorName}`}
                      value={hours(row.tractorHours)}
                      onChange={(e) => {
                        const value = e.target.value === '' ? null : Number(e.target.value);
                        setTicket({
                          ...ticket,
                          rows: ticket.rows.map((r, j) =>
                            j === i ? { ...r, tractorHours: value } : r,
                          ),
                        });
                      }}
                    />
                  </td>
                  <td>{row.operatorName}</td>
                  <td>{time(row.in1)}</td>
                  <td>{time(row.out1)}</td>
                  <td>{time(row.in2)}</td>
                  <td>{time(row.out2)}</td>
                  <td>
                    {row.operatorHours}
                    {row.stillOnTheClock && <span className="ticket-open" title="Still on the clock">*</span>}
                  </td>
                </tr>
              ))}
              {ticket.rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="ticket-empty">
                    No completed shifts at this site on this day.
                  </td>
                </tr>
              )}
              {/* Blank lines, so a supervisor can add by hand on the printed copy. */}
              {Array.from({ length: Math.max(0, 8 - ticket.rows.length) }, (_, i) => (
                <tr key={`blank-${i}`}>
                  <td colSpan={9}>&nbsp;</td>
                </tr>
              ))}
            </tbody>
          </table>

          {ticket.rows.some((r) => r.stillOnTheClock) && (
            <p className="ticket-note">
              * still on the clock — hours are not final until they clock out
            </p>
          )}

          <div className="ticket-comments">
            <label htmlFor="t-comments" className="k">
              Comments / Downtime:
            </label>
            <textarea
              id="t-comments"
              rows={2}
              value={ticket.comments}
              onChange={(e) => setTicket({ ...ticket, comments: e.target.value })}
              placeholder="D8T-2 had no GPS at 7am — Dalton worked on it till 8:25"
            />
          </div>

          <p className="ticket-conditions">
            CONDITIONS: The undersigned assumes complete charge and control of the equipment and
            personnel required in the performance of the work and in the operation thereof. The
            undersigned further agrees to protect and fully indemnify COBURN EQUIPMENT RENTAL, INC.
            against all liability for claims for personal injury or property damage. Service charges
            will be assessed at the maximum legal rate on all overdue invoices. All collection
            charges and/or attorney fees to be assumed by purchaser in case of default.
          </p>

          <div className="ticket-sign">
            <div className="ticket-sign-line">
              {ticket.signature ? (
                <SignatureMark signature={ticket.signature} />
              ) : (
                <button
                  type="button"
                  className="small no-print sig-prompt"
                  onClick={() => setSigning(true)}
                >
                  Tap to sign
                </button>
              )}
            </div>
            <div className="k">Jobsite Supervisor&rsquo;s Signature</div>
            {ticket.supervisorName && (
              <div className="ticket-sign-name">
                {ticket.supervisorName}
                {ticket.signedAt && ` · ${ticket.signedAt.toDate().toLocaleString()}`}
              </div>
            )}
          </div>

          <footer className="ticket-foot">
            13930 OAKS AVENUE • CHINO, CALIFORNIA 91710 • (909) 591-6417
          </footer>
        </div>
      )}

      {signing && (
        <Modal title="Sign the ticket" onClose={() => setSigning(false)}>
          <p className="hint" style={{ marginTop: 0 }}>
            Signing as <strong>{profile?.displayName ?? profile?.email}</strong>. Your name and the
            time are recorded alongside the signature.
          </p>

          {profile?.signature && (
            <div className="saved-signature-offer">
              <SignatureMark signature={profile.signature} />
              <button
                type="button"
                className="primary block"
                disabled={busy}
                onClick={() => void sign(profile.signature)}
              >
                {busy ? 'Saving…' : 'Use my saved signature'}
              </button>
              <p className="hint" style={{ marginBottom: 0 }}>
                Or sign below to use a different one this time.
              </p>
            </div>
          )}

          <SignaturePad onChange={setDrawn} />
          <button
            type="button"
            className="primary block"
            style={{ marginTop: '0.9rem' }}
            disabled={busy || !drawn}
            onClick={() => void sign()}
          >
            {busy ? 'Saving…' : 'Sign and save'}
          </button>
          {ticket?.signature && (
            <button
              type="button"
              className="danger block"
              style={{ marginTop: '0.6rem' }}
              disabled={busy}
              onClick={() => void clearSignature()}
            >
              Remove the signature already on this ticket
            </button>
          )}
        </Modal>
      )}

      {ticket && !loading && <RentalTotals ticket={ticket} rates={rates} wages={wages} />}
    </>
  );
}
