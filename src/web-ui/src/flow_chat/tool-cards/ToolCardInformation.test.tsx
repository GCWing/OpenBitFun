// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import en from '@/locales/en-US/flow-chat.json';
import type { FlowToolItem, ToolCardProps } from '../types/flow-chat';
import { getToolItemCardConfig } from './toolCardMetadata';
import { ComputerUseToolCard } from './ComputerUseToolCard';
import { PagePublishDisplay } from './PagePublishToolDisplay';
import { SessionControlToolCard } from './SessionControlToolCard';
import { SessionMessageToolCard } from './SessionMessageToolCard';
import { GrepSearchDisplay } from './GrepSearchDisplay';
import { GlobSearchDisplay } from './GlobSearchDisplay';
import { LSDisplay } from './LSDisplay';
import { ReadFileDisplay } from './ReadFileDisplay';
import { ContextCompressionDisplay } from './ContextCompressionDisplay';
import { getToolCapsuleSummary } from './toolCapsuleModel';

const translations = createInstance();
beforeAll(async () => {
  await translations.init({ lng: 'en-US', resources: { 'en-US': { 'flow-chat': en } },
    interpolation: { escapeValue: false } });
});

function item(toolName: string, input: Record<string, unknown>, result: unknown = {}): FlowToolItem {
  return { id: 'information', type: 'tool', toolName, timestamp: 0, status: 'completed',
    toolCall: { id: 'information', input }, toolResult: { success: true, result } };
}

function render(Component: React.ComponentType<ToolCardProps>, toolItem: FlowToolItem) {
  return renderToStaticMarkup(<I18nextProvider i18n={translations}>
    <Component toolItem={toolItem} config={getToolItemCardConfig(toolItem)} />
  </I18nextProvider>);
}

describe('collapsed tool information', () => {
  it('keeps the computer action, target and application without generic success prose', () => {
    const call = item('ComputerUse', { action: 'type_text', text: 'Release notes' },
      JSON.stringify({ computer_use_context: { foreground_application: { name: 'Editor' } } }));
    const html = render(ComputerUseToolCard, call);
    expect(html).toContain('Type text');
    expect(html).toContain('Release notes · Editor');
    expect(html).not.toContain('Action completed');
    expect(html).not.toContain('Controlling');
  });

  it.each(['cancelled', 'rejected', 'error'] as const)('preserves the computer target when %s', status => {
    const call = { ...item('ComputerUse', { action: 'open_url', url: 'https://example.com' }), status };
    const html = render(ComputerUseToolCard, call);
    expect(html).toContain('https://example.com');
    expect(html).toContain(`data-openbitfun-status="${status}"`);
    expect(html).not.toContain('Action completed');
    expect(html).not.toContain('Controlling');
  });

  it('distinguishes a generated preview from a live page and tolerates older payloads', () => {
    const preview = render(PagePublishDisplay, item('PagePublish', { slug: 'release' }, { deployed: false, version_id: 'v2' }));
    expect(preview).toContain('Create page preview');
    expect(preview).toContain('release @ v2');
    expect(preview).not.toContain('Page is live');
    const deployed = render(PagePublishDisplay, item('PagePublish', { slug: 'release' }, { deployed: true, version_id: 'v2' }));
    expect(deployed).toContain('Page is live');
    const legacy = render(PagePublishDisplay, item('PagePublish', { slug: 'release' }));
    expect(legacy).not.toContain('Page is live');
    expect(legacy).not.toContain('Create page preview');
  });

  it.each([
    ['LS', LSDisplay, { path: '/work' }, { entries: [] }, '0 entries'],
    ['Grep', GrepSearchDisplay, { pattern: 'needle' }, { total_matches: 0, file_count: 0 }, '0 matches'],
    ['Glob', GlobSearchDisplay, { pattern: '*.ts' }, { files: [] }, '0 files'],
  ] as const)('does not invent an empty result count for unknown %s payloads', (name, Component, input, emptyResult, emptyLabel) => {
    expect(render(Component, item(name, input, { future_payload: true }))).not.toContain(emptyLabel);
    expect(render(Component, item(name, input, emptyResult))).toContain(emptyLabel);
  });

  it('keeps a cancelled read filename visible without treating cancellation as success', () => {
    const call = item('Read', { file_path: '/work/report.md', offset: 10, limit: 20 });
    call.status = 'cancelled';
    call.toolResult = { success: false, error: 'Access denied' };
    const html = render(ReadFileDisplay, call);
    expect(html).toContain('data-openbitfun-status="cancelled"');
    expect(html).toContain('report.md');
    expect(html).toContain('aria-label="Cancelled');
    expect(html).not.toContain('report.md · Cancelled');
  });

  it('does not treat a completed computer tool failure as a completed action', () => {
    const call = item('ComputerUse', { action: 'open_url', url: 'https://example.com' });
    call.toolResult = { success: false, error: 'Access denied' };
    const html = render(ComputerUseToolCard, call);
    expect(html).toContain('data-openbitfun-status="error"');
    expect(html).toContain('https://example.com');
    expect(html).toContain('aria-label="Access denied. Expand details"');
    expect(html).not.toContain('https://example.com · Access denied');
    expect(html).not.toContain('Action completed');
  });

  it.each([SessionControlToolCard, SessionMessageToolCard])('honors nested session failures after transport completion', Component => {
    const call = item('SessionControl', { action: 'create', session_name: 'Release review', session_id: 'target' }, { success: false });
    const html = render(Component, call);
    expect(html).toContain('data-openbitfun-status="error"');
    expect(html).toContain('Release review');
    expect(html).not.toContain('Created session');
    expect(html).not.toContain('Message accepted');
  });

  it('does not turn cancelled compression into a completed token reduction', () => {
    const call = { ...item('ContextCompression', {}, { tokens_before: 12000, tokens_after: 3000 }), status: 'cancelled' as const };
    const html = renderToStaticMarkup(<I18nextProvider i18n={translations}>
      <ContextCompressionDisplay toolItem={call} />
    </I18nextProvider>);
    expect(html).toContain('Cancelled');
    expect(html).not.toContain('→');
  });

  it('keeps an unknown agent wait result distinct from zero results in the capsule', () => {
    const t = (key: string, options?: Record<string, unknown>) => String(translations.t(key, { ns: 'flow-chat', ...options }));
    expect(getToolCapsuleSummary(item('AgentWait', {}), t).label).toBe('Wait result received');
    expect(getToolCapsuleSummary(item('AgentWait', {}, { results: [] }), t).label).toBe('Received 0 results');
    const cancelled = { ...item('AgentWait', {}), status: 'cancelled' as const, toolResult: { success: false } };
    expect(getToolCapsuleSummary(cancelled, t).label).toBe('Cancelled');
  });
});
