import { Suspense, lazy, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from '../../firebase';
import { api, errorMessage } from '../../lib/api';
import { acquireLocation } from '../../lib/geolocation';
import { fmtDistance } from '../../lib/format';
import { Banner, Card, EmptyState, Modal, Spinner } from '../../components/ui';
import { geocode, type GeocodeHit } from '../../lib/basemap';
import type { JobSite } from '../../lib/types';

// Only admins ever open a map, and the crew's clock screen must stay small on
// a bad connection, so Leaflet is split out of the main bundle.
const SiteMap = lazy(() => import('../../components/SiteMap'));

const DEFAULT_RADIUS = 150;

export default function JobSites() {
  const [sites, setSites] = useState<JobSite[] | null>(null);
  const [editing, setEditing] = useState<JobSite | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return onSnapshot(
      query(collection(db, 'jobSites'), orderBy('name')),
      (snap) => setSites(snap.docs.map((d) => ({ ...(d.data() as JobSite), id: d.id }))),
      (err) => {
        setSites([]);
        setError(errorMessage(err));
      },
    );
  }, []);

  if (!sites) return <Spinner label="Loading job sites…" />;

  return (
    <>
      {error && <Banner kind="error">{error}</Banner>}

      {editing && (
        <SiteForm
          site={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}

      <Card
        title={`Job sites (${sites.length})`}
        actions={
          <button type="button" className="small primary" onClick={() => setEditing('new')}>
            + Add site
          </button>
        }
      >
        <p className="hint" style={{ marginTop: 0 }}>
          A worker must be inside a site's boundary for their clock-in to be accepted automatically.
          Anything outside it still gets recorded, but needs your approval.
        </p>

        {sites.length === 0 ? (
          <EmptyState>No job sites yet. Add one so your crew can clock in.</EmptyState>
        ) : (
          <ul className="list">
            {sites.map((site) => (
              <li key={site.id} className="row">
                <div className="row-head">
                  <span className="title">{site.name}</span>
                  {!site.active && <span className="pill pill-error">Retired</span>}
                </div>
                <div className="row-meta">
                  <span>{site.address || 'No address'}</span>
                  <span>Boundary {fmtDistance(site.radiusMeters)}</span>
                  <span className="mono">
                    {site.lat.toFixed(5)}, {site.lng.toFixed(5)}
                  </span>
                </div>
                <div className="row-actions">
                  <button type="button" className="small" onClick={() => setEditing(site)}>
                    Edit
                  </button>
                  <a
                    className="small"
                    href={`https://www.google.com/maps/search/?api=1&query=${site.lat},${site.lng}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    style={{ alignSelf: 'center' }}
                  >
                    View on map
                  </a>
                  {site.active && (
                    <button
                      type="button"
                      className="small danger"
                      onClick={() => {
                        if (!window.confirm(`Retire ${site.name}? Nobody will be able to clock in there.`))
                          return;
                        void api.deleteJobSite({ id: site.id }).catch((err) => setError(errorMessage(err)));
                      }}
                    >
                      Retire
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function SiteForm({
  site,
  onClose,
  onSaved,
}: {
  site: JobSite | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(site?.name ?? '');
  const [address, setAddress] = useState(site?.address ?? '');
  const [lat, setLat] = useState(site ? String(site.lat) : '');
  const [lng, setLng] = useState(site ? String(site.lng) : '');
  const [radius, setRadius] = useState(String(site?.radiusMeters ?? DEFAULT_RADIUS));
  const [active, setActive] = useState(site?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<GeocodeHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchAbort = useRef<AbortController | null>(null);

  const point = useMemo(() => {
    const latN = Number(lat);
    const lngN = Number(lng);
    return Number.isFinite(latN) && Number.isFinite(lngN) && (latN !== 0 || lngN !== 0)
      ? { lat: latN, lng: lngN }
      : null;
  }, [lat, lng]);

  async function findAddress() {
    if (!search.trim()) return;
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;

    setSearching(true);
    setError(null);
    try {
      const found = await geocode(search.trim(), controller.signal);
      setHits(found);
      if (found.length === 0) setError('No match for that address. Drop the pin by hand instead.');
    } catch (err) {
      if (!controller.signal.aborted) {
        setHits(null);
        setError(
          'Address lookup is not available right now. Tap the map or use your current location instead.',
        );
      }
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }

  useEffect(() => () => searchAbort.current?.abort(), []);

  async function useMyLocation() {
    setLocating(true);
    setError(null);
    const res = await acquireLocation({ targetAccuracy: 30, timeoutMs: 25000 });
    setLocating(false);
    const fix = res.ok ? res.fix : res.failure.bestEffort;
    if (!fix) {
      setError('Could not get a location. Enter the coordinates by hand.');
      return;
    }
    setLat(fix.lat.toFixed(6));
    setLng(fix.lng.toFixed(6));
    if (!res.ok) {
      setError(
        `Only accurate to about ${Math.round(fix.accuracy)} m — check the coordinates before saving.`,
      );
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.upsertJobSite({
        ...(site ? { id: site.id } : {}),
        name,
        address,
        lat: Number(lat),
        lng: Number(lng),
        radiusMeters: Number(radius),
        active,
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={site ? `Edit ${site.name}` : 'Add job site'} onClose={onClose}>
      {error && <Banner kind="warning">{error}</Banner>}

      <form onSubmit={onSubmit} style={{ marginTop: error ? '0.9rem' : 0 }}>
        <div className="field">
          <label htmlFor="s-name">Site name</label>
          <input id="s-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="s-address">Address</label>
          <input id="s-address" value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="s-search">Find by address</label>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              id="s-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void findAddress();
                }
              }}
              placeholder="12 Dock Street, Chino CA"
              autoComplete="off"
            />
            <button
              type="button"
              style={{ flex: '0 0 auto' }}
              onClick={() => void findAddress()}
              disabled={searching}
            >
              {searching ? '…' : 'Search'}
            </button>
          </div>
        </div>

        {hits && hits.length > 0 && (
          <ul className="list" style={{ marginBottom: '0.9rem' }}>
            {hits.map((hit) => (
              <li key={`${hit.lat},${hit.lng}`}>
                <button
                  type="button"
                  className="block small"
                  style={{ textAlign: 'left' }}
                  onClick={() => {
                    setLat(hit.lat.toFixed(6));
                    setLng(hit.lng.toFixed(6));
                    if (!address) setAddress(hit.label);
                    setHits(null);
                  }}
                >
                  {hit.label}
                </button>
              </li>
            ))}
          </ul>
        )}

        <Suspense fallback={<Spinner label="Loading map…" />}>
          <SiteMap
            site={point}
            radiusMeters={Number(radius) || undefined}
            onMove={(newLat, newLng) => {
              setLat(newLat.toFixed(6));
              setLng(newLng.toFixed(6));
            }}
            height={280}
          />
        </Suspense>
        <p className="hint">
          Satellite imagery from Esri. Tap the map or drag the pin to set the centre; the blue
          circle is the boundary workers must be inside.
        </p>

        <button
          type="button"
          className="block"
          style={{ marginTop: '0.6rem' }}
          onClick={() => void useMyLocation()}
          disabled={locating}
        >
          {locating ? 'Finding your location…' : '📍 Use my current location'}
        </button>
        {locating && <Spinner />}

        <div className="field-row" style={{ marginTop: '0.9rem' }}>
          <div className="field">
            <label htmlFor="s-lat">Latitude</label>
            <input
              id="s-lat"
              required
              inputMode="decimal"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              placeholder="51.50735"
            />
          </div>
          <div className="field">
            <label htmlFor="s-lng">Longitude</label>
            <input
              id="s-lng"
              required
              inputMode="decimal"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              placeholder="-0.12776"
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="s-radius">Boundary radius (metres)</label>
          <input
            id="s-radius"
            type="number"
            min={25}
            max={2000}
            step={5}
            required
            value={radius}
            onChange={(e) => setRadius(e.target.value)}
          />
          <p className="hint">
            Between 25 m and 2000 m. Too tight and honest workers get sent to the photo fallback;
            150 m suits most sites.
          </p>
        </div>

        {site && (
          <div className="field">
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.6rem',
                color: 'var(--text)',
                fontWeight: 500,
              }}
            >
              <input
                type="checkbox"
                style={{ width: 20, height: 20, minHeight: 20, flex: '0 0 auto' }}
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              Site is active
            </label>
          </div>
        )}

        <button type="submit" className="primary block" disabled={busy}>
          {busy ? 'Saving…' : site ? 'Save changes' : 'Create job site'}
        </button>
      </form>
    </Modal>
  );
}
