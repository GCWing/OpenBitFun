import { beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeMiniAppBubbleCustomization,
  useMiniAppStore,
} from './miniAppStore';

describe('miniAppStore customization state', () => {
  beforeEach(() => {
    useMiniAppStore.setState({
      apps: [],
      loading: false,
      runningWorkerIds: [],
      customizingAppIds: [],
      composerClaims: {},
      marketOrigins: {},
    });
  });

  it('tracks apps with an active customization panel', () => {
    useMiniAppStore.getState().markCustomizationActive('gomoku');
    useMiniAppStore.getState().markCustomizationActive('gomoku');

    expect(useMiniAppStore.getState().customizingAppIds).toEqual(['gomoku']);

    useMiniAppStore.getState().markCustomizationIdle('gomoku');

    expect(useMiniAppStore.getState().customizingAppIds).toEqual([]);
  });

  it('removes stale runtime-derived ids when the app catalog changes', () => {
    useMiniAppStore.setState({
      customizingAppIds: ['gomoku', 'removed-app'],
      runningWorkerIds: ['gomoku', 'removed-app'],
    });

    useMiniAppStore.getState().setApps([
      {
        id: 'gomoku',
        name: 'Gomoku',
        description: '',
        category: 'game',
        version: 1,
        icon: 'box',
        tags: [],
        created_at: 1,
        updated_at: 1,
        permissions: {},
      },
    ]);

    expect(useMiniAppStore.getState().customizingAppIds).toEqual(['gomoku']);
    expect(useMiniAppStore.getState().runningWorkerIds).toEqual(['gomoku']);
  });

  it('keeps market origins only for apps still in the catalog', () => {
    const origin = {
      listingId: 'listing-1',
      releaseId: 'release-2',
      releaseNumber: 2,
      packageSha256: 'a'.repeat(64),
    };
    useMiniAppStore.getState().setMarketOrigin('gomoku', origin);
    useMiniAppStore.getState().setMarketOrigin('removed-app', origin);

    useMiniAppStore.getState().setApps([
      {
        id: 'gomoku',
        name: 'Gomoku',
        description: '',
        category: 'game',
        version: 1,
        icon: 'box',
        tags: [],
        created_at: 1,
        updated_at: 1,
        permissions: {},
      },
    ]);

    expect(useMiniAppStore.getState().marketOrigins).toEqual({ gomoku: origin });
  });

  it('adds and updates an installed app without waiting for a catalog reload', () => {
    const installed = {
      id: 'market-app',
      name: 'Market App',
      description: '',
      category: 'productivity',
      version: 1,
      icon: 'Aperture',
      tags: [],
      created_at: 1,
      updated_at: 1,
      permissions: {},
    };

    useMiniAppStore.getState().upsertApp(installed);
    expect(useMiniAppStore.getState().apps).toEqual([installed]);

    const updated = { ...installed, name: 'Updated Market App', version: 2 };
    useMiniAppStore.getState().upsertApp(updated);
    expect(useMiniAppStore.getState().apps).toEqual([updated]);
  });
});

