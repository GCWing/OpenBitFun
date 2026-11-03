import 'maplibre-gl/dist/maplibre-gl.css';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MapLibreMap, Marker } from 'maplibre-gl';
import type { GenUIComponentProps } from '../../genUILibrary';
import type { GenUIAsyncExecuteOptions, GenUIAsyncRuntime } from '../../genUIAsyncCapabilities';
import { isAbortError } from '../../genUIAsyncCapabilities';
import { loadMapLibre, mapStyleColors, rasterStyle, vectorStyle, type MapLibreModule } from './basemap';
import { boundsOf, coordinate, createPinElement, lngLat, partialLine, pinEmoji, reducedMotion, type LatLng } from './mapUtils';

const ROUTE_SOURCE = 'genui-route';
const FRAME_PADDING = { top: 70, left: 72, bottom: 50, right: 72 };
const MAX_HEIGHT = 720;
const FLY_MS = 920;
const DRAW_MS = 760;

function canUseMapLibre(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return false;
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

type MapMarkerValue = { label: string; lat: number; lng: number; category?: string; icon?: string };
type Place = Omit<MapMarkerValue, 'icon'> & { key: string; order: number; icon: string | null };

function mapMarkers(value: unknown): MapMarkerValue[] {
  const items = Array.isArray(value)
    // OpenUI's @Each can produce one level of nested arrays. OI flattens
    // those before reconciling pins, otherwise generated maps silently lose
    // markers even though the source program parsed successfully.
    ? value.flat()
    : value && typeof value === 'object'
      ? (Array.isArray((value as Record<string, unknown>).features) ? (value as Record<string, unknown>).features as unknown[] : [value])
      : [];
  return items.flatMap(item => {
    if (item && typeof item === 'object' && (item as { partial?: unknown }).partial === true) return [];
    const raw = item && typeof item === 'object' && 'props' in item ? (item as { props?: unknown }).props : item;
    if (!raw || typeof raw !== 'object') return [];
    const marker = raw as Record<string, unknown>;
    const featureCenter = Array.isArray(marker.center) && marker.center.length >= 2
      ? coordinate({ lat: Number(marker.center[1]), lng: Number(marker.center[0]) })
      : null;
    const geometry = marker.geometry && typeof marker.geometry === 'object' ? marker.geometry as Record<string, unknown> : undefined;
    const geometryCenter = Array.isArray(geometry?.coordinates) && geometry.coordinates.length >= 2
      ? coordinate({ lat: Number(geometry.coordinates[1]), lng: Number(geometry.coordinates[0]) })
      : null;
    const properties = marker.properties && typeof marker.properties === 'object' ? marker.properties as Record<string, unknown> : undefined;
    const longitude = marker.lng ?? marker.lon ?? marker.longitude;
    const position = coordinate({ lat: marker.lat, lng: longitude }) ?? coordinate(marker) ?? featureCenter ?? geometryCenter;
    const label = typeof marker.label === 'string' ? marker.label : typeof marker.name === 'string' ? marker.name : typeof marker.display_name === 'string' ? marker.display_name : typeof properties?.label === 'string' ? properties.label : typeof properties?.name === 'string' ? properties.name : typeof properties?.display_name === 'string' ? properties.display_name : undefined;
    return label && position
      ? [{ label, lat: position[0], lng: position[1], category: typeof marker.category === 'string' ? marker.category : typeof properties?.category === 'string' ? properties.category : undefined, icon: typeof marker.icon === 'string' ? marker.icon : undefined }]
      : [];
  });
}

function placesOf(value: unknown): Place[] {
  const seen = new Map<string, number>();
  return mapMarkers(value).map((marker, order) => {
    const count = seen.get(marker.label) ?? 0;
    seen.set(marker.label, count + 1);
    return { ...marker, key: count ? `${marker.label} (${count + 1})` : marker.label, icon: pinEmoji(marker.icon), order };
  });
}

function routePoints(value: unknown): LatLng[] {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const route = Array.isArray(record?.routes) ? record.routes[0] : record?.route ?? record;
  const routeRecord = route && typeof route === 'object' && !Array.isArray(route) ? route as Record<string, unknown> : undefined;
  const feature = routeRecord?.type === 'Feature' && routeRecord.geometry && typeof routeRecord.geometry === 'object'
    ? routeRecord.geometry as Record<string, unknown>
    : undefined;
  const featureCollection = routeRecord?.type === 'FeatureCollection' && Array.isArray(routeRecord.features)
    ? routeRecord.features.find(item => item && typeof item === 'object' && (item as Record<string, unknown>).geometry && typeof (item as Record<string, unknown>).geometry === 'object') as Record<string, unknown> | undefined
    : undefined;
  const collectionGeometry = featureCollection?.geometry && typeof featureCollection.geometry === 'object'
    ? featureCollection.geometry as Record<string, unknown>
    : undefined;
  const geometry = routeRecord?.geometry && typeof routeRecord.geometry === 'object' ? routeRecord.geometry as Record<string, unknown> : undefined;
  const resolvedGeometry = geometry ?? feature ?? collectionGeometry;
  const raw = resolvedGeometry?.coordinates ?? record?.points ?? routeRecord?.points ?? routeRecord?.coordinates ?? route ?? value;
  if (!Array.isArray(raw)) return [];
  const isGeoJson = Boolean(resolvedGeometry?.coordinates);
  return raw.flatMap<LatLng>(point => {
    if (Array.isArray(point) && point.length >= 2) {
      const parsed = isGeoJson
        ? coordinate({ lat: Number(point[1]), lng: Number(point[0]) })
        : coordinate({ lat: Number(point[0]), lng: Number(point[1]) });
      return parsed ? [parsed] : [];
    }
    const parsed = coordinate(point);
    return parsed ? [parsed] : [];
  });
}

function setRouteLine(map: MapLibreMap, points: LatLng[]) {
  const source = map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined;
  source?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points.map(lngLat) } });
}

function RecenterIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m4.5 4.5 15 5a1 1 0 0 1 0 1.9l-6.1 2-2 6.1a1 1 0 0 1-1.9 0l-5-15z" /></svg>;
}

function InfoIcon() {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z" /><path d="M10 9v5M10 6.3v.1" /></svg>;
}

function ExpandIcon() {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 4h4v4M8 16H4v-4M16 12v4h-4M4 8V4h4" /></svg>;
}

function ChevronIcon() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>;
}

function useRemoteMapMarkers(query: string, initial: MapMarkerValue[], asyncRuntime?: GenUIAsyncRuntime) {
  const [state, setState] = useState<{ query: string; markers: MapMarkerValue[]; loading: boolean; error?: string }>({ query: '', markers: initial, loading: false });
  const initialKey = JSON.stringify(initial);
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    const runtime = asyncRuntime;
    const capability = runtime?.can('map.lookup') ? 'map.lookup' : runtime?.can('Map') ? 'Map' : undefined;
    const currentInitial = initialRef.current;
    if (!query.trim() || currentInitial.length || !runtime || !capability) {
      setState(previous => {
        const error = query.trim() && !currentInitial.length && !capability ? 'Map lookup is unavailable on this host' : undefined;
        if (previous.query === query && previous.loading === false && previous.error === error && JSON.stringify(previous.markers) === JSON.stringify(currentInitial)) return previous;
        return { query, markers: currentInitial, loading: false, error };
      });
      return undefined;
    }
    const controller = new AbortController();
    setState({ query, markers: [], loading: true });
    const timer = window.setTimeout(() => {
      void runtime.execute(capability, { query }, { kind: 'map-query', signal: controller.signal }).then(result => {
        if (controller.signal.aborted) return;
        const record = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
        const raw = record?.markers ?? record?.places ?? record?.results ?? record?.features ?? result;
        setState({ query, markers: mapMarkers(raw), loading: false });
      }).catch(error => {
        if (!controller.signal.aborted && !isAbortError(error)) setState({ query, markers: [], loading: false, error: error instanceof Error ? error.message : String(error) });
      });
    }, 500);
    return () => { controller.abort('Map lookup was replaced'); window.clearTimeout(timer); };
  }, [asyncRuntime, initialKey, query]);
  return state.query === query ? state : { query, markers: initial, loading: false };
}

