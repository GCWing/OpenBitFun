// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import en from '@/locales/en-US/flow-chat.json';
import shared from '../../../../shared/i18n/resources/shared/en-US/terms.json';
import type { FlowToolItem } from '../types/flow-chat';
import { getToolItemCardConfig } from './toolCardMetadata';
import { OpenBitFunControlToolCard } from './OpenBitFunControlToolCard';

const translations = createInstance();
beforeAll(async () => {
  await translations.init({ lng: 'en-US', resources: { 'en-US': { 'flow-chat': en, shared } }, interpolation: { escapeValue: false } });
});

function render(action: string, result: unknown, status: FlowToolItem['status'] = 'completed') {
  const toolItem: FlowToolItem = {
    id: 'control-1', type: 'tool', toolName: 'OpenBitFunControl', status, timestamp: 0,
    toolCall: { id: 'call-1', input: { action, capability_id: 'peer.feature' } },
    toolResult: { result, success: true },
  };
  return renderToStaticMarkup(<I18nextProvider i18n={translations}>
    <OpenBitFunControlToolCard toolItem={toolItem} config={getToolItemCardConfig(toolItem)} />
  </I18nextProvider>);
}

describe('OpenBitFun control card content', () => {
  it('uses real shared card frameworks for discovery and control', () => {
    expect(render('list', { items: [] })).toContain('data-openbitfun-attention="ambient"');
    const html = render('configure', { configured: true, effectiveValue: false });
    expect(html).toContain('data-openbitfun-tool-card="openbitfun-control"');
    expect(html).toContain('data-openbitfun-attention="prominent"');
    expect(html).toContain('Change setting');
    expect(html).toContain('OpenBitFun');
    expect(html).toContain('lucide-sliders-horizontal');
    expect(html).not.toContain('data-openbitfun-part="extra"');
    expect(html).not.toContain('Tool: OpenBitFunControl');
  });

  it('does not render a success glyph for an unconfirmed result or pending approval', () => {
    for (const html of [render('open', { futureField: true }), render('open', undefined, 'pending_confirmation')]) {
      expect(html).not.toContain('data-openbitfun-part="statusLayer"');
      expect(html).not.toContain('>Opened<');
    }
    expect(render('get', { capability: { id: 'peer.feature' } })).not.toContain('data-openbitfun-part="extra"');
    expect(render('list', { items: [] })).not.toContain('data-openbitfun-part="extra"');
  });

  it('shows rejection and failed acknowledgements distinctly', () => {
    expect(render('execute', { executed: false }, 'rejected')).toContain('data-openbitfun-status="rejected"');
    const failed = render('execute', { executed: false });
    expect(failed).toContain('data-openbitfun-status="error"');
    expect(failed).not.toContain('>Executed<');
    expect(render('configure', { configured: true, presentationSync: { status: 'notAttached' } }))
      .not.toContain('data-openbitfun-part="extra"');
  });
});
