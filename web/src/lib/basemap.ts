/**
 * ESRI basemaps and geocoding.
 *
 * Satellite imagery rather than a road map, because a job site is a patch of
 * dirt that a street map draws as nothing. On imagery you can see the pad, the
 * stockpiles and the access road, which is what makes a geofence you draw by
 * eye actually correct.
 *
 * Two tiers:
 *  - No key: ESRI's public World Imagery tile service. Fine for getting going.
 *  - With a key: the ArcGIS location platform basemap styles, which is the
 *    supported route for production and has a free monthly allowance.
 *
 * Attribution is required either way and is baked into the map component.
 */

const ARCGIS_KEY = import.meta.env.VITE_ARCGIS_API_KEY as string | undefined;

export interface BasemapLayer {
  url: string;
  attribution: string;
  maxZoom: number;
}

export const IMAGERY: BasemapLayer = ARCGIS_KEY
  ? {
      url: `https://basemaps-api.arcgis.com/arcgis/rest/services/styles/ArcGIS:Imagery/static/{z}/{y}/{x}?type=style&token=${ARCGIS_KEY}`,
      attribution: 'Imagery &copy; Esri',
      maxZoom: 22,
    }
  : {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution:
        'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      maxZoom: 19,
    };

/** Street labels, drawn over the imagery so roads and site names stay readable. */
export const LABELS: BasemapLayer = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  attribution: '',
  maxZoom: 19,
};

export interface GeocodeHit {
  label: string;
  lat: number;
  lng: number;
}

/**
 * Address lookup through ESRI's World Geocoding Service.
 *
 * Uses the `findAddressCandidates` endpoint, which serves display-only results
 * without a token. Storing results — which is what a paid ArcGIS plan covers —
 * is not what we do here: the coordinates go into the job site the admin is
 * creating, chosen by them, not cached as a geocoding dataset.
 *
 * Failure is not an error state for the caller. The form always accepts typed
 * coordinates and "use my location", so a lookup that does not come back just
 * means one convenience is unavailable.
 */
export async function geocode(query: string, signal?: AbortSignal): Promise<GeocodeHit[]> {
  const url = new URL(
    'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates',
  );
  url.searchParams.set('f', 'json');
  url.searchParams.set('singleLine', query);
  url.searchParams.set('outFields', 'Match_addr');
  url.searchParams.set('maxLocations', '5');
  // Bias toward southern California so "Dock Street" finds the local one.
  url.searchParams.set('countryCode', 'USA');
  if (ARCGIS_KEY) url.searchParams.set('token', ARCGIS_KEY);

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('Address lookup is unavailable right now.');

  const data = (await res.json()) as {
    candidates?: { address?: string; location?: { x: number; y: number } }[];
    error?: { message?: string };
  };
  if (data.error) throw new Error(data.error.message ?? 'Address lookup failed.');

  return (data.candidates ?? [])
    .filter((c) => c.location && Number.isFinite(c.location.x) && Number.isFinite(c.location.y))
    .map((c) => ({
      label: c.address ?? query,
      lat: c.location!.y,
      lng: c.location!.x,
    }));
}
