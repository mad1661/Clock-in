import { useEffect, useState } from 'react';
import { getDownloadURL, ref } from 'firebase/storage';
import { storage } from '../firebase';
import { fmtDateTime, fmtDistance, fmtDuration } from '../lib/format';
import { shortDeviceId } from '../lib/device';
import { FlagList } from './ui';
import type { PunchRecord, Shift } from '../lib/types';

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

function PunchDetail({ label, punch }: { label: string; punch: PunchRecord }) {
  return (
    <div className="row">
      <div className="row-head">
        <span className="title">{label}</span>
        <span className={`pill ${punch.method === 'gps' ? 'pill-success' : 'pill-warning'}`}>
          {punch.method === 'gps' ? 'Location verified' : 'Photo evidence'}
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

      {punch.locationError && (
        <p className="hint">Location error reported: {punch.locationError.message}</p>
      )}

      {punch.note && <p className="hint">Note: {punch.note}</p>}

      {punch.photoPath && <PhotoEvidence path={punch.photoPath} />}

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

function PhotoEvidence({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getDownloadURL(ref(storage, path))
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (failed) return <p className="hint">Photo could not be loaded.</p>;
  if (!url) return <p className="hint">Loading photo…</p>;

  return (
    <a href={url} target="_blank" rel="noreferrer noopener">
      <img className="photo-preview" src={url} alt="Proof of presence taken at the job site" />
    </a>
  );
}
