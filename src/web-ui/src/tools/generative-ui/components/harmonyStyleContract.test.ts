import { describe, expect, it } from 'vitest';
import { HARMONY_STYLE_RESOURCE_CSS, HARMONY_STYLE_RESOURCE_IDS } from './vendor/harmonyStyles';
import { harmonyComponents } from './harmonyComponents';

describe('Harmony GenUI design resources', () => {
  it('keeps the reference Harmony tokens and component anatomy in one resource', () => {
    expect(HARMONY_STYLE_RESOURCE_IDS).toContain('openbitfun-harmony-components');
    expect(HARMONY_STYLE_RESOURCE_CSS).toContain('--hm-brand: #007dff');
    expect(HARMONY_STYLE_RESOURCE_CSS).toContain('--hm-radius-button: 999px');
    expect(HARMONY_STYLE_RESOURCE_CSS).toContain('--hm-track: 4px');
    expect(HARMONY_STYLE_RESOURCE_CSS).toContain('.card');
    expect(HARMONY_STYLE_RESOURCE_CSS).toContain('.list-item');
    expect(HARMONY_STYLE_RESOURCE_CSS).toContain('HMSymbolVF.ttf');
    expect(HARMONY_STYLE_RESOURCE_CSS).toContain('--color-background-secondary: var(--hm-panel-bg)');
    expect(HARMONY_STYLE_RESOURCE_CSS).toContain('data-hm-action="ink"');
    expect(HARMONY_STYLE_RESOURCE_CSS).toContain('[data-hm-theme="green"]');
    expect(HARMONY_STYLE_RESOURCE_CSS).toContain('input[type="range"]::-webkit-slider-runnable-track');
    for (const anatomy of ['.hero-ring', '.progress-bar', '.switch', '.chips', '.steps', '.list-item-icon', '.list-item-trailing', '.hm-records', '.hm-plan']) {
      expect(HARMONY_STYLE_RESOURCE_CSS).toContain(anatomy);
    }
  });

  it('uses Harmony renderers for symbols and interactive controls', () => {
    expect(harmonyComponents.Icon).toBeDefined();
    expect(harmonyComponents.Button?.render).toBeDefined();
    expect(harmonyComponents.IconButton?.render).toBeDefined();
    expect(harmonyComponents.Steps?.render).toBeDefined();
  });
});
