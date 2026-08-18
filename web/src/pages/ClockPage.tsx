import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, onSnapshot, query, where, orderBy, limit } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../auth/AuthProvider';
import {
  acquireLocation,
  describeFailure,
  permissionHelp,
  type LocationFailure,
  type LocationFix,
} from '../lib/geolocation';
import { clockIn, clockOut, evaluatePunch } from '../lib/actions';
import { errorMessage, toLocationError } from '../lib/errors';
import { distanceMeters, POLICY } from '../lib/policy';
import { fmtDistance, fmtDateTime, elapsedSince } from '../lib/format';
import { Banner, Card, Spinner } from '../components/ui';
import { withTimestamps } from '../lib/snapshot';
import { equipmentLabel, type Equipment, type JobSite, type Shift } from '../lib/types';

type Phase = 'idle' | 'locating' | 'submitting';

interface PunchResult {
  action: 'in' | 'out';
  verified: boolean;
  distanceMeters: number | null;
}

/**
 * The clock screen.
 *
 * Writes straight to Firestore; firestore.rules is what decides whether a punch
 * counts as verified. Everything computed here is for the worker's benefit —
 * the rules recompute the geofence from the job site document and reject the
 * write if this disagreed with them.
 *
 * A punch that cannot be confirmed is never refused. It is recorded and flagged
 * for a supervisor, because a worker whose GPS fails still did the hours.
 */
