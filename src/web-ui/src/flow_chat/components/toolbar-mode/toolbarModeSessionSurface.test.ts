/**
 * The floating chat surfaces must render the main window session surface
 * itself, never a reduced copy of it. These assertions exist so the parallel
 * conversation/composer implementations that used to live in each one do not
 * creep back in — those duplicates were always feature subsets and doubled the
 * maintenance cost of every chat change.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8').replace(/\r\n?/g, '\n');
}

const SURFACES = [
  { name: 'floating window mode (ToolbarMode)', path: './ToolbarMode.tsx' },
  { name: 'floating mini chat bubble', path: '../../../app/layout/FloatingMiniChat.tsx' },
];

describe.each(SURFACES)('$name session surface', ({ path }) => {
  const source = readSource(path);

  it('renders the main window ChatPane with its full composer', () => {
    expect(source).toContain("from '@/app/scenes/session/ChatPane'");
    expect(source).toContain('<ChatPane');
    expect(source).toContain('showChatInput');
  });

  it('uses the shared text/realtime-voice capability surface', () => {
    expect(source).toContain('ConversationModeSurface');
    expect(source).toContain('<ConversationModeSurface');
    expect(source).not.toContain('<RealtimeVoiceCallPanel');
  });

  it('keeps no private conversation view or session composer of its own', () => {
    expect(source).not.toContain('ModernFlowChatContainer');
    expect(source).not.toContain('<input');
    expect(source).not.toContain('toolbar-send-message');
    // Nothing here may submit into the host session: that is ChatInput's job.
    expect(source).not.toContain('sendMessage');
  });

  it('uses the owning session menu or conversation dock for selection', () => {
    if (path.endsWith('FloatingMiniChat.tsx')) {
      expect(source).toContain('useConversationDockStore');
      expect(source).toContain('<TabGroup');
      expect(source).toContain('dropConversationInDock');
      expect(source).toContain('returnConversationToWorkbench');
      expect(source).not.toContain('flowChatStore.setActiveSession');
      return;
    }
    expect(source).toContain('<SessionMenu');
    expect(source).toContain('useFlowChatSessions');
    // The "+" must open the shared menu rather than creating a session
    // directly, and the title must stay a plain display — the two surfaces
    // diverged on exactly these before.
    expect(source).not.toContain('title-btn');
    expect(source).not.toContain('ChevronDown');
    expect(source).not.toContain("CustomEvent('toolbar-create-session'");
    expect(source).toContain('title-display');
  });
});

describe('session surface composition', () => {
  it('reuses the session scene chat surface that ChatPane already composes', () => {
    const chatPaneSource = readSource('../../../app/scenes/session/ChatPane.tsx');

    expect(chatPaneSource).toContain(
      "from '../../../flow_chat/components/modern/ModernFlowChatContainer'"
    );
    expect(chatPaneSource).toContain("from '../../../flow_chat/components/ChatInput'");
    expect(chatPaneSource).toContain('registration={chatInputRegistration}');
  });

  it('keeps the voice panel and switch in one shared owner', () => {
    const communicationSource = readSource('../voice/ConversationModeSurface.tsx');
    const toolbarSource = readSource('./ToolbarMode.tsx');
    const bubbleSource = readSource('../../../app/layout/FloatingMiniChat.tsx');

    const voiceSource = readSource('../voice/RealtimeVoiceCallPanel.tsx');
    expect(communicationSource).toMatch(/<RealtimeVoiceCallPanel\b[^>]*onClose=\{onCloseVoice\}/);
    expect(communicationSource).toContain('onClick={handleModeSwitch}');
    expect(communicationSource).toContain("'voiceCall.call.switchToVoice'");
    expect(voiceSource).toContain('<VoiceCallPanel');
    expect(voiceSource).toContain("'voiceCall.call.switchToChat'");
    expect(communicationSource).toContain('(enabled || ownsCall) && !isVoiceMode');
    expect(bubbleSource).toContain('onCloseVoice={onCollapse}');
    expect(toolbarSource).toContain('onCloseVoice={handleToggleExpanded}');
    expect(toolbarSource).toContain('switchTestId="toolbar-realtime-voice-mode-switch"');
    expect(bubbleSource).toContain('switchTestId="hello-realtime-voice-mode-switch"');
  });
});

describe('floating mini chat bubble MiniApp registration', () => {
  const source = readSource('../../../app/layout/FloatingMiniChat.tsx');
  const styles = readSource('../../../app/layout/FloatingMiniChat.scss');

  it('keeps the full shared composer while a MiniApp holds a registration', () => {
    expect(source).toContain('showChatInput');
    expect(source).toContain('chatInputRegistration={registration}');
    expect(source).not.toContain('showChatInput={!activeComposerClaim}');
    expect(source).not.toContain('const MiniAppComposer');
    expect(source).not.toContain('<MiniAppComposer');
    expect(source).not.toContain('<textarea');
    expect(source).not.toContain('miniapp-composer');
    expect(styles).not.toContain('miniapp-composer');
    expect(styles).not.toContain('panel--miniapp');
  });

  it('registers a token-scoped submit route without replacing ChatInput', () => {
    expect(source).toContain('postMiniAppComposerMessage');
    // Routing is keyed by claim token, never by app id: one app can have two
    // live runners (installed app + draft preview) and only one owns the input.
    expect(source).toContain('registrationId: entry.claimToken!');
    expect(source).toContain('live?.token !== entry.claimToken');
    expect(source).toContain('live.sessionId !== entry.sessionId');
    expect(source).toContain('postMiniAppComposerMessage({ ...submission, token: entry.claimToken!, sessionId: entry.sessionId })');
  });

  it('routes realtime voice through the claimed MiniApp conversation', () => {
    expect(source).toContain('useMemo<VoiceCallTarget | undefined>');
    expect(source).toContain("kind: 'miniapp'");
    expect(source).toContain('claimToken: entry.claimToken!');
    expect(source).toContain('sessionId: entry.sessionId');
    expect(source).toContain('voiceTarget={voiceTarget}');
  });

  it('prefills without sending when a MiniApp offers an example prompt', () => {
    expect(source).toContain('MINIAPP_COMPOSER_DRAFT_EVENT');
    expect(source).toContain('state.setDraft(dockConversationKey(entry), detail.text)');
    expect(source).toContain('onSuggestion={setDraft}');
    expect(source).toContain('onDraftConsumed: id => useConversationDockStore.getState().consumeDraft(key, id)');
  });

  it('resolves the claimed conversation before storing and revealing a MiniApp draft', () => {
    const listenerIndex = source.indexOf('const listener = (event: Event)');
    const resolveIndex = source.indexOf('resolveMiniAppConversation(appId, surfaceId)', listenerIndex);
    const guardIndex = source.indexOf('entry.claimToken !== value.token', resolveIndex);
    const draftIndex = source.indexOf('state.setDraft(dockConversationKey(entry), detail.text)', guardIndex);
    const openIndex = source.indexOf('openMiniAppConversation(appId, surfaceId)', draftIndex);
    expect(listenerIndex).toBeGreaterThan(-1);
    expect(resolveIndex).toBeGreaterThan(listenerIndex);
    expect(guardIndex).toBeGreaterThan(resolveIndex);
    expect(draftIndex).toBeGreaterThan(guardIndex);
    expect(openIndex).toBeGreaterThan(draftIndex);
  });

  it('consumes drafts through their conversation key and acknowledgement id', () => {
    expect(source).toContain('const key = dockConversationKey(entry)');
    expect(source).toContain('state.drafts[key]');
    expect(source).toContain('consumeDraft(key, id)');
  });

  it('fails closed around an Agentic MiniApp and shows only its exact topic session', () => {
    expect(source).toContain('claim?.surfaceId === entry.surfaceId');
    expect(source).toContain('claim?.token === entry.claimToken');
    expect(source).toContain('claim?.sessionId === entry.sessionId');
    expect(source).toContain('!session || !claimValid ? unavailable');
    expect(source).toContain('<ChatPane sessionRef={entry}');
    expect(source).toContain('voiceStartDisabled={!voiceTarget || !claimValid}');
    expect(source).not.toContain('flowChatStore.setActiveSession');
  });

  it('renders the MiniApp entry model against the topic session workspace', () => {
    const welcomeSource = readSource('../../../app/layout/MiniAppBubbleWelcome.tsx');
    expect(source).toContain('<MiniAppBubbleWelcome');
    expect(source).toContain('customization={claim?.customization}');
    expect(source).toContain('workspacePath={session.workspacePath}');
    expect(source).toContain('emptyState={<MiniAppBubbleWelcome');
    expect(source).toContain("showIcon={entry.kind === 'miniapp'}");
    expect(source).not.toContain('getMiniAppIconGradient');
    expect(welcomeSource).toContain('computeFlowChatInputStackFooterPx(inputHeight)');
    expect(welcomeSource).toContain('openbitfun-fmc__miniapp-welcome-content');
    expect(welcomeSource).toContain('WELCOME_CONTENT_BLOCK_PADDING_PX + inputClearance');
    expect(styles).toContain('overflow-y: auto;');
    expect(source).toContain('state.sessions.get(entry.sessionId)');
  });

  it('hydrates a restored hidden topic session instead of substituting the latest chat', () => {
    const bridgeSource = readSource(
      '../../../app/scenes/miniapps/hooks/useMiniAppBridge.ts'
    );

    expect(bridgeSource).toContain('if (!result.created)');
    expect(bridgeSource).toContain('flowChatStore.loadSessionHistory(');
    expect(bridgeSource).toContain('{ includeInternal: true }');
  });

  it('forwards a MiniApp agent turn user-facing label separately from its prompt', () => {
    const bridgeSource = readSource(
      '../../../app/scenes/miniapps/hooks/useMiniAppBridge.ts'
    );

    expect(bridgeSource).toContain(
      "typeof params.displayText === 'string' ? params.displayText : undefined"
    );
    expect(bridgeSource).toContain("method === 'chat.completeUserMessage'");
    expect(bridgeSource).toContain('completeMiniAppComposerMessage(');
    expect(bridgeSource).toContain('requestId: detail.requestId');
    expect(bridgeSource).toContain('source: detail.source');
  });
});
