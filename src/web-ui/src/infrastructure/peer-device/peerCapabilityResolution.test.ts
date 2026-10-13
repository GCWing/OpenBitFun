import { describe, expect, it } from 'vitest';

import {
  canCopySessionsOnSurface,
  canQueryToolCatalogOnSurface,
  canSubmitUserQuestionsOnSurface,
} from './peerCapabilityResolution';
import type { PeerHostCapabilities } from './PeerConnectionManager';

function caps(overrides: Partial<PeerHostCapabilities>): PeerHostCapabilities {
  return {
    idempotentDialogSubmit: false,
    targetedSessionRollback: false,
    tokenUsageStatistics: false,
    miniAppAgentContextFilesV1: false,
    cancelTool: null,
    toolCatalog: null,
    userQuestionResponse: null,
    hostKind: null,
    ...overrides,
  };
}

describe('canCopySessionsOnSurface', () => {
  it('requires explicit peer support even for older Desktop hosts', () => {
    expect(canCopySessionsOnSurface(false, null)).toBe(true);
    expect(canCopySessionsOnSurface(true, null)).toBe(false);
    expect(canCopySessionsOnSurface(true, caps({ hostKind: 'desktop' }))).toBe(false);
    expect(canCopySessionsOnSurface(true, caps({ hostKind: 'cli' }))).toBe(false);
    expect(canCopySessionsOnSurface(true, caps({ wholeSessionCopyV1: true }))).toBe(true);
  });
});

describe('canQueryToolCatalogOnSurface', () => {
  it('is always queryable on the local (controller) surface', () => {
    expect(canQueryToolCatalogOnSurface(false, null)).toBe(true);
    expect(canQueryToolCatalogOnSurface(false, caps({ toolCatalog: false }))).toBe(true);
  });

  it('stays optimistic while peer capabilities are still being probed', () => {
    expect(canQueryToolCatalogOnSurface(true, null)).toBe(true);
  });

  it('honors an explicitly advertised tool_catalog flag', () => {
    expect(canQueryToolCatalogOnSurface(true, caps({ toolCatalog: true }))).toBe(true);
    expect(canQueryToolCatalogOnSurface(true, caps({ toolCatalog: false }))).toBe(false);
  });

  it('resolves a null tool_catalog by host kind (old CLI unsupported, old Desktop optimistic)', () => {
    // An older host did not advertise tool_catalog; cancel_tool/tool_catalog
    // parse to null. host_type still discriminates the two. See PR #2428 #5.1.
    expect(canQueryToolCatalogOnSurface(true, caps({ hostKind: 'cli' }))).toBe(false);
    expect(canQueryToolCatalogOnSurface(true, caps({ hostKind: 'desktop' }))).toBe(true);
    // hostKind also unknown → stay optimistic.
    expect(canQueryToolCatalogOnSurface(true, caps({ hostKind: null }))).toBe(true);
  });

  it('an explicitly advertised false beats hostKind (a current CLI that says false is unsupported even though hostKind is cli)', () => {
    expect(
      canQueryToolCatalogOnSurface(true, caps({ toolCatalog: false, hostKind: 'cli' })),
    ).toBe(false);
    expect(
      canQueryToolCatalogOnSurface(true, caps({ toolCatalog: true, hostKind: 'cli' })),
    ).toBe(true);
  });
});

describe('canSubmitUserQuestionsOnSurface', () => {
  it('keeps local and Desktop interaction responses available', () => {
    expect(canSubmitUserQuestionsOnSurface(false, null)).toBe(true);
    expect(canSubmitUserQuestionsOnSurface(
      true,
      caps({ hostKind: 'desktop' }),
    )).toBe(true);
  });

  it('requires the advertised capability from CLI peers', () => {
    expect(canSubmitUserQuestionsOnSurface(
      true,
      caps({ hostKind: 'cli' }),
    )).toBe(false);
    expect(canSubmitUserQuestionsOnSurface(
      true,
      caps({ hostKind: 'cli', userQuestionResponse: true }),
    )).toBe(true);
  });
});
