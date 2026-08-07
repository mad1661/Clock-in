import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { IMAGERY, LABELS } from '../lib/basemap';

export interface MapPin {
  lat: number;
  lng: number;
  label: string;
  /** Draws the accuracy circle a GPS fix reported. */
  accuracy?: number | null;
  kind: 'in' | 'out';
}

interface Props {
  /** Centre of the job site, and the centre of the geofence circle. */
  site: { lat: number; lng: number } | null;
  radiusMeters?: number;
  /** Punch positions to plot. Empty for the site picker. */
  pins?: MapPin[];
  /** Supplying this makes the map interactive: drag or tap to move the site. */
  onMove?: (lat: number, lng: number) => void;
  height?: number;
}

/**
 * A job site on ESRI satellite imagery, with its geofence drawn to scale.
 *
 * Two jobs, deliberately in one component because they are the same picture:
 * picking where a site is, and seeing where a punch happened relative to it.
 * A radius is an abstract number until you see it drawn over the actual pad.
 *
 * Leaflet rather than the full ArcGIS SDK — 42 KB against several megabytes,
 * and this app is used on phones with one bar. The component is imported
 * lazily so the crew's clock screen never downloads any of it.
 */
export default function SiteMap({
  site,
  radiusMeters,
  pins = [],
  onMove,
  height = 260,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.LayerGroup | null>(null);
  // Held in a ref so moving the pin does not tear down and rebuild the map.
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  // --- Create once --------------------------------------------------------
  useEffect(() => {
    if (!boxRef.current || mapRef.current) return;

    const map = L.map(boxRef.current, {
      center: [site?.lat ?? 34.0122, site?.lng ?? -117.6889], // Chino, CA
      zoom: site ? 17 : 11,
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer(IMAGERY.url, {
      maxZoom: IMAGERY.maxZoom,
      attribution: IMAGERY.attribution,
    }).addTo(map);

    // Road and place names over the imagery; without them a bare aerial is
    // hard to orient in.
    L.tileLayer(LABELS.url, { maxZoom: LABELS.maxZoom, opacity: 0.9 }).addTo(map);

    layersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    if (onMoveRef.current) {
      map.on('click', (e: L.LeafletMouseEvent) => {
        onMoveRef.current?.(e.latlng.lat, e.latlng.lng);
      });
    }

    // The container is often still being laid out when the map is created,
    // which leaves Leaflet with the wrong size and a grey band down one side.
    const settle = window.setTimeout(() => map.invalidateSize(), 120);

    return () => {
      window.clearTimeout(settle);
      map.remove();
      mapRef.current = null;
      layersRef.current = null;
    };
  }, []);

  // --- Redraw on change ---------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    const layers = layersRef.current;
    if (!map || !layers) return;

    layers.clearLayers();

    if (site) {
      if (radiusMeters) {
        L.circle([site.lat, site.lng], {
          radius: radiusMeters,
          color: '#003593',
          weight: 2,
          fillColor: '#003593',
          fillOpacity: 0.12,
        }).addTo(layers);
      }

      // A div marker rather than Leaflet's default icon: the default loads a
      // PNG by relative path, which bundlers rewrite and break.
      L.marker([site.lat, site.lng], {
        draggable: Boolean(onMove),
        icon: L.divIcon({
          className: '',
          html:
            '<div style="width:20px;height:20px;border-radius:50%;background:#fec102;' +
            'border:3px solid #003593;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>',
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        }),
        keyboard: false,
      })
        .addTo(layers)
        .on('dragend', (e) => {
          const { lat, lng } = (e.target as L.Marker).getLatLng();
          onMoveRef.current?.(lat, lng);
        });
    }

    for (const pin of pins) {
      const colour = pin.kind === 'in' ? '#157347' : '#c62828';
      if (pin.accuracy && pin.accuracy > 0) {
        L.circle([pin.lat, pin.lng], {
          radius: pin.accuracy,
          color: colour,
          weight: 1,
          fillColor: colour,
          fillOpacity: 0.1,
          dashArray: '4 4',
        }).addTo(layers);
      }
      L.circleMarker([pin.lat, pin.lng], {
        radius: 7,
        color: '#fff',
        weight: 2,
        fillColor: colour,
        fillOpacity: 1,
      })
        .addTo(layers)
        .bindTooltip(pin.label, { direction: 'top' });
    }

    // Frame everything that matters rather than guessing a zoom.
    const points: L.LatLngExpression[] = [
      ...(site ? [[site.lat, site.lng] as L.LatLngExpression] : []),
      ...pins.map((p) => [p.lat, p.lng] as L.LatLngExpression),
    ];
    if (points.length > 1) {
      map.fitBounds(L.latLngBounds(points).pad(0.35), { maxZoom: 18 });
    } else if (site) {
      map.setView([site.lat, site.lng], Math.max(map.getZoom(), 16));
    }
  }, [site?.lat, site?.lng, radiusMeters, pins, onMove]);

  return (
    <div
      ref={boxRef}
      className="sitemap"
      style={{ height }}
      role="application"
      aria-label={onMove ? 'Map — tap or drag the pin to move the job site' : 'Map of the job site'}
    />
  );
}
