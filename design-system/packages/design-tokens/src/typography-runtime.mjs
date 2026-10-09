import { cssVariables, tokens } from "./index.js";

/** Canonical values for non-CSS renderers and server-side consumers. */
export function getTypographyTokenValue(name) {
  return String(tokens[name]);
}

function finiteNumber(name, value) {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`Typography token ${name} must resolve to a finite number.`);
  }
  return number;
}

function pixels(name, value) {
  if (!value.endsWith("px")) {
    throw new TypeError(`Typography token ${name} must resolve to pixels.`);
  }
  return finiteNumber(name, value);
}

export function getTypographyTokenPx(name) {
  return pixels(name, getTypographyTokenValue(name));
}

export function getTypographyTokenNumber(name) {
  return finiteNumber(name, getTypographyTokenValue(name));
}

/** Read at use time so scoped profiles and runtime preferences reach renderers. */
export function readActiveTypographyTokenValue(name, target) {
  const element = target ?? (typeof document !== "undefined" ? document.documentElement : null);
  const view = element?.ownerDocument.defaultView;
  if (view) {
    const value = view.getComputedStyle(element).getPropertyValue(cssVariables[name]).trim();
    if (value) return value;
  }
  return getTypographyTokenValue(name);
}

export function readActiveTypographyTokenPx(name, target) {
  return pixels(name, readActiveTypographyTokenValue(name, target));
}

export function readActiveTypographyTokenNumber(name, target) {
  return finiteNumber(name, readActiveTypographyTokenValue(name, target));
}

export const TYPOGRAPHY_BASE_MIN_PX = 12;
export const TYPOGRAPHY_BASE_MAX_PX = 20;

export const TYPOGRAPHY_SIZE_OFFSETS = Object.freeze({
  "4xs": -7,
  "3xs": -6,
  "2xs": -5,
  micro: -4,
  meta: -3,
  xs: -2,
  sm: -1,
  base: 0,
  lg: 1,
  xl: 2,
  "xl-plus": 3,
  "2xl": 4,
  "2xl-plus": 6,
  "3xl": 8,
  "3xl-plus": 10,
  "4xl": 12,
  "5xl": 18,
  "6xl": 26,
  "7xl": 34,
  "8xl": 42,
  "9xl": 50,
});

function normalizeBasePx(basePx) {
  if (!Number.isFinite(basePx)) {
    throw new TypeError("Typography base size must be a finite number.");
  }

  return Math.max(TYPOGRAPHY_BASE_MIN_PX, Math.min(TYPOGRAPHY_BASE_MAX_PX, basePx));
}

function formatPx(value) {
  return `${Number(value.toFixed(2))}px`;
}

/**
 * Creates the complete canonical font-size ladder for a user-selected base.
 * Runtime consumers override only the public `--openbitfun-font-size-*` primitives;
 * semantic `--openbitfun-type-*` roles keep following those primitives through CSS refs.
 */
export function createTypographySizeScale(basePx) {
  const normalizedBasePx = normalizeBasePx(basePx);

  return Object.freeze(Object.fromEntries(
    Object.entries(TYPOGRAPHY_SIZE_OFFSETS).map(([name, offset]) => [
      name,
      formatPx(Math.max(7, normalizedBasePx + offset)),
    ]),
  ));
}
