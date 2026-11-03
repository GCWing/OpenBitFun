/** @vitest-environment jsdom */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestI18nT } from '@/test/i18nTestUtils';
import examples from '../../../../shared/generative-ui/examples.json';
import type { GenUIAppDefinition } from '@/tools/generative-ui/genUITypes';
const pickerExample = examples.picker as GenUIAppDefinition;
import GenerativeWidgetPanel from './GenerativeWidgetPanel';

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: createTestI18nT('flow-chat') }),
}));

describe('GenerativeWidgetPanel', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => container.remove());

  it('mounts a generated host app directly instead of an iframe', () => {
    const root = createRoot(container);
    try {
      act(() => root.render(<GenerativeWidgetPanel app={pickerExample} />));
      expect(container.querySelector('iframe')).toBeNull();
      expect(container.querySelector('[data-gen-ui-app="equipment-picker"]')).not.toBeNull();
      expect(container.textContent).toContain('Equipment selection');
      expect(container.textContent).toContain('Camera');
      expect(container.querySelector('[data-openbitfun-state="interactive"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('shows a lightweight starting state before the first source fragment', () => {
    const root = createRoot(container);
    try {
      act(() => root.render(<GenerativeWidgetPanel />));
      expect(container.querySelector('[data-openbitfun-state="starting"]')).not.toBeNull();
      expect(container.querySelector('.openbitfun-generative-widget-panel__skeleton')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps the default OpenUI inline surface free of a panel toolbar', () => {
    const root = createRoot(container);
    try {
      act(() => root.render(<GenerativeWidgetPanel app={pickerExample} presentation="inline" />));
      expect(container.querySelector('.openbitfun-generative-widget-panel__toolbar')).toBeNull();
      expect(container.querySelector('.openbitfun-generative-widget-panel--inline')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
});
