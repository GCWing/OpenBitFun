import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSettingsDraft, resetSettingsDraftRegistryForTests, getSettingsDraftSnapshot } from '@/infrastructure/config/settingsDraftRegistry';
import { isLegacyEcosystemCompatibilityDestination, resolveSettingsDestination } from './settingsDestination';
import { SETTINGS_CATEGORIES, SETTINGS_PAGE_MANIFESTS, getSettingsPageManifest, isSettingsPageId } from './settingsRegistry';
import { useSettingsStore } from './settingsStore';
import migrations from './settingsDestinationMigrations.json';
import type { SettingsDestinationInput } from './settingsDestination';

vi.mock('@/infrastructure/i18n/core/I18nService', () => ({
  i18nService: { loadNamespace: vi.fn(async () => undefined) },
}));

afterEach(() => {
  resetSettingsDraftRegistryForTests();
  useSettingsStore.setState(useSettingsStore.getInitialState());
});

describe('settings information architecture', () => {
  it('groups flat pages by ownership and keeps the pet independent', () => {
    expect(Object.fromEntries(SETTINGS_CATEGORIES.map(category => [category.id, category.pages.map(page => page.id)]))).toEqual({
      application: ['application.general', 'application.appearance', 'application.pet', 'application.input'],
      ai: ['ai.models', 'ai.session-memory', 'ai.execution', 'ai.permissions'],
      development: ['development.editor', 'development.terminal', 'development.workspace'],
      tools: ['tools.web-search', 'tools.desktop-control', 'tools.mcp', 'tools.external-agents', 'tools.automation'],
      data: ['data.usage', 'data.archived', 'data.diagnostics'],
    });
    expect(new Set(SETTINGS_PAGE_MANIFESTS.map(page => page.id)).size).toBe(19);
    expect(SETTINGS_PAGE_MANIFESTS.filter(page => page.views?.length).map(page => page.id)).toEqual(['tools.external-agents']);
    expect(getSettingsPageManifest('tools.external-agents').views?.map(view => view.id)).toEqual(['local', 'ssh', 'json']);
    expect(getSettingsPageManifest('application.input').sections?.map(section => section.id)).toEqual(['text-selection', 'voice', 'shortcuts']);
    expect(getSettingsPageManifest('application.pet').sections?.map(section => section.id)).toEqual(['voice-call', 'pet']);
    expect(getSettingsPageManifest('tools.automation').sections?.map(section => section.id)).toEqual(['quick-actions', 'hooks']);
  });

  it('keeps review with execution, permissions separate, and browser control with desktop control', () => {
    expect(getSettingsPageManifest('ai.execution').searchPhrases).toContainEqual({ namespace: 'settings/review-capacity', key: 'capacity.title' });
    expect(getSettingsPageManifest('ai.execution').searchPhrases).not.toContainEqual({ namespace: 'settings/runtime', key: 'permissionPolicy.sectionTitle' });
    expect(getSettingsPageManifest('ai.permissions').searchPhrases).toContainEqual({ namespace: 'settings/runtime', key: 'permissionPolicy.sectionTitle' });
    expect(getSettingsPageManifest('tools.desktop-control').searchPhrases).toEqual(expect.arrayContaining([
      { namespace: 'settings/runtime', key: 'computerUse.sectionTitle' },
      { namespace: 'settings/runtime', key: 'browserControl.sectionTitle' },
    ]));
  });

  it('keeps models with network settings and external-source governance outside Settings', () => {
    expect(getSettingsPageManifest('ai.models').searchPhrases).toEqual(expect.arrayContaining([
      { namespace: 'settings/default-model', key: 'sections.defaults' },
      { namespace: 'settings/default-model', key: 'sections.proxy' },
    ]));
    expect(SETTINGS_PAGE_MANIFESTS.some(page => /assistant|integrations|review/.test(page.id))).toBe(false);
    expect(isLegacyEcosystemCompatibilityDestination('external-sources')).toBe(true);
    expect(isLegacyEcosystemCompatibilityDestination({ pageId: 'tools.integrations' })).toBe(true);
  });

  it.each([
    ['application.voice', { pageId: 'application.input', sectionId: 'voice' }],
    ['shortcuts', { pageId: 'application.input', sectionId: 'shortcuts' }],
    ['application.shortcuts', { pageId: 'application.input', sectionId: 'shortcuts' }],
    ['application.development', { pageId: 'development.terminal' }],
    ['terminal', { pageId: 'development.terminal' }],
    ['editor', { pageId: 'development.editor' }],
    ['ai.memory', { pageId: 'ai.session-memory', sectionId: 'memory' }],
    ['workspace.session', { pageId: 'ai.session-memory', sectionId: 'session' }],
    ['workspace.worktrees', { pageId: 'development.workspace', sectionId: 'worktrees' }],
    ['tools.execution', { pageId: 'ai.execution' }],
    ['session-permissions', { pageId: 'ai.permissions' }],
    ['review', { pageId: 'ai.execution' }],
    ['tools.device-control', { pageId: 'tools.desktop-control' }],
    ['tools.browser-control', { pageId: 'tools.desktop-control' }],
    ['hooks', { pageId: 'tools.automation', sectionId: 'hooks' }],
    ['quick-actions', { pageId: 'tools.automation', sectionId: 'quick-actions' }],
    ['tools.webSearch', { pageId: 'tools.web-search' }],
    ['acp-agents', { pageId: 'tools.external-agents' }],
    ['mcp-tools', { pageId: 'tools.mcp' }],
    ['usage-statistics', { pageId: 'data.usage' }],
    ['archived-sessions', { pageId: 'data.archived' }],
    ['data.history', { pageId: 'data.usage' }],
  ])('migrates an existing %s link and round-trips the new destination', (oldId, expected) => {
    const destination = resolveSettingsDestination(oldId);
    expect(destination).toEqual(expected);
    expect(resolveSettingsDestination(destination)).toEqual(destination);
    useSettingsStore.getState().openDestination({ pageId: oldId });
    expect(useSettingsStore.getState().activePageId).toBe(destination.pageId);
    expect(useSettingsStore.getState().activeSectionId).toBe(destination.sectionId ?? null);
  });

  it('migrates old view payloads and drops targets that do not belong to the destination', () => {
    expect(resolveSettingsDestination({ pageId: 'tools.execution', viewId: 'common' })).toEqual({ pageId: 'ai.permissions' });
    expect(resolveSettingsDestination({ pageId: 'tools.execution', viewId: 'advanced' })).toEqual({ pageId: 'ai.execution' });
    expect(resolveSettingsDestination({ pageId: 'tools.automation', viewId: 'hooks' })).toEqual({ pageId: 'tools.automation', sectionId: 'hooks' });
    expect(resolveSettingsDestination({ pageId: 'tools.acp', viewId: 'ssh' })).toEqual({ pageId: 'tools.external-agents', viewId: 'ssh' });
    expect(resolveSettingsDestination({ pageId: 'ai.models', sectionId: 'hooks', viewId: 'json' })).toEqual({ pageId: 'ai.models' });
  });

  it('keeps shared catalog migrations on real pages and their owned sections', () => {
    const targets: SettingsDestinationInput[] = [
      ...Object.values(migrations.pages),
      ...Object.values(migrations.views).flatMap(Object.values),
      ...Object.values(migrations.capabilities).flatMap((migration) => [
        ...('destination' in migration ? [migration.destination] : []),
        ...('items' in migration ? Object.values(migration.items) : []),
      ]),
    ];
    for (const target of targets) {
      expect(isSettingsPageId(target.pageId), target.pageId).toBe(true);
      expect(resolveSettingsDestination(target)).toEqual(target);
    }
  });

  it('allows inline navigation without discarding edits and guards leaving the merged page', () => {
    useSettingsStore.getState().openDestination({ pageId: 'application.input', sectionId: 'shortcuts' });
    const save = vi.fn();
    const discard = vi.fn();
    registerSettingsDraft({ id: 'shortcuts', pageId: 'application.input', label: 'Shortcuts', dirty: true, save, discard });
    useSettingsStore.getState().openDestination({ pageId: 'application.voice' });
    expect(useSettingsStore.getState().activeSectionId).toBe('voice');
    expect(getSettingsDraftSnapshot().pendingNavigation).toBeNull();
    useSettingsStore.getState().openPage('application.general');
    expect(useSettingsStore.getState().activePageId).toBe('application.input');
    expect(getSettingsDraftSnapshot().pendingNavigation).not.toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });
});