describe('miniAppStore floating bubble composer claims', () => {
  beforeEach(() => {
    useMiniAppStore.setState({ apps: [], composerClaims: {} });
  });

  it('lets the newest runner take the claim', () => {
    useMiniAppStore.getState().claimComposer('ppt', {
      token: 'ppt#1',
      placeholder: 'a',
      sessionId: 'session-1',
    });
    useMiniAppStore.getState().claimComposer('ppt', { token: 'ppt#2', placeholder: 'b' });

    expect(useMiniAppStore.getState().composerClaims.ppt).toEqual({
      token: 'ppt#2',
      surfaceId: 'local',
      placeholder: 'b',
    });
  });

  it('keeps a topic session when the same runner refreshes its localized claim', () => {
    useMiniAppStore.getState().claimComposer('ppt', {
      token: 'ppt#1',
      placeholder: 'English',
      customization: {
        welcome: { title: 'Build a deck' },
      },
    });
    useMiniAppStore.getState().setComposerSession('ppt', 'ppt#1', 'session-1');
    useMiniAppStore.getState().claimComposer('ppt', {
      token: 'ppt#1',
      placeholder: '中文',
      customization: {
        welcome: { title: '制作演示稿' },
      },
    });

    expect(useMiniAppStore.getState().composerClaims.ppt).toEqual({
      token: 'ppt#1',
      surfaceId: 'local',
      placeholder: '中文',
      customization: {
        welcome: { title: '制作演示稿' },
      },
      sessionId: 'session-1',
    });
  });

  it('only lets the current runner bind its dedicated session', () => {
    useMiniAppStore.getState().claimComposer('ppt', { token: 'ppt#2' });

    useMiniAppStore.getState().setComposerSession('ppt', 'ppt#1', 'stale-session');
    expect(useMiniAppStore.getState().composerClaims.ppt).toEqual({ token: 'ppt#2', surfaceId: 'local' });

    useMiniAppStore.getState().setComposerSession('ppt', 'ppt#2', 'session-2');
    expect(useMiniAppStore.getState().composerClaims.ppt).toEqual({
      token: 'ppt#2',
      surfaceId: 'local',
      sessionId: 'session-2',
    });

    useMiniAppStore.getState().clearComposerSession('ppt', 'ppt#1');
    expect(useMiniAppStore.getState().composerClaims.ppt?.sessionId).toBe('session-2');

    useMiniAppStore.getState().clearComposerSession('ppt', 'ppt#2');
    expect(useMiniAppStore.getState().composerClaims.ppt).toEqual({ token: 'ppt#2', surfaceId: 'local' });
  });

  // The installed app and its draft preview run side by side during AI
  // customization. When one unmounts it must not release the other's claim,
  // or the bubble would silently fall back to the host session composer.
  it('ignores a release from a runner that no longer holds the claim', () => {
    useMiniAppStore.getState().claimComposer('ppt', { token: 'ppt#1' });
    useMiniAppStore.getState().claimComposer('ppt', { token: 'ppt#2' });

    useMiniAppStore.getState().releaseComposer('ppt', 'ppt#1');
    expect(useMiniAppStore.getState().composerClaims.ppt).toEqual({ token: 'ppt#2', surfaceId: 'local' });

    useMiniAppStore.getState().releaseComposer('ppt', 'ppt#2');
    expect(useMiniAppStore.getState().composerClaims.ppt).toBeUndefined();
  });

  it('drops claims for apps that leave the catalog', () => {
    useMiniAppStore.getState().claimComposer('removed-app', { token: 'removed-app#1' });

    useMiniAppStore.getState().setApps([]);

    expect(useMiniAppStore.getState().composerClaims).toEqual({});
  });
});

describe('MiniApp bubble customization contract', () => {
  it('normalizes bounded content for the host-rendered welcome and shared composer', () => {
    const customization = normalizeMiniAppBubbleCustomization({
      title: ' PPT Live ',
      // Shell geometry and composer layout are deliberately ignored. A
      // MiniApp may register content, never replace or reshape ChatInput.
      panelSize: 'wide',
      composer: {
        placeholder: ' Describe a deck ',
        hint: ' Messages stay with this deck ',
        rows: 9,
      },
      welcome: {
        title: ' What should we present? ',
        description: ' Start with the audience and outcome. ',
        workspaceLabel: ' PPT Live workspace ',
        suggestionsLabel: ' Try an example ',
        suggestions: [
          { label: 'Strategy deck', prompt: 'Build a 10-page strategy deck' },
          'Make this page more visual',
        ],
      },
    });

    expect(customization).toEqual({
      title: 'PPT Live',
      composer: {
        placeholder: 'Describe a deck',
      },
      welcome: {
        title: 'What should we present?',
        description: 'Start with the audience and outcome.',
        workspaceLabel: 'PPT Live workspace',
        suggestionsLabel: 'Try an example',
        suggestions: [
          { label: 'Strategy deck', prompt: 'Build a 10-page strategy deck' },
          { label: 'Make this page more visual', prompt: 'Make this page more visual' },
        ],
      },
    });
  });

  it('ignores shell overrides and caps suggestion count', () => {
    const customization = normalizeMiniAppBubbleCustomization({
      panelSize: 'cover-the-screen',
      composer: {
        hint: 'Custom footer',
        rows: 4,
      },
      welcome: {
        suggestions: Array.from({ length: 9 }, (_, index) => ({
          label: `Suggestion ${index}`,
          prompt: `Prompt ${index}`,
        })),
      },
    });

    expect(customization?.composer).toBeUndefined();
    expect(customization?.welcome?.suggestions).toHaveLength(6);
  });
});