function useRemoteMapRoute(markers: Array<Pick<MapMarkerValue, 'lat' | 'lng'>>, enabled: boolean, asyncRuntime?: GenUIAsyncRuntime) {
  const [state, setState] = useState<{ key: string; points: LatLng[]; loading: boolean; error?: string }>({ key: '', points: [], loading: false });
  // Keep route data scoped to this mounted source. A global cache could reuse
  // a peer/workspace provider result for another owner or target.
  const routeCacheRef = useRef(new Map<string, LatLng[]>());
  const key = JSON.stringify(markers.map(marker => [marker.lat, marker.lng]));
  const markerCount = markers.length;
  const markersRef = useRef(markers);
  markersRef.current = markers;
  useEffect(() => {
    const runtime = asyncRuntime;
    const capability = runtime?.can('map.route') ? 'map.route' : undefined;
    if (!enabled || markerCount < 2 || !runtime || !capability) {
      setState(previous => previous.key === key && previous.points.length === 0 && !previous.loading && !previous.error
        ? previous
        : { key, points: [], loading: false });
      return undefined;
    }
    const cached = routeCacheRef.current.get(key);
    if (cached) {
      setState({ key, points: cached, loading: false });
      return undefined;
    }
    const controller = new AbortController();
    setState({ key, points: [], loading: true });
    const timer = window.setTimeout(() => {
      const options: GenUIAsyncExecuteOptions = { kind: 'map-query', signal: controller.signal };
      void runtime.execute(capability, { markers: markersRef.current }, options).then(result => {
        if (!controller.signal.aborted) {
          const points = routePoints(result);
          if (points.length > 1) {
            if (routeCacheRef.current.size >= 64) routeCacheRef.current.delete(routeCacheRef.current.keys().next().value!);
            routeCacheRef.current.set(key, points);
          }
          setState({ key, points, loading: false });
        }
      }).catch(error => {
        if (!controller.signal.aborted && !isAbortError(error)) setState({ key, points: [], loading: false, error: error instanceof Error ? error.message : String(error) });
      });
    }, 700);
    return () => { controller.abort('Map route was replaced'); window.clearTimeout(timer); };
  }, [asyncRuntime, enabled, key, markerCount]);
  return state.key === key ? state : { key, points: [], loading: false };
}

function MapFallback({ places, selected, route, routePoints: routePath, onSelect }: { places: Place[]; selected: string; route: boolean; routePoints: LatLng[]; onSelect: (place: Place) => void }) {
  const bounds = places.reduce((result, marker) => ({ minLat: Math.min(result.minLat, marker.lat), maxLat: Math.max(result.maxLat, marker.lat), minLng: Math.min(result.minLng, marker.lng), maxLng: Math.max(result.maxLng, marker.lng) }), { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity });
  const minLat = Number.isFinite(bounds.minLat) ? bounds.minLat : -90;
  const maxLat = Number.isFinite(bounds.maxLat) ? bounds.maxLat : 90;
  const minLng = Number.isFinite(bounds.minLng) ? bounds.minLng : -180;
  const maxLng = Number.isFinite(bounds.maxLng) ? bounds.maxLng : 180;
  const latSpan = Math.max(1, maxLat - minLat);
  const lngSpan = Math.max(1, maxLng - minLng);
  const project = (point: LatLng) => ({ x: Math.max(7, Math.min(93, 7 + (point[1] - minLng) / lngSpan * 86)), y: Math.max(7, Math.min(63, 7 + (maxLat - point[0]) / latSpan * 56)) });
  const points = places.map(marker => ({ ...marker, ...project([marker.lat, marker.lng]) }));
  const path = (routePath.length > 1 ? routePath : places.map(marker => [marker.lat, marker.lng] as LatLng)).map(project).map(point => `${point.x},${point.y}`).join(' ');
  return <svg className="gen-ui-oi-map-fallback" viewBox="0 0 100 70" role="img" aria-label="Map"><path className="gen-ui-oi-map-land" d="M2 18 18 6 36 12 54 4 74 15 96 8 98 35 82 45 90 62 67 66 48 56 29 68 14 51 3 45Z" />{route && path && places.length > 1 ? <polyline className="gen-ui-oi-map-route" points={path} /> : null}{points.map(marker => <g key={marker.key} transform={`translate(${marker.x} ${marker.y})`} role="button" tabIndex={0} aria-label={marker.label} aria-pressed={selected === marker.label} onClick={() => onSelect(marker)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(marker); } }}><circle className={selected === marker.label ? 'is-selected' : ''} r={selected === marker.label ? 3 : 2.2} /><text x="3" y="1" className="gen-ui-oi-map-fallback-label">{marker.icon || marker.label}</text></g>)}</svg>;
}

