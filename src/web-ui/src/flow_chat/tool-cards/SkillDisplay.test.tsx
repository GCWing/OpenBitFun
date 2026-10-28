import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { SkillDisplay } from './SkillDisplay';
import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) => {
      const messages: Record<string, string> = {
        'toolCards.skill.action': 'Load skill',
        'toolCards.skill.skillAction': 'Load skill: {{name}}',
        'toolCards.skill.unknownSkill': 'Unknown skill',
        'toolCards.skill.unknown': 'Unknown',
        'toolCards.skill.loadSkillFailed': 'Failed to load skill',
        'toolCards.skill.loadingSkill': 'Loading skill',
        'toolCards.skill.preparingSkill': 'Preparing skill',
        'toolCards.skill.markdownOnlyResources': 'Only SKILL.md loaded; supporting files were not synced to the remote host.',
        'toolCards.skill.remotePackageResources': 'Skill package synced to the remote host; required runtimes still need to be available.',
      };
      return (messages[key] ?? key).replace('{{name}}', options?.name ?? '');
    },
  }),
}));

const skillConfig: ToolCardConfig = {
  attention: 'ambient',
  presentation: 'standard',
  toolName: 'Skill',
  displayName: 'Skill',
  icon: 'S',
  requiresConfirmation: false,
  resultDisplayType: 'summary',
};

