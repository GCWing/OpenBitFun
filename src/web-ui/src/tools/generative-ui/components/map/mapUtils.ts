import type { LngLatBoundsLike } from 'maplibre-gl';

export type LatLng = [number, number];

function numberValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function coordinate(value: unknown): LatLng | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { lat?: unknown; lng?: unknown; lon?: unknown; longitude?: unknown };
  const lat = numberValue(record.lat);
  const lng = numberValue(record.lng ?? record.lon ?? record.longitude);
  return lat !== null && lng !== null
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    ? [lat, lng]
    : null;
}

export const lngLat = ([lat, lng]: LatLng): [number, number] => [lng, lat];

export function boundsOf(points: LatLng[]): LngLatBoundsLike {
  const lats = points.map(point => point[0]);
  const lngs = points.map(point => point[1]);
  return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
}

export const reducedMotion = () => typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function partialLine(points: LatLng[], progress: number): LatLng[] {
  const lengths = points.slice(1).map((point, index) => Math.hypot(point[0] - points[index][0], point[1] - points[index][1]));
  let remaining = lengths.reduce((total, length) => total + length, 0) * Math.max(0, Math.min(1, progress));
  const output: LatLng[] = [points[0]];
  for (let index = 0; index < lengths.length; index += 1) {
    if (remaining >= lengths[index]) {
      output.push(points[index + 1]);
      remaining -= lengths[index];
      continue;
    }
    const ratio = lengths[index] ? remaining / lengths[index] : 0;
    output.push([
      points[index][0] + (points[index + 1][0] - points[index][0]) * ratio,
      points[index][1] + (points[index + 1][1] - points[index][1]) * ratio,
    ]);
    break;
  }
  return output;
}

function firstGrapheme(value: string): string {
  // Keep the utility usable in WebViews and jsdom, where Segmenter may be
  // absent, while preserving emoji modifiers and ZWJ sequences when it exists.
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const Segmenter = (Intl as typeof Intl & { Segmenter?: new (locales?: string | string[], options?: { granularity: 'grapheme' }) => { segment(input: string): Iterable<{ segment: string }> } }).Segmenter;
    const segment = Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)[Symbol.iterator]().next().value : undefined;
    if (segment?.segment) return segment.segment;
  }
  return [...value][0] ?? '';
}

export function pinEmoji(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const first = firstGrapheme(value.trim());
  return first && /\p{Extended_Pictographic}/u.test(first) ? first : null;
}

export function createPinElement(onSelect: () => void) {
  const element = document.createElement('div');
  element.className = 'gen-ui-oi-map-marker';
  element.tabIndex = 0;
  element.setAttribute('role', 'button');
  const content = document.createElement('div');
  content.className = 'gen-ui-oi-map-marker-content';
  const pin = document.createElement('span');
  pin.className = 'gen-ui-oi-map-pin';
  const label = document.createElement('span');
  label.className = 'gen-ui-oi-map-label';
  content.append(pin, label);
  element.append(content);
  element.addEventListener('click', onSelect);
  element.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  });
  return { element, pin, label };
}
