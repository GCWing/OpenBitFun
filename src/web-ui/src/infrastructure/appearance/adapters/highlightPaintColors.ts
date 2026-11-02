/** Materialize indirect color-mix tokens once, including scoped search colors. */
export function resolveHighlightColor(document: Document, color: string): string | undefined {
  const probe = document.createElement('span');
  probe.hidden = true;
  probe.style.setProperty('forced-color-adjust', 'none');
  probe.style.setProperty('color', color, 'important');
  if (!probe.style.color) return undefined;
  document.documentElement.append(probe);
  try {
    const resolved = document.defaultView?.getComputedStyle(probe).color;
    return resolved && !/color-mix\(|var\(|currentcolor/i.test(resolved) ? resolved : undefined;
  } finally {
    probe.remove();
  }
}

/** Resolve only at theme application, never while selecting or painting text. */
export function resolveHighlightPaintColors(document: Document, accent: string): {
  foreground?: string;
  background?: string;
} {
  const probe = document.createElement('span');
  probe.hidden = true;
  probe.style.setProperty('forced-color-adjust', 'none');
  probe.style.setProperty('color', accent, 'important');
  if (!probe.style.color) return {};
  document.documentElement.append(probe);
  try {
    const view = document.defaultView;
    const foreground = view?.getComputedStyle(probe).color;
    if (!foreground || /color-mix\(|var\(|currentcolor/i.test(foreground)) return {};
    const rgb = /^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/.exec(foreground);
    if (rgb) {
      // Mixing with transparent in sRGB preserves RGB and multiplies source alpha.
      const alpha = Number((Number(rgb[4] ?? 1) * 0.3).toFixed(6));
      return { foreground, background: `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})` };
    }
    // Let the browser handle supported wide-gamut/nested CSS color expressions.
    // Its computed color is concrete; do not carry an unresolved mix into paint.
    probe.style.removeProperty('color');
    probe.style.setProperty('color', `color-mix(in srgb, ${accent} 30%, transparent)`, 'important');
    if (!probe.style.color) return { foreground };
    const background = view?.getComputedStyle(probe).color;
    return {
      foreground,
      background: background && !/color-mix\(|var\(|currentcolor/i.test(background) ? background : undefined,
    };
  } finally {
    probe.remove();
  }
}
