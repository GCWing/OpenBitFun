import type { FilterSpecification, StyleSpecification } from 'maplibre-gl';

export type MapLibreModule = typeof import('maplibre-gl');

/** Load MapLibre only when a Map component is actually mounted. */
export async function loadMapLibre(): Promise<MapLibreModule> {
  const module = await import('maplibre-gl');
  module.setWorkerUrl(new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).toString());
  return module;
}

export interface MapStyleColors {
  background: string;
  green: string;
  park: string;
  campus: string;
  water: string;
  waterway: string;
  building: string;
  street: string;
  road: string;
  ferry: string;
  label: string;
  minor: string;
  halo: string;
  route: string;
}

/** Resolve map paint values from the active Appearance package. MapLibre
 * receives concrete colors, while the product keeps the palette themeable. */
export function mapStyleColors(element: HTMLElement | null): MapStyleColors {
  const styles = getComputedStyle(element ?? document.documentElement);
  const read = (name: string) => styles.getPropertyValue(name).trim();
  return {
    background: read('--openbitfun-color-surface-canvas'),
    green: read('--openbitfun-color-status-success-surface'),
    park: read('--openbitfun-color-status-success-surface'),
    campus: read('--openbitfun-color-surface-panel'),
    water: read('--openbitfun-color-status-info-surface'),
    waterway: read('--openbitfun-color-status-info-surface'),
    building: read('--openbitfun-color-surface-panel'),
    street: read('--openbitfun-color-border-default'),
    road: read('--openbitfun-color-border-strong'),
    ferry: read('--openbitfun-color-status-info-content'),
    label: read('--openbitfun-color-content-primary'),
    minor: read('--openbitfun-color-content-secondary'),
    halo: read('--openbitfun-color-surface-canvas'),
    route: read('--openbitfun-color-status-info-content'),
  };
}

// MapLibre's filter tuple overloads only model a small fixed arity. These
// helpers keep the source-layer class lists readable while retaining the
// runtime filter shape accepted by the style specification.
const inClass = (...classes: string[]) => ['in', 'class', ...classes] as unknown as FilterSpecification;
const notInClass = (...classes: string[]) => ['!in', 'class', ...classes] as unknown as FilterSpecification;

/** OpenStreetMap-derived vector tiles with a restrained product style. */
export function vectorStyle(colors: MapStyleColors): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      places: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> · <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>',
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': colors.background } },
      { id: 'landcover', type: 'fill', source: 'places', 'source-layer': 'landcover', filter: inClass('wood', 'grass'), paint: { 'fill-color': colors.green, 'fill-opacity': 0.8 } },
      { id: 'parks', type: 'fill', source: 'places', 'source-layer': 'park', paint: { 'fill-color': colors.park } },
      { id: 'campus', type: 'fill', source: 'places', 'source-layer': 'landuse', filter: inClass('school', 'university', 'hospital'), paint: { 'fill-color': colors.campus } },
      { id: 'water', type: 'fill', source: 'places', 'source-layer': 'water', paint: { 'fill-color': colors.water } },
      { id: 'waterways', type: 'line', source: 'places', 'source-layer': 'waterway', paint: { 'line-color': colors.waterway, 'line-width': 1 } },
      { id: 'buildings', type: 'fill', minzoom: 14, source: 'places', 'source-layer': 'building', paint: { 'fill-color': colors.building } },
      { id: 'streets', type: 'line', source: 'places', 'source-layer': 'transportation', filter: notInClass('rail', 'transit', 'ferry', 'motorway', 'trunk', 'primary'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': colors.street, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.3, 12, 1.5, 14, 2.8, 17, 8] } },
      { id: 'main-roads', type: 'line', source: 'places', 'source-layer': 'transportation', filter: inClass('motorway', 'trunk', 'primary'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': colors.road, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.7, 12, 3, 14, 5, 17, 12] } },
      { id: 'ferries', type: 'line', source: 'places', 'source-layer': 'transportation', filter: ['==', 'class', 'ferry'], paint: { 'line-color': colors.ferry, 'line-width': 0.8 } },
      { id: 'neighborhood-labels', type: 'symbol', source: 'places', 'source-layer': 'place', minzoom: 10, maxzoom: 15, filter: inClass('suburb', 'quarter', 'neighbourhood'), layout: { 'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-letter-spacing': 0.08, 'text-transform': 'uppercase', 'text-max-width': 8 }, paint: { 'text-color': colors.minor, 'text-halo-color': colors.halo, 'text-halo-width': 1.2 } },
      { id: 'city-labels', type: 'symbol', source: 'places', 'source-layer': 'place', minzoom: 7, maxzoom: 13, filter: inClass('city', 'town'), layout: { 'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']], 'text-font': ['Noto Sans Regular'], 'text-size': 14, 'text-max-width': 8 }, paint: { 'text-color': colors.label, 'text-halo-color': colors.halo, 'text-halo-width': 1.5 } },
    ],
  };
}

/** Raster fallback keeps place markers usable when vector tiles fail. */
export function rasterStyle(dark: boolean): StyleSpecification {
  const service = dark ? 'Canvas/World_Dark_Gray_Base' : 'World_Street_Map';
  return {
    version: 8,
    sources: { streets: { type: 'raster', tiles: [`https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 19, attribution: 'Tiles © Esri · OpenStreetMap contributors' } },
    layers: [{ id: 'streets', type: 'raster', source: 'streets' }],
  };
}
