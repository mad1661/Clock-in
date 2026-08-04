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
import { preparePhoto, uploadPhoto, type PreparedPhoto } from '../lib/photo';
import { describeDevice } from '../lib/device';
import { enqueue, isOfflineError, newPunchId, queueSize } from '../lib/offlineQueue';
import { syncPendingPunches } from '../lib/syncQueue';
import { api, errorMessage, photoRequiredDetail, toLocationError, type ClockResult } from '../lib/api';
import { distanceMeters, POLICY } from '../lib/policy';
import { fmtDistance, fmtDateTime, elapsedSince } from '../lib/format';
import { Banner, Card, FlagList, Spinner } from '../components/ui';
import type { JobSite, PhotoRequiredDetail, Shift } from '../lib/types';

type Phase = 'idle' | 'locating' | 'submitting' | 'photo-required' | 'uploading';

export default function ClockPage() {
  const { user, profile } = useAuth();

  const [sites, setSites] = useState<JobSite[] | null>(null);
  const [openShift, setOpenShift] = useState<Shift | null | undefined>(undefined);
  const [selectedSiteId, setSelectedSiteId] = useState('');

  const [phase, setPhase] = useState<Phase>('idle');
  const [fix, setFix] = useState<LocationFix | null>(null);
  const [failure, setFailure] = useState<LocationFailure | null>(null);
  const [blocker, setBlocker] = useState<PhotoRequiredDetail | null>(null);
  // Kept apart from `error` so the server's explanation of *why* location was
  // refused stays on screen while the worker takes and retakes their photo.
  const [blockerMessage, setBlockerMessage] = useState<string | null>(null);
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ClockResult | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pendingCount, setPendingCount] = useState(0);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
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
        const doc = snap.docs[0];
        setOpenShift(doc ? ({ ...(doc.data() as Shift), id: doc.id }) : null);
      },
      () => setOpenShift(null),
    );
  }, [user]);

  // Tick the on-shift timer.
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

  const drainQueue = useCallback(async () => {
    if (!user) return;
    const result = await syncPendingPunches(user.uid);
    setPendingCount(result.remaining);
    if (result.synced > 0) {
      setSyncNote(
        `${result.synced} punch${result.synced === 1 ? '' : 'es'} saved on your phone ${
          result.synced === 1 ? 'has' : 'have'
        } now been sent in.`,
      );
    }
    if (result.failed.length > 0) {
      setError(
        `A saved punch could not be accepted: ${result.failed[0].message} Tell your supervisor so they can add the hours.`,
      );
    }
  }, [user]);

  useEffect(() => {
    void queueSize().then(setPendingCount);
    void drainQueue();

    const onOnline = () => void drainQueue();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [drainQueue]);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    return () => {
      if (photo) URL.revokeObjectURL(photo.previewUrl);
    };
  }, [photo]);

  const isClockedIn = Boolean(openShift);
  const activeSite = useMemo(() => {
    const id = openShift?.jobSiteId ?? selectedSiteId;
    return sites?.find((s) => s.id === id) ?? null;
  }, [sites, openShift, selectedSiteId]);

  const liveDistance = useMemo(() => {
    if (!fix || !activeSite) return null;
    return distanceMeters(fix, activeSite);
  }, [fix, activeSite]);

  const busy = phase === 'locating' || phase === 'submitting' || phase === 'uploading';

  // --- Actions ------------------------------------------------------------

  const reset = useCallback(() => {
    setFix(null);
    setFailure(null);
    setBlocker(null);
    setBlockerMessage(null);
    setError(null);
    if (photo) URL.revokeObjectURL(photo.previewUrl);
    setPhoto(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [photo]);

  const saveForLater = useCallback(
    async (opts: { location: LocationFix | null; failure: LocationFailure | null }) => {
      await enqueue({
        id: newPunchId(),
        action: openShift ? 'out' : 'in',
        jobSiteId: openShift?.jobSiteId ?? selectedSiteId,
        jobSiteName: activeSite?.name ?? 'this job site',
        // The phone's clock. The server bounds it to 24 hours, refuses future
        // dates, and flags every synced punch for a supervisor to confirm.
        capturedAt: Date.now(),
        location: opts.location,
        locationError: opts.failure ? toLocationError(opts.failure) : null,
        // Keep the blob, not the uploaded path: with no signal the upload
        // cannot have happened, so the photo travels with the punch.
        photo: photo?.blob ?? null,
        device: describeDevice(),
        attempts: 0,
        lastError: null,
      });
      setPendingCount(await queueSize());
      reset();
      setPhase('idle');
      setResult(null);
      setSyncNote(
        'No signal — your punch is saved on this phone and will be sent in automatically as soon as you have a connection. You can close the app.',
      );
    },
    [openShift, selectedSiteId, activeSite, photo, reset],
  );

  const submit = useCallback(
    async (opts: { location: LocationFix | null; failure: LocationFailure | null; photoPath: string | null }) => {
      const jobSiteId = openShift?.jobSiteId ?? selectedSiteId;
      const payload = {
        jobSiteId,
        location: opts.location,
        locationError: opts.failure ? toLocationError(opts.failure) : null,
        photoPath: opts.photoPath,
        device: describeDevice(),
      };

      setPhase('submitting');
      try {
        const res = isClockedIn ? await api.clockOut(payload) : await api.clockIn(payload);
        setResult(res);
        reset();
        setPhase('idle');
        void drainQueue();
        return true;
      } catch (err) {
        // No answer from the server is not the same as the server saying no.
        // Hold the punch on the phone rather than making the worker lose it.
        if (isOfflineError(err)) {
          await saveForLater({ location: opts.location, failure: opts.failure });
          return true;
        }
        const detail = photoRequiredDetail(err);
        if (detail) {
          // Not a failure — the server is telling us the punch needs a photo.
          setBlocker(detail);
          setBlockerMessage(errorMessage(err));
          setError(null);
          setPhase('photo-required');
        } else {
          setError(errorMessage(err));
          setPhase('idle');
        }
        return false;
      }
    },
    [isClockedIn, openShift?.jobSiteId, selectedSiteId, reset, drainQueue, saveForLater],
  );

  const start = useCallback(async () => {
    if (!openShift && !selectedSiteId) {
      setError('Choose a job site first.');
      return;
    }
    reset();
    setResult(null);
    setSyncNote(null);
    setPhase('locating');

    const controller = new AbortController();
    abortRef.current = controller;

    const located = await acquireLocation({
      signal: controller.signal,
      onProgress: setFix,
    });

    if (located.ok) {
      setFix(located.fix);
      await submit({ location: located.fix, failure: null, photoPath: null });
      return;
    }

    setFailure(located.failure);
    setFix(located.failure.bestEffort);
    // Send the attempt anyway: the server decides whether the punch is
    // acceptable, and a failed attempt with its best-effort fix is worth
    // recording either way.
    await submit({
      location: located.failure.bestEffort,
      failure: located.failure,
      photoPath: null,
    });
  }, [openShift, selectedSiteId, reset, submit]);

  const onPickPhoto = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const prepared = await preparePhoto(file);
      setPhoto((prev) => {
        if (prev) URL.revokeObjectURL(prev.previewUrl);
        return prepared;
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const submitWithPhoto = useCallback(async () => {
    if (!photo || !user) return;
    setError(null);
    setPhase('uploading');
    try {
      const path = await uploadPhoto(user.uid, photo);
      await submit({ location: fix, failure, photoPath: path });
    } catch (err) {
      setError(errorMessage(err));
      setPhase('photo-required');
    }
  }, [photo, user, fix, failure, submit]);

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

  return (
    <>
      {pendingCount > 0 && (
        <Banner kind="warning" title="Saved on this phone">
          {pendingCount} punch{pendingCount === 1 ? '' : 'es'} waiting to be sent in. This happens
          automatically when you have a signal — you do not need to keep the app open.
        </Banner>
      )}

      {syncNote && <Banner kind="info">{syncNote}</Banner>}

      {profile?.mustChangePassword && (
        <Banner kind="warning" title="You are still on a temporary password">
          Open the <strong>Account</strong> tab and set a password only you know.
        </Banner>
      )}

      {result && (
        <Banner
          kind={result.needsReview ? 'warning' : 'success'}
          title={result.durationMinutes === undefined ? 'Clocked in' : 'Clocked out'}
        >
          {result.method === 'gps'
            ? `Location confirmed${
                result.distanceMeters != null ? ` — ${fmtDistance(result.distanceMeters)} from the site` : ''
              }.`
            : 'Recorded with a photo instead of location.'}
          {result.needsReview && (
            <>
              {' '}
              This entry has been sent to your administrator to approve. Your hours are safe in the
              meantime.
              <FlagList flags={result.flags} />
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
            </p>
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

        {phase === 'locating' && <LocatingReadout fix={fix} distance={liveDistance} site={activeSite} />}

        {!blocker && (
          <button
            type="button"
            className={`clock-btn ${isClockedIn ? 'danger' : 'success'}`}
            disabled={busy || (!isClockedIn && !selectedSiteId)}
            onClick={() => void start()}
          >
            {busy ? (
              <>
                <span>{phaseLabel(phase)}</span>
                <span className="sub">Hold still — do not close this page</span>
              </>
            ) : (
              <>
                <span>{isClockedIn ? 'Clock out' : 'Clock in'}</span>
                <span className="sub">
                  {isClockedIn ? 'Confirms your location again' : 'Uses your location to confirm you are on site'}
                </span>
              </>
            )}
          </button>
        )}

        {error && !blocker && (
          <div style={{ marginTop: '0.9rem' }}>
            <Banner kind="error">{error}</Banner>
          </div>
        )}
      </Card>

      {blocker && (
        <PhotoFallback
          blocker={blocker}
          failure={failure}
          message={blockerMessage}
          error={error}
          photo={photo}
          fileInputRef={fileInputRef}
          onPickPhoto={onPickPhoto}
          onSubmit={() => void submitWithPhoto()}
          onRetryLocation={() => void start()}
          busy={phase === 'uploading' || phase === 'submitting'}
          busyLabel={phase === 'uploading' ? 'Uploading photo…' : 'Submitting…'}
        />
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

function phaseLabel(phase: Phase): string {
  if (phase === 'locating') return 'Finding your location…';
  if (phase === 'uploading') return 'Uploading photo…';
  return 'Submitting…';
}

function LocatingReadout({
  fix,
  distance,
  site,
}: {
  fix: LocationFix | null;
  distance: number | null;
  site: JobSite | null;
}) {
  if (!fix) {
    return (
      <div style={{ marginBottom: '0.9rem' }}>
        <Spinner label="Waiting for a GPS signal…" />
      </div>
    );
  }

  const good = fix.accuracy <= POLICY.maxAccuracyMeters;
  // Full bar at 10 m, empty at 300 m — enough resolution to see the fix
  // tightening up while the worker waits.
  const pct = Math.max(4, Math.min(100, Math.round((1 - (fix.accuracy - 10) / 290) * 100)));

  return (
    <div style={{ marginBottom: '0.9rem' }}>
      <div className="status-grid">
        <div className="stat">
          <div className="k">Accuracy</div>
          <div className="v">±{Math.round(fix.accuracy)} m</div>
        </div>
        {distance != null && site && (
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
        {good
          ? 'Signal is good enough. Finishing up…'
          : 'Still improving — stepping outside or away from metal helps.'}
      </p>
    </div>
  );
}

function PhotoFallback({
  blocker,
  failure,
  message,
  error,
  photo,
  fileInputRef,
  onPickPhoto,
  onSubmit,
  onRetryLocation,
  busy,
  busyLabel,
}: {
  blocker: PhotoRequiredDetail;
  failure: LocationFailure | null;
  message: string | null;
  error: string | null;
  photo: PreparedPhoto | null;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onPickPhoto: (file: File | undefined) => void;
  onSubmit: () => void;
  onRetryLocation: () => void;
  busy: boolean;
  busyLabel: string;
}) {
  const permissionProblem = failure?.kind === 'permission-denied' || failure?.kind === 'insecure-context';

  return (
    <Card title="Take a photo instead">
      <Banner kind="warning" title="We could not confirm your location">
        {message ?? 'Your location could not be verified.'}
        {failure && <p className="hint">{describeFailure(failure)}</p>}
        {blocker.distanceMeters != null && (
          <p className="hint">
            Nearest reading put you {fmtDistance(blocker.distanceMeters)} from {blocker.jobSiteName},
            and the boundary is {fmtDistance(blocker.allowedRadiusMeters)}.
          </p>
        )}
      </Banner>

      {permissionProblem && (
        <div style={{ marginTop: '0.9rem' }}>
          <strong>Turn location back on — it is quicker than a photo:</strong>
          <ol className="steps">
            {permissionHelp().map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      )}

      {error && (
        <div style={{ marginTop: '0.9rem' }}>
          <Banner kind="error">{error}</Banner>
        </div>
      )}

      <button
        type="button"
        className="block"
        style={{ marginTop: '0.9rem' }}
        onClick={onRetryLocation}
        disabled={busy}
      >
        Try location again
      </button>

      <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '1.2rem 0' }} />

      <p style={{ marginTop: 0 }}>
        <strong>Or prove you are here with a photo.</strong> Take a clear picture of where you are
        standing — the site entrance, a site board, the work in front of you. Your supervisor
        reviews it and approves your hours.
      </p>

      <label className="visually-hidden" htmlFor="site-photo">
        Photo taken at the job site
      </label>
      <input
        ref={fileInputRef}
        id="site-photo"
        className="visually-hidden"
        type="file"
        accept="image/*"
        // `capture` asks the phone for the camera rather than the photo library.
        // It is a hint, not a guarantee — so the server independently checks the
        // upload is seconds old and has never been used before.
        capture="environment"
        onChange={(e) => onPickPhoto(e.target.files?.[0])}
      />

      <button
        type="button"
        className="clock-btn primary"
        style={{ minHeight: 96 }}
        onClick={() => fileInputRef.current?.click()}
      >
        <span>{photo ? 'Retake photo' : '📷 Take photo'}</span>
        <span className="sub">Opens your camera</span>
      </button>

      {photo && (
        <div style={{ marginTop: '0.9rem' }}>
          <img className="photo-preview" src={photo.previewUrl} alt="Photo you just took" />
          {photo.looksPreExisting && (
            <div style={{ marginTop: '0.6rem' }}>
              <Banner kind="warning">
                This photo does not look like it was just taken. Photos from your camera roll are
                rejected — please take a new one here.
              </Banner>
            </div>
          )}
          <button
            type="button"
            className="primary block"
            style={{ marginTop: '0.9rem' }}
            onClick={onSubmit}
            disabled={busy}
          >
            {busy ? busyLabel : 'Submit for approval'}
          </button>
          <p className="hint">
            Your hours are recorded straight away and flagged for your administrator to confirm.
          </p>
        </div>
      )}
    </Card>
  );
}