export default function ClockPage() {
  const { user, profile } = useAuth();

  const [sites, setSites] = useState<JobSite[] | null>(null);
  const [openShift, setOpenShift] = useState<Shift | null | undefined>(undefined);
  const [selectedSiteId, setSelectedSiteId] = useState('');
  const [machines, setMachines] = useState<Equipment[]>([]);
  const [selectedEquipmentId, setSelectedEquipmentId] = useState('');
  const [tractorHours, setTractorHours] = useState('');

  const [phase, setPhase] = useState<Phase>('idle');
  const [fix, setFix] = useState<LocationFix | null>(null);
  const [failure, setFailure] = useState<LocationFailure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PunchResult | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const abortRef = useRef<AbortController | null>(null);

  // --- Live data ----------------------------------------------------------
  useEffect(() => {
    return onSnapshot(
      query(collection(db, 'jobSites'), where('active', '==', true)),
      (snap) => {
        const all = snap.docs.map((d) => ({ ...(d.data() as JobSite), id: d.id }));
        const assigned = profile?.jobSiteIds ?? [];
        // An empty assignment list means "any site" — common for a small crew
        // that moves around.
        const visible = assigned.length ? all.filter((s) => assigned.includes(s.id)) : all;
        visible.sort((a, b) => a.name.localeCompare(b.name));
        setSites(visible);
      },
      () => setSites([]),
    );
  }, [profile?.jobSiteIds]);

  useEffect(() => {
    return onSnapshot(
      query(collection(db, 'equipment'), where('active', '==', true)),
      (snap) => setMachines(snap.docs.map((d) => ({ ...(d.data() as Equipment), id: d.id }))),
      () => setMachines([]),
    );
  }, []);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(
      query(
        collection(db, 'shifts'),
        where('userId', '==', user.uid),
        where('status', '==', 'open'),
        orderBy('clockInAt', 'desc'),
        limit(1),
      ),
      (snap) => {
        const first = snap.docs[0];
        setOpenShift(first ? withTimestamps<Shift>(first) : null);
      },
      () => setOpenShift(null),
    );
  }, [user]);

  useEffect(() => {
    if (!openShift) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [openShift]);

  // Default the picker to the only option, or to the last site used.
  useEffect(() => {
    if (!sites?.length || selectedSiteId) return;
    if (sites.length === 1) {
      setSelectedSiteId(sites[0].id);
      return;
    }
    const remembered = window.localStorage.getItem('lastJobSiteId');
    if (remembered && sites.some((s) => s.id === remembered)) setSelectedSiteId(remembered);
  }, [sites, selectedSiteId]);

  useEffect(() => {
    if (selectedSiteId) window.localStorage.setItem('lastJobSiteId', selectedSiteId);
  }, [selectedSiteId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const isClockedIn = Boolean(openShift);
  const activeSite = useMemo(() => {
    const id = openShift?.jobSiteId ?? selectedSiteId;
    return sites?.find((s) => s.id === id) ?? null;
  }, [sites, openShift, selectedSiteId]);

  // Only the machines assigned to this site. An operator should not be scrolling
  // past the whole yard to find the one they are sitting in.
  const siteMachines = useMemo(() => {
    const ids = activeSite?.equipmentIds ?? [];
    return machines
      .filter((m) => ids.includes(m.id))
      .sort((a, b) => equipmentLabel(a).localeCompare(equipmentLabel(b)));
  }, [machines, activeSite]);

  const selectedMachine = useMemo(
    () => siteMachines.find((m) => m.id === selectedEquipmentId) ?? null,
    [siteMachines, selectedEquipmentId],
  );

  /** The machine recorded on the shift being closed. */
  const openShiftMachine = useMemo(
    () => machines.find((m) => m.id === openShift?.equipmentId) ?? null,
    [machines, openShift],
  );

  // Default to the only machine, or the one they were on last.
  useEffect(() => {
    if (!siteMachines.length) {
      setSelectedEquipmentId('');
      return;
    }
    if (siteMachines.some((m) => m.id === selectedEquipmentId)) return;
    if (siteMachines.length === 1) {
      setSelectedEquipmentId(siteMachines[0].id);
      return;
    }
    const remembered = window.localStorage.getItem('lastEquipmentId');
    setSelectedEquipmentId(
      remembered && siteMachines.some((m) => m.id === remembered) ? remembered : '',
    );
  }, [siteMachines, selectedEquipmentId]);

  useEffect(() => {
    if (selectedEquipmentId) window.localStorage.setItem('lastEquipmentId', selectedEquipmentId);
  }, [selectedEquipmentId]);

  const liveDistance = useMemo(
    () => (fix && activeSite ? distanceMeters(fix, activeSite) : null),
    [fix, activeSite],
  );

  const busy = phase === 'locating' || phase === 'submitting';

  // --- The one action -----------------------------------------------------

  const punch = useCallback(async () => {
    if (!activeSite) {
      setError('Choose a job site first.');
      return;
    }

    setError(null);
    setResult(null);
    setFix(null);
    setFailure(null);
    setPhase('locating');

    const controller = new AbortController();
    abortRef.current = controller;

    const located = await acquireLocation({ signal: controller.signal, onProgress: setFix });
    const location = located.ok ? located.fix : located.failure.bestEffort;
    const locationError = located.ok ? null : toLocationError(located.failure);
    if (!located.ok) setFailure(located.failure);
    setFix(location);

    setPhase('submitting');
    try {
      const hours = tractorHours.trim() === '' ? null : Number(tractorHours);
      const input = {
        site: activeSite,
        location,
        locationError,
        equipment: isClockedIn ? null : selectedMachine,
        tractorHours: Number.isFinite(hours as number) ? hours : null,
      };
      const outcome = isClockedIn
        ? await clockOut(openShift as Shift, input)
        : await clockIn(input);
      setTractorHours('');

      setResult({
        action: isClockedIn ? 'out' : 'in',
        verified: outcome.verified,
        distanceMeters: outcome.distanceMeters,
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPhase('idle');
    }
  }, [activeSite, isClockedIn, openShift, selectedMachine, tractorHours]);

  // --- Render -------------------------------------------------------------

  if (sites === null || openShift === undefined) {
    return <Spinner label="Loading your shift…" />;
  }

  if (sites.length === 0) {
    return (
      <Banner kind="warning" title="No job sites available">
        You are not assigned to any active job site yet. Ask your administrator to add one.
      </Banner>
    );
  }

  const preview = activeSite && fix ? evaluatePunch(activeSite, fix) : null;

  return (
    <>
      {profile?.mustChangePassword && (
        <Banner kind="warning" title="You are still on a temporary password">
          Open the <strong>Account</strong> tab and set a password only you know.
        </Banner>
      )}

      {result && (
        <Banner
          kind={result.verified ? 'success' : 'warning'}
          title={result.action === 'in' ? 'Clocked in' : 'Clocked out'}
        >
          {result.verified ? (
            <>
              Location confirmed
              {result.distanceMeters != null
                ? ` — ${fmtDistance(result.distanceMeters)} from the site`
                : ''}
              .
            </>
          ) : (
            <>
              Your hours are recorded. We could not confirm you were on site this time, so your
              supervisor has been asked to approve it.
              {failure && <p className="hint">{describeFailure(failure)}</p>}
            </>
          )}
        </Banner>
      )}

      <Card>
        {isClockedIn && openShift ? (
          <>
            <p className="hint" style={{ textAlign: 'center', margin: 0 }}>
              On shift at <strong>{openShift.jobSiteName}</strong>
            </p>
            <p className="elapsed">{elapsedSince(openShift.clockInAt.toMillis(), now)}</p>
            <p className="hint" style={{ textAlign: 'center', marginTop: 0 }}>
              Since {fmtDateTime(openShift.clockInAt)}
              {openShiftMachine ? ` · ${equipmentLabel(openShiftMachine)}` : ''}
            </p>

            {openShift.equipmentId && (
              <div className="field">
                <label htmlFor="hours">Hour meter (optional)</label>
                <input
                  id="hours"
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  min="0"
                  value={tractorHours}
                  onChange={(e) => setTractorHours(e.target.value)}
                  placeholder="Reading on the machine"
                  disabled={busy}
                />
                <p className="hint">
                  Read it off {equipmentLabel(openShiftMachine ?? { type: 'the machine' })} before
                  you climb down. Leave it blank if you cannot — your supervisor can fill it in.
                </p>
              </div>
            )}
          </>
        ) : (
          <div className="field">
            <label htmlFor="site">Job site</label>
            <select
              id="site"
              value={selectedSiteId}
              onChange={(e) => setSelectedSiteId(e.target.value)}
              disabled={busy}
            >
              <option value="">Choose a site…</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                  {site.address ? ` — ${site.address}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        {!isClockedIn && siteMachines.length > 0 && (
          <div className="field">
            <label htmlFor="machine">Machine</label>
            <select
              id="machine"
              value={selectedEquipmentId}
              onChange={(e) => setSelectedEquipmentId(e.target.value)}
              disabled={busy}
            >
              <option value="">Not on a machine</option>
              {siteMachines.map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {equipmentLabel(machine)}
                  {machine.description ? ` — ${machine.description}` : ''}
                </option>
              ))}
            </select>
            <p className="hint">This is what puts you on the customer's rental ticket.</p>
          </div>
        )}

        {phase === 'locating' && (
          <LocatingReadout fix={fix} distance={liveDistance} inside={preview?.verified ?? null} />
        )}

        <button
          type="button"
          className={`clock-btn ${isClockedIn ? 'danger' : 'success'}`}
          disabled={busy || (!isClockedIn && !selectedSiteId)}
          onClick={() => void punch()}
        >
          {busy ? (
            <>
              <span>{phase === 'locating' ? 'Finding your location…' : 'Saving…'}</span>
              <span className="sub">Hold still — do not close this page</span>
            </>
          ) : (
            <>
              <span>{isClockedIn ? 'Clock out' : 'Clock in'}</span>
              <span className="sub">
                {isClockedIn
                  ? 'Confirms your location again'
                  : 'Uses your location to confirm you are on site'}
              </span>
            </>
          )}
        </button>

        {error && (
          <div style={{ marginTop: '0.9rem' }}>
            <Banner kind="error">{error}</Banner>
          </div>
        )}
      </Card>

      {failure && !busy && !result && (
        <Card title="Location is switched off">
          <p style={{ marginTop: 0 }}>{describeFailure(failure)}</p>
          {(failure.kind === 'permission-denied' || failure.kind === 'insecure-context') && (
            <>
              <strong>Turn it back on:</strong>
              <ol className="steps">
                {permissionHelp().map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </>
          )}
          <p className="hint">
            You can still clock in without it — your punch is recorded and sent to your supervisor
            to confirm.
          </p>
        </Card>
      )}

      {!isClockedIn && activeSite && (
        <Card title="About this site">
          <div className="row-meta">
            <span>{activeSite.address || 'No address on file'}</span>
            <span>Boundary: {fmtDistance(activeSite.radiusMeters)}</span>
            {liveDistance != null && <span>You are {fmtDistance(liveDistance)} away</span>}
          </div>
        </Card>
      )}
    </>
  );
}

function LocatingReadout({
  fix,
  distance,
  inside,
}: {
  fix: LocationFix | null;
  distance: number | null;
  inside: boolean | null;
}) {
  if (!fix) {
    return (
      <div style={{ marginBottom: '0.9rem' }}>
        <Spinner label="Waiting for a GPS signal…" />
      </div>
    );
  }

  const good = fix.accuracy <= POLICY.maxAccuracyMeters;
  // Full bar at 10 m, empty at 300 m — enough resolution to watch the fix
  // tighten up while the worker waits.
  const pct = Math.max(4, Math.min(100, Math.round((1 - (fix.accuracy - 10) / 290) * 100)));

  return (
    <div style={{ marginBottom: '0.9rem' }}>
      <div className="status-grid">
        <div className="stat">
          <div className="k">Accuracy</div>
          <div className="v">±{Math.round(fix.accuracy)} m</div>
        </div>
        {distance != null && (
          <div className="stat">
            <div className="k">Distance to site</div>
            <div className="v">{fmtDistance(distance)}</div>
          </div>
        )}
      </div>
      <div className={`meter ${good ? 'good' : 'bad'}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="hint">
        {inside === true
          ? 'You are inside the site boundary. Finishing up…'
          : good
            ? 'Signal is good. Checking the boundary…'
            : 'Still improving — stepping outside or away from metal helps.'}
      </p>
    </div>
  );
}
