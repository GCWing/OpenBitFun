export const LIVING_LINE_SETTINGS_KEY = 'openbitfun.living-line.settings.v1';

export type LivingLineSettings = {
  lineColor: string;
  questionColor: string;
  errorColor: string;
  flowColor: string;
  lineWidth: number;
  flowLength: number;
  flowWidth: number;
  flowBlur: number;
  flowIntensity: number;
  lineGlowBlur: number;
  idlePeriodSeconds: number;
  workingPeriodSeconds: number;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
export const DEFAULT_SETTINGS: Readonly<LivingLineSettings> = {
  lineColor: '#9FE8FF', questionColor: '#FFD45A', errorColor: '#FF8D9A', flowColor: '#FFF8DC',
  lineWidth: 3.2, flowLength: 24, flowWidth: 2.4, flowBlur: 4, flowIntensity: 0.9,
  lineGlowBlur: 7, idlePeriodSeconds: 8, workingPeriodSeconds: 1.8,
};

export const RANGES: Record<keyof Omit<LivingLineSettings, 'lineColor' | 'questionColor' | 'errorColor' | 'flowColor'>, readonly [number, number]> = {
  lineWidth: [1, 8], flowLength: [6, 64], flowWidth: [0.8, 6], flowBlur: [0, 16],
  flowIntensity: [0, 1], lineGlowBlur: [0, 24], idlePeriodSeconds: [2, 24], workingPeriodSeconds: [0.5, 10],
};

export function validateSettings(value: unknown): LivingLineSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings must be an object');
  const input = value as Record<string, unknown>;
  const allowed = new Set([...Object.keys(DEFAULT_SETTINGS)]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('Settings contain an unknown field');
  const result = { ...DEFAULT_SETTINGS, ...input } as LivingLineSettings;
  for (const key of ['lineColor', 'questionColor', 'errorColor', 'flowColor'] as const) {
    if (typeof result[key] !== 'string' || !/^#[\da-f]{6}$/i.test(result[key])) throw new Error(`Invalid color: ${key}`);
  }
  for (const [key, [min, max]] of Object.entries(RANGES) as [keyof typeof RANGES, readonly [number, number]][]) {
    const number = result[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) throw new Error(`Value is out of range: ${key}`);
  }
  return result;
}

export function loadSettings(storage: StorageLike): { settings: LivingLineSettings; status: 'default' | 'loaded' | 'invalid' | 'unavailable' } {
  let raw: string | null;
  try { raw = storage.getItem(LIVING_LINE_SETTINGS_KEY); }
  catch { return { settings: { ...DEFAULT_SETTINGS }, status: 'unavailable' }; }
  if (!raw) return { settings: { ...DEFAULT_SETTINGS }, status: 'default' };
  try { return { settings: validateSettings(JSON.parse(raw)), status: 'loaded' }; }
  catch { return { settings: { ...DEFAULT_SETTINGS }, status: 'invalid' }; }
}

export function saveSettings(storage: StorageLike, value: unknown): boolean {
  try {
    const validated = validateSettings(value);
    storage.setItem(LIVING_LINE_SETTINGS_KEY, JSON.stringify(validated));
    return true;
  } catch {
    return false;
  }
}
