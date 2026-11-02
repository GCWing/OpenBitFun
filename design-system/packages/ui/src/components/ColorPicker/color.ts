/** sRGB content math for the picker; these colors are editable data, not UI chrome. */
export interface HslColor { hue: number; saturation: number; lightness: number }

export function isColorHex(value: string): boolean {
  return /^#[\da-f]{6}$/i.test(value);
}

export function hexToHsl(hex: string): HslColor {
  const channel = (start: number) => Number.parseInt(hex.slice(start, start + 2), 16) / 255;
  const r = channel(1), g = channel(3), b = channel(5);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  let hue = 0;
  if (delta) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
  }
  return {
    hue: (hue * 60 + 360) % 360,
    saturation: delta ? delta / (1 - Math.abs(2 * lightness - 1)) * 100 : 0,
    lightness: lightness * 100,
  };
}

export function hslToHex({ hue, saturation, lightness }: HslColor): string {
  const l = Math.max(0, Math.min(100, lightness)) / 100;
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const value = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * value).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`.toUpperCase();
}

export const colorPetals: readonly HslColor[] = [
  ...Array.from({ length: 12 }, (_, index) => ({ hue: (45 - index * 30 + 360) % 360, saturation: 68, lightness: 56 })),
  ...Array.from({ length: 6 }, (_, index) => ({ hue: (45 - index * 60 + 360) % 360, saturation: 48, lightness: 82 })),
  { hue: 0, saturation: 0, lightness: 100 },
];

export function lightnessFromPoint(x: number, y: number): number {
  const angle = Math.atan2(y - 140, x - 140) * 180 / Math.PI;
  return Math.round(Math.max(0, Math.min(100, (30 - angle) / 60 * 100)));
}

export function lightnessPoint(lightness: number): { x: number; y: number } {
  const angle = (30 - lightness * 0.6) * Math.PI / 180;
  return { x: 140 + 166 * Math.cos(angle), y: 140 + 166 * Math.sin(angle) };
}
