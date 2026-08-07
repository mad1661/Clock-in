import { Suspense, lazy, useMemo } from 'react';
import { fmtDateTime, fmtDistance, fmtDuration, fmtTime } from '../lib/format';
import { shortDeviceId } from '../lib/device';
import { FlagList, Spinner } from './ui';
import type { PunchRecord, Shift } from '../lib/types';
import type { MapPin } from './SiteMap';

const SiteMap = lazy(() => import('./SiteMap'));

/**
 * Full evidence view for one shift: both punches, how each was verified, and
 * the photo when one was used. This is what an administrator looks at before
 * approving a flagged entry, so it deliberately shows the raw captured values
 * rather than a summary.
 */
export function ShiftDetail({ shift }: { shift: Shift }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      <div className="status-grid">
        <div className="stat">
          <div className="k">Worker</div>
          <div className="v" style={{ fontSize: '0.95rem' }}>
            {shift.userDisplayName}
          </div>
        </div>
        <div className="stat">
          <div className="k">Site</div>
          <div className="v" style={{ fontSize: '0.95rem' }}>
            {shift.jobSiteName}
          </div>
        </div>
        <div className="stat">
          <div className="k">Duration</div>
          <div className="v">{fmtDuration(shift.durationMinutes)}</div>
        </div>
      </div>

      <FlagList flags={shift.flags} />

      <ShiftMap shift={shift} />

      <PunchDetail label="Clocked in" punch={shift.clockIn} />
      {shift.clockOut ? (
        <PunchDetail label="Clocked out" punch={shift.clockOut} />
      ) : (
        <p className="hint">Still clocked in — no clock-out recorded yet.</p>
      )}

      {shift.review.status !== 'pending' && shift.review.note && (
        <p className="hint">
          {shift.review.status === 'approved' ? 'Approved' : 'Rejected'}: {shift.review.note}
        </p>
      )}
    </div>
  );
}

/**
 * Where the punches happened, against the site boundary.
 *
 * "412 m from the site" is a number a supervisor has to take on trust. Drawn on
 * imagery, with the boundary circle to scale, they can see whether that is the
 * far end of the same yard or somebody's driveway — which is the actual
 * judgement being asked of them.
 */
function ShiftMap({ shift }: { shift: Shift }) {
  const pins = useMemo(() => {
    const out: MapPin[] = [];
    if (shift.clockIn.location) {
      out.push({
        lat: shift.clockIn.location.lat,
        lng: shift.clockIn.location.lng,
        accuracy: shift.clockIn.location.accuracy,
        label: `Clocked in ${fmtTime(shift.clockIn.at)}`,
        kind: 'in',
      });
    }
    if (shift.clockOut?.location) {
      out.push({
        lat: shift.clockOut.location.lat,
        lng: shift.clockOut.location.lng,
        accuracy: shift.clockOut.location.accuracy,
        label: `Clocked out ${fmtTime(shift.clockOut.at)}`,
        kind: 'out',
      });
    }
    return out;
  }, [shift]);

  // Shifts recorded before the site position was captured fall back to
  // centring on the clock-in, which is still a useful picture.
  const centre = shift.clockIn.site ?? shift.clockOut?.site ?? null;

  // Nothing to draw when neither punch produced a position.
  if (pins.length === 0) return null;

  return (
    <div>
      <Suspense fallback={<Spinner label="Loading map…" />}>
        <SiteMap
          site={centre ?? pins[0]}
          radiusMeters={centre?.radiusMeters}
          pins={pins}
          height={230}
        />
      </Suspense>
      <p className="hint">
        Green is the clock-in, red the clock-out; the dashed ring is how precise that fix
        claimed to be. The blue circle is the site boundary as it stood at the time.
        Imagery from Esri.
      </p>
    </div>
  );
}

function PunchDetail({ label, punch }: { label: string; punch: PunchRecord }) {
  return (
    <div className="row">
      <div className="row-head">
        <span className="title">{label}</span>
        <span className={`pill ${punch.method === 'gps' ? 'pill-success' : 'pill-warning'}`}>
          {punch.method === 'gps' && 'Location verified'}
          {punch.method === 'photo' && 'Photo evidence'}
          {punch.method === 'unverified' && 'Unconfirmed'}
        </span>
      </div>

      <div className="row-meta">
        <span>{fmtDateTime(punch.at)}</span>
        {punch.distanceMeters != null && <span>{fmtDistance(punch.distanceMeters)} from site</span>}
        {punch.location && <span>±{Math.round(punch.location.accuracy)} m accuracy</span>}
      </div>

      <div className="device-line">
        <span aria-hidden="true">📱</span>
        <span className="device-name">{punch.device?.label ?? 'Unknown device'}</span>
        {shortDeviceId(punch.device?.id) && (
          <span className="pill pill-muted">{shortDeviceId(punch.device?.id)}</span>
        )}
      </div>

      {punch.location && (
        <div className="row-meta">
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${punch.location.lat},${punch.location.lng}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            {punch.location.lat.toFixed(5)}, {punch.location.lng.toFixed(5)} — open in maps
          </a>
        </div>
      )}

      {punch.offline && (
        <p className="hint">
          Captured with no signal at {fmtDateTime(punch.offline.capturedAt)} and synced{' '}
          {punch.offline.delayMinutes} minute{punch.offline.delayMinutes === 1 ? '' : 's'} later.
          The time above is the phone's, not the server's.
        </p>
      )}

      {punch.locationError && (
        <p className="hint">Location error reported: {punch.locationError.message}</p>
      )}

      {punch.note && <p className="hint">Note: {punch.note}</p>}

      <details>
        <summary className="hint" style={{ cursor: 'pointer' }}>
          Full device and network details
        </summary>
        <div className="row-meta" style={{ marginTop: '0.4rem' }}>
          <span className="mono">IP {punch.ip ?? 'unknown'}</span>
          {punch.device?.timezone && <span>Timezone {punch.device.timezone}</span>}
          {punch.device?.platform && <span>Platform {punch.device.platform}</span>}
          {punch.device?.screen && <span>Screen {punch.device.screen}</span>}
          {punch.device?.language && <span>Language {punch.device.language}</span>}
        </div>
        {punch.device?.id && (
          <p className="mono hint">Device id {punch.device.id}</p>
        )}
        {punch.device?.userAgent && <p className="mono hint">{punch.device.userAgent}</p>}
      </details>
    </div>
  );
}
