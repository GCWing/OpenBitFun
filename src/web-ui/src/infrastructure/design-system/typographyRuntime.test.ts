// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  getTypographyTokenNumber,
  getTypographyTokenPx,
  getTypographyTokenValue,
  readActiveTypographyTokenValue,
  readActiveTypographyTokenPx,
} from './typographyRuntime';
import { resolveEditorFontFamily } from '@/tools/editor/config/defaults';
import { readTerminalOutputTypography } from '@openbitfun/flow-chat-presentation/terminal/model';

describe('typography runtime adapter', () => {
  it('translates canonical design tokens for numeric renderer APIs', () => {
    expect(getTypographyTokenPx('font.size.base')).toBe(14);
    expect(getTypographyTokenNumber('font.weight.semibold')).toBe(600);
    expect(getTypographyTokenNumber('lineHeight.reading')).toBe(1.58);
    expect(getTypographyTokenValue('font.family.mono')).toContain('monospace');
  });

  it('reads active root font-size overrides before falling back to the canonical value', () => {
    document.documentElement.style.setProperty('--openbitfun-font-size-base', '17px');
    expect(readActiveTypographyTokenPx('font.size.base')).toBe(17);
    document.documentElement.style.removeProperty('--openbitfun-font-size-base');
  });

  it('resolves code fonts at use time and preserves explicit editor choices', () => {
    const style = document.documentElement.style;
    const property = '--openbitfun-font-family-mono';
    try {
      style.setProperty(property, '"Active Code", monospace');
      expect(readActiveTypographyTokenValue('font.family.mono')).toBe('"Active Code", monospace');
      expect(resolveEditorFontFamily('')).toBe('"Active Code", monospace');
      expect(resolveEditorFontFamily('User Mono')).toBe('User Mono');
      style.setProperty(property, '"Next Code", monospace');
      expect(readTerminalOutputTypography().fontFamily).toBe('"Next Code", monospace');
    } finally {
      style.removeProperty(property);
    }
  });

  it('reads scoped code metrics for renderer APIs', () => {
    const scope = document.createElement('div');
    scope.style.setProperty('--openbitfun-font-family-mono', '"Scoped Code", monospace');
    scope.style.setProperty('--openbitfun-type-code-output-font-size', '17px');
    scope.style.setProperty('--openbitfun-type-code-output-line-height', '1.6');
    document.body.append(scope);
    try {
      expect(readTerminalOutputTypography(scope)).toMatchObject({
        fontFamily: '"Scoped Code", monospace', fontSize: 17, lineHeight: 1.6,
      });
    } finally {
      scope.remove();
    }
  });
});
