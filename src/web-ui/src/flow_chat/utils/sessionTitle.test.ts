// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../types/flow-chat';
import type { SessionMetadata } from '@/shared/types/session-history';
import { createDefaultSessionTitleDescriptor, deriveSessionTitleState, deriveSessionTitleStateFromMetadata, freezeSessionTitleState, resolvePersistedSessionTitle, resolveSessionTitle } from './sessionTitle';
import { buildSessionMetadata } from './sessionMetadata';

vi.mock('@/infrastructure/i18n', () => ({ i18nService: { t: (key: string) => key } }));

const translate = (key: string) => key === 'flow-chat:session.new' ? 'New Session' : key;
function defaultSession(): Session {
  return {
    sessionId: 'a', ...deriveSessionTitleState(createDefaultSessionTitleDescriptor(translate)),
    workspacePath: '/a', config: {},
    dialogTurns: [], status: 'idle', createdAt: 1, lastActiveAt: 1, error: null,
    mode: 'Standard', sessionKind: 'normal',
  };
}

describe('workspace session titles', () => {
  it('uses one plain default title', () => {
    expect(createDefaultSessionTitleDescriptor(translate)).toMatchObject({ text: 'New Session', key: 'flow-chat:session.new' });
    expect(resolveSessionTitle(defaultSession(), translate)).toBe('New Session');
  });

  it('reads old indexed titles as ordinary text without renaming or numbering', () => {
    for (const key of ['flow-chat:session.newCodeWithIndex', 'flow-chat:session.newCoworkWithIndex', 'flow-chat:session.newClawWithIndex', 'flow-chat:session.newWithIndex']) {
      const metadata = { sessionName: 'Old title 7', turnCount: 0, customMetadata: { titleSource: 'i18n', titleKey: key, titleParams: { count: 7 } } } as SessionMetadata;
      const titleState = deriveSessionTitleStateFromMetadata(metadata);
      expect(titleState).toMatchObject({ title: 'Old title 7', titleSource: 'text' });
      expect(resolvePersistedSessionTitle(metadata, translate)).toBe('Old title 7');
    }
  });

  it('displays a tagged legacy default title as saved text', () => {
    const metadata = { sessionName: 'New Claw Session 7', turnCount: 0, customMetadata: { titleSource: 'i18n', titleKey: 'flow-chat:session.newClawWithIndex', titleParams: { count: 7 } } } as SessionMetadata;
    expect(resolvePersistedSessionTitle(metadata, translate)).toBe('New Claw Session 7');
    expect(deriveSessionTitleStateFromMetadata(metadata).titleSource).toBe('text');
  });

  it('localizes the current default title only while it has default provenance', () => {
    const current = { sessionName: 'New Session', turnCount: 0, customMetadata: {
      titleSource: 'i18n', titleKey: 'flow-chat:session.new',
      titleParams: { defaultTitleText: 'New Session' },
    } } as SessionMetadata;
    const localized = () => '新会话';
    expect(resolvePersistedSessionTitle(current, localized)).toBe('新会话');
    expect(resolvePersistedSessionTitle({
      ...current, customMetadata: { ...current.customMetadata, titleUserEdited: true },
    }, localized)).toBe('New Session');
  });

  it('keeps a manually renamed empty session as text even when default metadata is stale', () => {
    const metadata = {
      sessionName: 'Fix login', turnCount: 0,
      customMetadata: {
        titleSource: 'i18n', titleKey: 'flow-chat:session.new',
        titleParams: { defaultTitleText: 'New Session' }, workspaceSessionNumber: 4,
      },
    } as SessionMetadata;
    expect(deriveSessionTitleStateFromMetadata(metadata)).toMatchObject({
      title: 'Fix login', titleSource: 'text',
    });
    expect(resolvePersistedSessionTitle(metadata, translate)).toBe('Fix login');
  });

  it('clears default title identity when the user names an empty session New Session', () => {
    const draft = defaultSession();
    const metadata = buildSessionMetadata(draft, { customMetadata: { workspaceSessionNumber: 4 } } as SessionMetadata);
    expect(deriveSessionTitleStateFromMetadata(metadata).titleSource).toBe('i18n');
    const renamed = buildSessionMetadata({ ...draft, ...freezeSessionTitleState('New Session') }, metadata);
    expect(renamed.customMetadata?.workspaceSessionNumber).toBe(4);
    expect(deriveSessionTitleStateFromMetadata(renamed)).toMatchObject({
      title: 'New Session', titleSource: 'text',
    });
  });
});
