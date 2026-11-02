import type { CSSProperties } from 'react';
import { buildSharedPrismStyle } from '@/shared/prism/prismTheme';

export function buildMarkdownPrismStyle(isLight: boolean): Record<string, CSSProperties> {
  // The code body owns the complete public type.flow.code role. Prism and the
  // streaming fallback inherit the same code typography.
  const typography: CSSProperties = {
    fontFamily: 'inherit',
    fontSize: 'inherit',
    fontWeight: 'inherit',
    lineHeight: 'inherit',
    letterSpacing: 'inherit',
  };

  return buildSharedPrismStyle(isLight, {
    pre: {
      margin: 0,
      ...typography,
    },
    code: typography,
  });
}