export default function MapView({ view, emit, asyncRuntime, isStreaming }: Pick<GenUIComponentProps, 'view' | 'emit' | 'asyncRuntime' | 'isStreaming'>) {
  const initialMarkers = mapMarkers(view.props.markers);
  const remote = useRemoteMapMarkers(String(view.props.query ?? ''), initialMarkers, asyncRuntime);
  const places = useMemo(() => placesOf(remote.markers), [remote.markers]);
  const selected = typeof view.props.selected === 'string' ? view.props.selected : '';
  const [lib, setLib] = useState<MapLibreModule | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [group, setGroup] = useState('all');
  const [infoOpen, setInfoOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef(new Map<string, { marker: Marker; element: HTMLDivElement; pin: HTMLSpanElement; label: HTMLSpanElement }>());
  const fitPointsRef = useRef<LatLng[]>([]);
  const routePointsRef = useRef<LatLng[]>([]);
  const selectRef = useRef<(place: Place) => void>(() => undefined);
  const userMovedRef = useRef(false);
  const anchoredRef = useRef(false);
  const styledDarkRef = useRef(false);
  const dark = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const maxHeight = Math.min(MAX_HEIGHT, Math.max(200, typeof view.props.height === 'number' ? view.props.height : 400));
  // Match Open Intelligent UI's compact phone behavior while retaining a
  // caller-controlled desktop cap.
  const height = `min(${maxHeight}px, max(280px, 82vw))`;
  const categories = Array.from(new Set(places.map(place => place.category).filter((value): value is string => Boolean(value))));
  const visible = places.filter(place => group === 'all' || place.category === group);
  const route = useRemoteMapRoute(visible, view.props.route === true, asyncRuntime);
  const placeSignature = JSON.stringify(visible.map(place => [place.key, place.lat, place.lng, place.icon, place.category, place.order]));
  const routeKey = JSON.stringify(visible.map(place => [place.lat, place.lng]));
  const fitSignatureRef = useRef('');
  const [framedKey, setFramedKey] = useState('');
  const lineDrawnRef = useRef(false);

  useEffect(() => {
    // OpenUI keeps the component instance mounted while source fragments
    // arrive. Load MapLibre once up front; marker reconciliation is cheap and
    // camera/routing effects below remain explicitly gated by isStreaming.
    if (lib) return undefined;
    if (!canUseMapLibre()) {
      setMapError(true);
      return undefined;
    }
    let active = true;
    void loadMapLibre().then(module => { if (active) setLib(module); }).catch(() => setMapError(true));
    return () => { active = false; };
  }, [lib]);

  useEffect(() => {
    if (!lib || !surfaceRef.current || !canUseMapLibre()) return undefined;
    const mapColors = mapStyleColors(surfaceRef.current);
    const instance = new lib.Map({
      container: surfaceRef.current,
      style: vectorStyle(mapColors),
      center: [0, 20],
      zoom: 1,
      minZoom: 0,
      scrollZoom: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: false,
      cooperativeGestures: typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches,
    });
    instance.touchZoomRotate.disableRotation();
    instance.addControl(new lib.AttributionControl({ compact: false }), 'bottom-left');
    instance.addControl(new lib.NavigationControl({ showCompass: false }), 'bottom-right');
    let fellBack = false;
    instance.on('style.load', () => {
      if (!instance.getSource(ROUTE_SOURCE)) instance.addSource(ROUTE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      if (!instance.getLayer(ROUTE_SOURCE)) instance.addLayer({ id: ROUTE_SOURCE, type: 'line', source: ROUTE_SOURCE, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': mapStyleColors(surfaceRef.current).route, 'line-width': 3.2 } });
      // A style reload removes custom sources and layers. Open Intelligent UI
      // restores the current route as soon as the new style is ready; keep
      // the same behavior for theme changes and raster fallback so exploring
      // the map never makes an already loaded route disappear.
      setRouteLine(instance, routePointsRef.current);
      setMapReady(true);
    });
    instance.on('error', event => {
      if (fellBack) { setMapError(true); return; }
      const source = (event as { sourceId?: string }).sourceId;
      if (source && source !== 'places') return;
      fellBack = true;
      instance.setStyle(rasterStyle(darkRef.current));
    });
    instance.on('sourcedata', event => {
      if (fellBack && event.isSourceLoaded) setMapError(false);
    });
    instance.on('dragstart', () => { userMovedRef.current = true; });
    mapRef.current = instance;
    const entries = markersRef.current;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => instance.resize());
    observer?.observe(surfaceRef.current);
    return () => {
      observer?.disconnect();
      entries.forEach(entry => entry.marker.remove());
      entries.clear();
      instance.remove();
      mapRef.current = null;
      fitSignatureRef.current = '';
      lineDrawnRef.current = false;
      setMapReady(false);
    };
  }, [lib]);

  useEffect(() => {
    if (!mapRef.current || styledDarkRef.current === dark) return;
    styledDarkRef.current = dark;
    mapRef.current.setStyle(vectorStyle(mapStyleColors(surfaceRef.current)), { diff: false });
  }, [dark]);

  useEffect(() => {
    if (!expanded) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    containerRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [expanded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!lib || !mapReady || !map) return;
    const keys = new Set(visible.map(place => place.key));
    for (const [key, entry] of markersRef.current) {
      if (!keys.has(key)) { entry.marker.remove(); markersRef.current.delete(key); }
    }
    visible.forEach(place => {
      let entry = markersRef.current.get(place.key);
      if (!entry) {
        const pinElement = createPinElement(() => selectRef.current(place));
        const marker = new lib.Marker({ element: pinElement.element, anchor: 'top', offset: [0, -17] }).setLngLat(lngLat([place.lat, place.lng])).addTo(map);
        entry = { marker, ...pinElement };
        markersRef.current.set(place.key, entry);
      }
      entry.marker.setLngLat(lngLat([place.lat, place.lng]));
      entry.element.title = place.label;
      entry.element.style.zIndex = selected === place.label ? '2' : '';
      entry.element.setAttribute('aria-label', place.label);
      entry.element.setAttribute('aria-pressed', String(selected === place.label));
      entry.pin.classList.toggle('is-selected', selected === place.label);
      entry.pin.classList.toggle('is-numbered', !place.icon);
      entry.pin.textContent = place.icon ?? String(place.order + 1);
      entry.label.textContent = place.label;
    });
    fitPointsRef.current = visible.map(place => [place.lat, place.lng]);
    if (fitPointsRef.current.length && !userMovedRef.current && !anchoredRef.current) {
      anchoredRef.current = true;
      map.jumpTo({ center: lngLat(fitPointsRef.current[0]), zoom: 10.5 });
    }
    // `placeSignature` is the stable primitive snapshot, not the OpenUI node identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib, mapReady, placeSignature, selected]);

  useEffect(() => {
    const map = mapRef.current;
    if (isStreaming || !mapReady || !map || !visible.length) return;
    const points = fitPointsRef.current;
    const nextFit = JSON.stringify([group, routeKey]);
    if (fitSignatureRef.current === nextFit) return;
    fitSignatureRef.current = nextFit;
    lineDrawnRef.current = false;
    setRouteLine(map, []);
    routePointsRef.current = [];
    if (userMovedRef.current || reducedMotion()) {
      map.fitBounds(boundsOf(points), { padding: FRAME_PADDING, maxZoom: 13, animate: false });
      setFramedKey(routeKey);
      return;
    }
    map.fitBounds(boundsOf(points), { padding: FRAME_PADDING, maxZoom: 13, duration: FLY_MS, linear: false });
    const timer = window.setTimeout(() => setFramedKey(routeKey), FLY_MS + 40);
    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, mapReady, routeKey, group]);

  useEffect(() => {
    const map = mapRef.current;
    if (isStreaming || !mapReady || !map || framedKey !== routeKey) return;
    const positions = view.props.route === true ? (route.points.length > 1 ? route.points : fitPointsRef.current) : [];
    routePointsRef.current = positions;
    if (positions.length < 2 || lineDrawnRef.current || reducedMotion()) {
      setRouteLine(map, positions.length > 1 ? positions : []);
      lineDrawnRef.current = positions.length > 1;
      return undefined;
    }
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let frame = 0;
    const draw = (now: number) => {
      const progress = Math.min(1, (now - started) / DRAW_MS);
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
      setRouteLine(map, partialLine(positions, eased));
      if (progress < 1) frame = requestAnimationFrame(draw);
      else lineDrawnRef.current = true;
    };
    frame = requestAnimationFrame(draw);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      setRouteLine(map, routePointsRef.current);
    };
  }, [framedKey, isStreaming, mapReady, route.points, routeKey, view.props.route]);

  function select(place: Place) {
    emit('change', place.label);
    asyncRuntime?.emit('map.marker.select', { label: place.label, lat: place.lat, lng: place.lng });
    if (expanded) setExpanded(false);
  }
  selectRef.current = select;

  const routeStatus = !view.props.route ? '' : route.loading ? 'Street route loading.' : route.points.length > 1 ? 'Street route loaded.' : 'Street routing unavailable. Showing direct connections.';
  const routeNote = route.points.length > 1
    ? 'The line follows streets through the authorized map provider.'
    : 'The line joins places in order while street routing is unavailable.';
  const routePath = route.points.length > 1 ? route.points : visible.map(place => [place.lat, place.lng] as LatLng);
  return <figure className={`gen-ui-oi-map${expanded ? ' is-expanded' : ''}`} data-openbitfun-component="gen-ui-components" data-openbitfun-part="map" data-gen-ui-loading={remote.loading || route.loading || undefined} data-gen-ui-error={remote.error || undefined} data-gen-ui-route-degraded={route.error || undefined} style={{ height }}>
    <div ref={containerRef} className="gen-ui-oi-map-container" role={expanded ? 'dialog' : 'region'} aria-modal={expanded || undefined} aria-label={String(view.props.label || 'Map')} tabIndex={expanded ? -1 : undefined}>
      <div ref={surfaceRef} className="gen-ui-oi-map-surface" />
      {/* Keep the MapLibre surface mounted while its style/tiles are loading.
       * Open Intelligent UI does not swap in a second renderer for the
       * normal loading path; doing that here made the generated map flash an
       * SVG overview and then replace it as soon as WebGL became ready. The
       * compact SVG remains an explicit degraded path for hosts without
       * WebGL or when the tile provider has failed. */}
      {mapError && <MapFallback places={visible} selected={selected} route={view.props.route === true} routePoints={routePath} onSelect={select} />}
      <div className="gen-ui-oi-map-controls">
        {categories.length > 1 && <label className="gen-ui-oi-map-pill"><select aria-label="Filter places" value={group} onChange={event => setGroup(event.target.value)}><option value="all">All places</option>{categories.map(category => <option key={category} value={category}>{category}</option>)}</select><ChevronIcon /></label>}
        <button type="button" className="gen-ui-oi-map-pill gen-ui-oi-map-recenter" aria-label="Show every place" onClick={() => { if (fitPointsRef.current.length) mapRef.current?.fitBounds(boundsOf(fitPointsRef.current), { padding: FRAME_PADDING, maxZoom: 14 }); }}><RecenterIcon /></button>
        <button type="button" className="gen-ui-oi-map-info" aria-label="About this map" aria-expanded={infoOpen} onClick={() => setInfoOpen(value => !value)}><InfoIcon /></button>
      </div>
      <button type="button" className="gen-ui-oi-map-pill gen-ui-oi-map-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Collapse' : 'Expand'}<ExpandIcon /></button>
      {infoOpen ? <div className="gen-ui-oi-map-note" role="note">Drag to explore, use + and − to zoom, and select a place to highlight it. {view.props.route === true ? routeNote : ''}</div> : null}
      {remote.error || route.error ? <div className="gen-ui-oi-map-note" role="status">{remote.error || 'Street routing unavailable. Showing direct connections.'}</div> : null}
      {routeStatus ? <span className="gen-ui-oi-map-status" role="status">{routeStatus}</span> : null}
      {mapError ? <div className="gen-ui-oi-map-note gen-ui-oi-map-note--bottom" role="status">Map tiles are temporarily unavailable. The places are still shown.</div> : null}
    </div>
    {view.props.label ? <figcaption>{String(view.props.label)}</figcaption> : null}
  </figure>;
}