describe('SkillDisplay', () => {
  let dom: JSDOM;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);

    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it('shows the original skill name without source after loading', () => {
    const toolItem: FlowToolItem = {
      id: 'skill-academic-research',
      type: 'tool',
      toolName: 'Skill',
      status: 'completed',
      timestamp: Date.now(),
      toolCall: {
        id: 'call-academic-research',
        input: { command: 'deep-research' },
      },
      toolResult: {
        id: 'result-academic-research',
        result: {
          skill_name: 'deep-research',
          skill_display_name: 'Academic Deep Research',
          source_label: 'Codex',
        },
        timestamp: Date.now(),
      },
    };

    act(() => {
      root.render(<SkillDisplay toolItem={toolItem} config={skillConfig} />);
    });

    expect(container.textContent).toBe('Load skill: deep-research');
  });

  it('omits the source label for historical results that only recorded a slot', () => {
    const toolItem: FlowToolItem = {
      id: 'skill-legacy-research',
      type: 'tool',
      toolName: 'Skill',
      status: 'completed',
      timestamp: Date.now(),
      toolCall: {
        id: 'call-legacy-research',
        input: { command: 'legacy-deep-research' },
      },
      toolResult: {
        id: 'result-legacy-research',
        result: {
          skill_name: 'legacy-deep-research',
          source_slot: 'home.codex',
        },
        timestamp: Date.now(),
      },
    };

    act(() => {
      root.render(<SkillDisplay toolItem={toolItem} config={skillConfig} />);
    });

    expect(container.textContent).toBe('Load skill: legacy-deep-research');
  });

  it.each([
    [{ skill_name: 'deep-research' }, 'Load skill: deep-research'],
    [{ name: 'deep-research' }, 'Load skill: deep-research'],
    [{ skill_name: 'deep-research', source_id: 'codex' }, 'Load skill: deep-research'],
    [{ skill_name: 'deep-research', source_slot: 'future' }, 'Load skill: deep-research'],
    [{ skill_name: 'deep-research', source_label: ' ', source_id: null }, 'Load skill: deep-research'],
    [{ skill_name: 'deep-research', source_label: 42, source_id: {}, source_slot: 'codex' }, 'Load skill: deep-research'],
    [{ skill_name: {}, name: 'legacy-name' }, 'Load skill: legacy-name'],
    [{ skill_name: 'deep-research', resource_availability: 'future_mode' }, 'Load skill: deep-research'],
    [{ skill_name: 'deep-research', resource_availability: {} }, 'Load skill: deep-research'],
    [{}, 'Load skill: Unknown skill'],
  ])('renders compatible tool result %j', (result, summary) => {
    const toolItem: FlowToolItem = {
      id: 'compatible-skill',
      type: 'tool',
      toolName: 'Skill',
      status: 'completed',
      timestamp: 0,
      toolCall: { id: 'call', input: { command: 'deep-research' } },
      toolResult: { id: 'result', result, timestamp: 0 },
    };

    act(() => {
      root.render(<SkillDisplay toolItem={toolItem} config={skillConfig} />);
    });

    expect(container.textContent).toBe(summary);
  });

  it.each([
    ['running', 'Load skill: deep-research'],
    ['pending', 'Load skill: deep-research'],
    ['error', 'Load skill: deep-research'],
  ] as const)('keeps the command name while %s', (status, summary) => {
    const toolItem: FlowToolItem = {
      id: 'pending-skill',
      type: 'tool',
      toolName: 'Skill',
      status,
      timestamp: 0,
      toolCall: { id: 'call', input: { command: 'deep-research' } },
    };

    act(() => {
      root.render(<SkillDisplay toolItem={toolItem} config={skillConfig} />);
    });

    expect(container.textContent).toBe(summary);
  });

  it('shows synchronization progress while loading and clears it when the operation settles', () => {
    const progress = 'Uploading skill package: 2,048 files; many small files may take a while.';
    const toolItem = {
      id: 'syncing-skill',
      type: 'tool',
      toolName: 'Skill',
      status: 'running',
      timestamp: 0,
      toolCall: { id: 'call', input: { command: 'scripted-skill' } },
      _progressMessage: progress,
    } as FlowToolItem;

    act(() => {
      root.render(<SkillDisplay toolItem={toolItem} config={skillConfig} />);
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(progress);
    expect(container.textContent).toContain('scripted-skill');

    for (const status of ['completed', 'error', 'cancelled'] as const) {
      act(() => {
        root.render(<SkillDisplay toolItem={{ ...toolItem, status }} config={skillConfig} />);
      });
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(container.textContent).not.toContain(progress);
    }
  });

  it.each([
    ['markdown_only', 'Only SKILL.md loaded; supporting files were not synced to the remote host.'],
    ['remote_package', 'Skill package synced to the remote host; required runtimes still need to be available.'],
  ])('explains resource availability after a completed %s load', (availability, message) => {
    const toolItem: FlowToolItem = {
      id: 'remote-skill', type: 'tool', toolName: 'Skill', status: 'completed', timestamp: 0,
      toolCall: { id: 'call', input: { command: 'scripted-skill' } },
      toolResult: {
        id: 'result', timestamp: 0,
        result: { skill_name: 'scripted-skill', resource_availability: availability },
      },
    };
    act(() => root.render(<SkillDisplay toolItem={toolItem} config={skillConfig} />));
    expect(container.querySelector('[role="note"]')?.textContent).toBe(message);
    expect(container.textContent).toContain('Load skill: scripted-skill');
    expect(container.querySelector(`[aria-label="${message}"]`)).not.toBeNull();

    for (const status of ['running', 'error', 'cancelled'] as const) {
      act(() => root.render(<SkillDisplay toolItem={{ ...toolItem, status }} config={skillConfig} />));
      expect(container.querySelector('[role="note"]')).toBeNull();
      expect(container.textContent).not.toContain(message);
    }
  });

  it.each([undefined, '  ', 42, {}])('ignores an absent or malformed progress message %j', (progress) => {
    const toolItem = {
      id: 'syncing-skill',
      type: 'tool',
      toolName: 'Skill',
      status: 'running',
      timestamp: 0,
      toolCall: { id: 'call', input: { command: 'scripted-skill' } },
      _progressMessage: progress,
    } as FlowToolItem;
    act(() => {
      root.render(<SkillDisplay toolItem={toolItem} config={skillConfig} />);
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
