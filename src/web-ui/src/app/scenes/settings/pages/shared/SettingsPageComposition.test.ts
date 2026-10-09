import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('merged settings pages', () => {
  it.each([
    ['../application/PetAssistantSettingsPage.tsx', ['../application/PetSettingsSection.tsx', '../application/RealtimeVoiceSettingsSection.tsx']],
    ['../application/InputSettingsPage.tsx', ['../application/VoiceSettingsSection.tsx', '../application/KeyboardShortcutsSection.tsx']],
    ['../ai/SessionMemorySettingsPage.tsx', ['../ai/DefaultHarnessSection.tsx', '../ai/SessionTitleSection.tsx', '../ai/MemorySettingsSection.tsx']],
    ['../development/WorkspaceGitSettingsPage.tsx', ['../development/WorkspaceSearchSection.tsx', '../development/GitCommitSettingsSection.tsx', '../development/WorktreeSettingsSection.tsx']],
    ['../tools/AutomationSettingsPage.tsx', ['../tools/QuickActionsSettingsSection.tsx', '../tools/HooksSettingsSection.tsx']],
  ])('keeps one page header and scroll owner for %s', (page, sections) => {
    expect(source(page).match(/<SettingsPage\b/g)).toHaveLength(1);
    for (const path of [page, ...sections]) {
      expect(source(path)).not.toMatch(/<(?:Tabs|TabPane|ConfigPageLayout|ConfigPageContent|ConfigPageHeader|ScrollArea)\b/);
    }
    const shared = source('./SettingsPage.tsx');
    expect(shared.match(/<ConfigPageLayout\b/g)).toHaveLength(1);
    expect(shared.match(/<ConfigPageHeader\b/g)).toHaveLength(1);
    expect(shared.match(/<ConfigPageContent\b/g)).toHaveLength(1);
  });
});
