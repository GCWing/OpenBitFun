/**
 * E2E spec to reproduce GitHub issue #1176: excessive whitespace at bottom of
 * message list after multi-turn conversations with tool-card collapses.
 *
 * Run:
 *   cd tests/e2e
 *   pnpm wdio run ./config/wdio.conf.ts --spec ./specs/l1-chat-scroll-whitespace.spec.ts
 */

import { browser, expect, $ } from '@wdio/globals';
import { Header } from '../page-objects/components/Header';
import { StartupPage } from '../page-objects/StartupPage';
import { openWorkspace } from '../helpers/workspace-helper';
import { saveScreenshot, saveFailureScreenshot } from '../helpers/screenshot-utils';

// ---------------------------------------------------------------------------
// DOM diagnostic helper — dump what's actually rendered so we can fix selectors
// ---------------------------------------------------------------------------
async function dumpDomDiagnostics(): Promise<void> {
  const diag = await browser.execute(() => {
    const all = document.querySelectorAll('*');
    const classSet = new Set<string>();
    const testIdSet = new Set<string>();
    for (const el of all) {
      if (el.className && typeof el.className === 'string') {
        for (const c of el.className.split(/\s+/)) {
          if (c.startsWith('virtual-message') || c.startsWith('message-list') || c.startsWith('openbitfun-session') || c.startsWith('openbitfun-scene') || c.startsWith('openbitfun-nav-panel__top-action') || c.startsWith('welcome-panel') || c.startsWith('modern-flowchat')) {
            classSet.add(c);
          }
        }
      }
      const tid = el.getAttribute('data-testid');
      if (tid && (tid.includes('chat') || tid.includes('session') || tid.includes('message'))) {
        testIdSet.add(tid);
      }
      if (el.hasAttribute('data-flowchat-scroller')) {
        classSet.add('[data-flowchat-scroller]');
      }
    }
    // Read data attributes from the messages container
    const messagesDiv = document.querySelector('[data-virtual-item-count]');
    return {
      relevantClasses: Array.from(classSet).sort(),
      relevantTestIds: Array.from(testIdSet).sort(),
      virtualMessageList: !!document.querySelector('.virtual-message-list'),
      flowChatScroller: !!document.querySelector('[data-flowchat-scroller]'),
      messageListFooter: !!document.querySelector('.message-list-footer'),
      chatInputContainer: !!document.querySelector('[data-testid="chat-input-container"]'),
      sessionScene: !!document.querySelector('.openbitfun-session-scene'),
      sceneViewport: !!document.querySelector('.openbitfun-scene-viewport'),
      topActionBtns: document.querySelectorAll('button.openbitfun-nav-panel__top-action-btn').length,
      activeSceneId: (document.querySelector('.openbitfun-scene-viewport__scene--active') as HTMLElement)?.className || null,
      // Key data attributes for debugging
      virtualItemCount: messagesDiv?.getAttribute('data-virtual-item-count') || 'N/A',
      activeSessionId: messagesDiv?.getAttribute('data-active-session-id') || 'N/A',
      dialogTurnCount: messagesDiv?.getAttribute('data-dialog-turn-count') || 'N/A',
      welcomePanel: !!document.querySelector('.welcome-panel'),
      modernFlowChatContainer: !!document.querySelector('.modern-flowchat-container'),
    };
  });
  console.log('[L1-#1176] DOM DIAGNOSTICS:', JSON.stringify(diag, null, 2));
}

// ---------------------------------------------------------------------------
// Create session via FlowChatManager (uses dynamic import, avoids manual wiring)
// ---------------------------------------------------------------------------
async function createCodeSessionViaFlowChatManager(): Promise<string | null> {
  return browser.execute(async () => {
    try {
      const { FlowChatManager } = await import('/src/flow_chat/services/FlowChatManager.ts');
      const flowChatManager = FlowChatManager.getInstance();

      // Open the session scene first
      const { useSceneStore } = await import('/src/app/stores/sceneStore.ts');
      useSceneStore.getState().openScene('session');

      // Set session mode
      const { useSessionModeStore } = await import('/src/app/stores/sessionModeStore.ts');
      useSessionModeStore.getState().setMode('code');

      // Create the session via FlowChatManager (the proper way)
      const sessionId = await flowChatManager.createChatSession({}, 'agentic');
      return sessionId || null;
    } catch (e: any) {
      return null;
    }
  });
}

// ---------------------------------------------------------------------------
// Populate session with synthetic dialog turns so VirtualMessageList renders.
// When virtualItems.length === 0, ModernFlowChatContainer renders WelcomePanel
// instead of VirtualMessageList. We need dialog turns to produce virtual items.
// ---------------------------------------------------------------------------
async function populateSessionWithTurns(sessionId: string, turnCount: number): Promise<boolean> {
  return browser.execute((sid: string, count: number) => {
    try {
      // Access stores via dynamic import (Vite dev server resolves these)
      const flowChatStoreMod = window.__E2E_FLOW_CHAT_STORE__;
      const modernStoreMod = window.__E2E_MODERN_STORE__;

      // If pre-stored references aren't available, try dynamic import
      const getStores = async () => {
        if (flowChatStoreMod && modernStoreMod) return { flowChatStore: flowChatStoreMod, modernStore: modernStoreMod };
        const fc = await import('/src/flow_chat/store/FlowChatStore.ts');
        const ms = await import('/src/flow_chat/store/modernFlowChatStore.ts');
        return { flowChatStore: fc.flowChatStore, modernStore: ms.useModernFlowChatStore };
      };

      // We can't use async in execute with return, so use sync approach
      // The stores are singletons already loaded in the app - access via window
      // We'll set up the data synchronously through already-loaded modules

      // Access the FlowChatStore singleton directly - it's already loaded in the app
      // We need to find it through the app's module system
      const fcStore = (window as any).__E2E_FC_STORE__;
      const modStore = (window as any).__E2E_MOD_STORE__;

      if (!fcStore || !modStore) {
        // Stores not pre-exposed; return false to signal caller should try alternate approach
        return false;
      }

      const now = Date.now();
      for (let i = 0; i < count; i++) {
        const turnId = `dialog_e2e_${now}_${i}_${Math.random().toString(36).substr(2, 9)}`;
        const userMsgId = `user_e2e_${now}_${i}`;
        const roundId = `round_e2e_${now}_${i}`;
        const textItemId = `text_e2e_${now}_${i}`;

        const dialogTurn = {
          id: turnId,
          sessionId: sid,
          kind: 'user_dialog',
          agentType: 'agentic',
          userMessage: {
            id: userMsgId,
            content: `E2E test message ${i + 1}: This is a synthetic user message to populate the conversation for whitespace bug reproduction. `.repeat(3),
            timestamp: now - (count - i) * 60000,
          },
          modelRounds: [
            {
              id: roundId,
              index: 0,
              items: [
                {
                  id: textItemId,
                  type: 'text',
                  timestamp: now - (count - i) * 60000 + 1000,
                  status: 'completed',
                  content: `E2E test response ${i + 1}: This is a synthetic AI response to create virtual items in the message list. `.repeat(5) + '\n\n' + 'Here is some additional content to make the message taller and more realistic. '.repeat(8),
                  isStreaming: false,
                  isMarkdown: true,
                },
              ],
              isStreaming: false,
              isComplete: true,
              status: 'completed',
              startTime: now - (count - i) * 60000 + 500,
              endTime: now - (count - i) * 60000 + 5000,
              durationMs: 4500,
            },
          ],
          status: 'completed',
          startTime: now - (count - i) * 60000,
          endTime: now - (count - i) * 60000 + 5000,
          success: true,
          finishReason: 'stop',
        };

        fcStore.addDialogTurn(sid, dialogTurn);
      }

      // Force sync to modern store
      const session = fcStore.getState().sessions.get(sid);
      if (session) {
        modStore.getState().setActiveSession(session);
      }

      return true;
    } catch (e: any) {
      console.error('[L1-#1176] populateSessionWithTurns error:', e?.message || e);
      return false;
    }
  }, sessionId, turnCount);
}

// ---------------------------------------------------------------------------
// Expose store singletons on window for E2E access
// ---------------------------------------------------------------------------
async function exposeStoreReferences(): Promise<boolean> {
  return browser.execute(async () => {
    try {
      const { flowChatStore } = await import('/src/flow_chat/store/FlowChatStore.ts');
      const { useModernFlowChatStore } = await import('/src/flow_chat/store/modernFlowChatStore.ts');

      (window as any).__E2E_FC_STORE__ = flowChatStore;
      (window as any).__E2E_MOD_STORE__ = useModernFlowChatStore;

      return true;
    } catch (e: any) {
      console.error('[L1-#1176] exposeStoreReferences error:', e?.message || e);
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Populate session using async dynamic imports (fallback)
// ---------------------------------------------------------------------------
async function populateSessionAsync(sessionId: string, turnCount: number): Promise<boolean> {
  return browser.execute(async (sid: string, count: number) => {
    try {
      const { flowChatStore } = await import('/src/flow_chat/store/FlowChatStore.ts');
      const { useModernFlowChatStore } = await import('/src/flow_chat/store/modernFlowChatStore.ts');

      const now = Date.now();
      for (let i = 0; i < count; i++) {
        const turnId = `dialog_e2e_${now}_${i}_${Math.random().toString(36).substr(2, 9)}`;
        const userMsgId = `user_e2e_${now}_${i}`;
        const roundId = `round_e2e_${now}_${i}`;
        const textItemId = `text_e2e_${now}_${i}`;

        const dialogTurn = {
          id: turnId,
          sessionId: sid,
          kind: 'user_dialog',
          agentType: 'agentic',
          userMessage: {
            id: userMsgId,
            content: `E2E test message ${i + 1}: This is a synthetic user message to populate the conversation for whitespace bug reproduction. `.repeat(3),
            timestamp: now - (count - i) * 60000,
          },
          modelRounds: [
            {
              id: roundId,
              index: 0,
              items: [
                {
                  id: textItemId,
                  type: 'text',
                  timestamp: now - (count - i) * 60000 + 1000,
                  status: 'completed',
                  content: `E2E test response ${i + 1}: This is a synthetic AI response to create virtual items in the message list. `.repeat(5) + '\n\n' + 'Here is some additional content to make the message taller and more realistic. '.repeat(8),
                  isStreaming: false,
                  isMarkdown: true,
                },
              ],
              isStreaming: false,
              isComplete: true,
              status: 'completed',
              startTime: now - (count - i) * 60000 + 500,
              endTime: now - (count - i) * 60000 + 5000,
              durationMs: 4500,
            },
          ],
          status: 'completed',
          startTime: now - (count - i) * 60000,
          endTime: now - (count - i) * 60000 + 5000,
          success: true,
          finishReason: 'stop',
        };

        flowChatStore.addDialogTurn(sid, dialogTurn);
      }

      // Force sync: get the UPDATED session from flowChatStore (with new dialogTurns ref)
      // then push it to modernFlowChatStore so its owned projector recalculates
      const updatedSession = flowChatStore.getState().sessions.get(sid);
      if (updatedSession) {
        useModernFlowChatStore.getState().setActiveSession(updatedSession);
      }

      // Verify virtualItems are now non-empty
      const virtualItemCount = useModernFlowChatStore.getState().virtualItems.length;
      console.log('[L1-#1176] Virtual items count after populate:', virtualItemCount);

      return virtualItemCount > 0;
    } catch (e: any) {
      console.error('[L1-#1176] populateSessionAsync error:', e?.message || e);
      return false;
    }
  }, sessionId, turnCount);
}

describe('L1 Chat Scroll Whitespace (#1176)', () => {
  let header: Header;
  let startupPage: StartupPage;
  let hasWorkspace = false;
  let sessionId: string | null = null;

  before(async () => {
    console.log('[L1-#1176] Starting scroll-whitespace reproduction test');
    header = new Header();
    startupPage = new StartupPage();

    await browser.pause(3000);
    await header.waitForLoad();

    // Open workspace the same way l1-chat-input.spec.ts does
    const startupVisible = await startupPage.isVisible();
    hasWorkspace = !startupVisible;

    if (!hasWorkspace) {
      console.log('[L1-#1176] No workspace open - opening current test workspace');
      hasWorkspace = await openWorkspace();
    }

    if (hasWorkspace) {
      // First check if chat input already exists (session already open)
      const chatInput = await $('[data-testid="chat-input-container"]');
      if (await chatInput.isExisting()) {
        console.log('[L1-#1176] Chat input already present - session already open');
        // Get the existing session ID
        sessionId = await browser.execute(async () => {
          const { flowChatStore } = await import('/src/flow_chat/store/FlowChatStore.ts');
          return flowChatStore.getState().activeSessionId || null;
        });
      } else {
        // Strategy 1: Use FlowChatManager (the proper way the app creates sessions)
        console.log('[L1-#1176] Attempting FlowChatManager.createChatSession');
        sessionId = await createCodeSessionViaFlowChatManager();
        console.log('[L1-#1176] FlowChatManager result:', sessionId);

        if (sessionId) {
          await browser.pause(3000);
        }

        // Check if chat input appeared
        let chatInputAfter = await $('[data-testid="chat-input-container"]');
        if (!(await chatInputAfter.isExisting())) {
          // Strategy 2: Dispatch the toolbar event that AppLayout listens to
          console.log('[L1-#1176] Trying toolbar-create-session event');
          await browser.execute(() => {
            window.dispatchEvent(new CustomEvent('toolbar-create-session', { detail: { mode: 'code' } }));
          });
          await browser.pause(3000);

          // Try to get the session ID
          sessionId = await browser.execute(async () => {
            const { flowChatStore } = await import('/src/flow_chat/store/FlowChatStore.ts');
            return flowChatStore.getState().activeSessionId || null;
          });
        }

        // Final check
        const chatInputFinal = await $('[data-testid="chat-input-container"]');
        if (!(await chatInputFinal.isExisting())) {
          console.error('[L1-#1176] Could not open Code session - tests will skip');
          await dumpDomDiagnostics();
          hasWorkspace = false;
        }
      }
    }

    if (hasWorkspace && sessionId) {
      // Expose store references on window for synchronous access
      console.log('[L1-#1176] Exposing store references...');
      await exposeStoreReferences();
      await browser.pause(500);

      // Populate the session with synthetic dialog turns so VirtualMessageList renders
      console.log('[L1-#1176] Populating session with synthetic dialog turns...');
      let populated = await populateSessionWithTurns(sessionId, 5);

      if (!populated) {
        // Fallback: try async approach
        console.log('[L1-#1176] Sync populate failed, trying async approach...');
        populated = await populateSessionAsync(sessionId, 5);
      }

      console.log('[L1-#1176] Populate result:', populated);

      // Wait for React to re-render with the new virtual items
      await browser.pause(3000);

      // Dump diagnostics to verify VirtualMessageList is now rendered
      await dumpDomDiagnostics();

      // Verify VirtualMessageList is now in the DOM
      const vmlExists = await browser.execute(() => {
        return !!document.querySelector('.virtual-message-list');
      });
      if (!vmlExists) {
        console.error('[L1-#1176] VirtualMessageList still not rendered after populating turns');
        // Try one more time with a longer wait
        await browser.pause(5000);
        await dumpDomDiagnostics();
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Find the VirtualMessageList React component instance via React fiber traversal
   * and read its internal bottomReservationStateRef.
   */
  async function findVirtualMessageListState(): Promise<{
    found: boolean;
    collapsePx: number;
    pinPx: number;
    footerHeight: number;
    scrollHeight: number;
    clientHeight: number;
    maxScrollTop: number;
  }> {
    return browser.execute(() => {
      // Find the scroller DOM element
      const scrollerEl = document.querySelector('[data-flowchat-scroller]') as HTMLElement | null;
      const footer = document.querySelector('.message-list-footer') as HTMLElement | null;

      // Try to find the React component instance via fiber
      let stateRef: any = null;
      const rootCandidates = [
        scrollerEl,
        document.querySelector('.virtual-message-list'),
      ];

      for (const root of rootCandidates) {
        if (!root || stateRef) continue;
        const keys = Object.keys(root);
        const reactKey = keys.find(k => k.startsWith('__reactFiber')) ||
                         keys.find(k => k.startsWith('__reactInternal'));
        if (!reactKey) continue;

        // @ts-ignore
        let fiber = root[reactKey];
        let safety = 0;
        while (fiber && safety < 300) {
          const sn = fiber.stateNode;
          if (sn && typeof sn === 'object') {
            // VirtualMessageList stores refs on the stateNode (function component via forwardRef)
            if (sn.bottomReservationStateRef) {
              stateRef = sn.bottomReservationStateRef;
              break;
            }
            // Also check memoizedState (hooks) for the ref
            let hook = fiber.memoizedState;
            let hookSafety = 0;
            while (hook && hookSafety < 50) {
              if (hook.memoizedState && typeof hook.memoizedState === 'object') {
                const ms = hook.memoizedState;
                if (ms.current && typeof ms.current === 'object' && 'collapse' in ms.current && 'pin' in ms.current) {
                  stateRef = hook.memoizedState;
                  break;
                }
              }
              hook = hook.next;
              hookSafety++;
            }
            if (stateRef) break;
          }
          fiber = fiber.return;
          safety++;
        }
      }

      const result = {
        found: false as boolean,
        collapsePx: 0,
        pinPx: 0,
        footerHeight: footer ? footer.offsetHeight : 0,
        scrollHeight: scrollerEl ? scrollerEl.scrollHeight : 0,
        clientHeight: scrollerEl ? scrollerEl.clientHeight : 0,
        maxScrollTop: scrollerEl ? Math.max(0, scrollerEl.scrollHeight - scrollerEl.clientHeight) : 0,
      };

      if (stateRef && stateRef.current) {
        result.found = true;
        result.collapsePx = stateRef.current.collapse?.px || 0;
        result.pinPx = stateRef.current.pin?.px || 0;
      }

      return result;
    });
  }

  /**
   * Find the VirtualMessageList component's bottomReservationStateRef via React fiber hooks.
   * In function components, refs are stored in the hooks chain (fiber.memoizedState),
   * not in fiber.stateNode (which only exists for class components).
   *
   * VirtualMessageList uses forwardRef, so the ref object is accessible via
   * the imperativeHandle hook in the fiber hooks chain.
   */
  async function findComponentInstance(): Promise<boolean> {
    return browser.execute(() => {
      // Strategy: Walk the fiber tree from DOM elements inside VirtualMessageList,
      // then traverse the hooks chain to find bottomReservationStateRef.
      const rootCandidates = [
        document.querySelector('[data-flowchat-scroller]'),
        document.querySelector('.virtual-message-list'),
        document.querySelector('.message-list-footer'),
      ];

      for (const root of rootCandidates) {
        if (!root) continue;
        const keys = Object.keys(root);
        const reactKey = keys.find(k => k.startsWith('__reactFiber')) ||
                         keys.find(k => k.startsWith('__reactInternal'));
        if (!reactKey) continue;

        // Walk up the fiber tree from this DOM element
        // @ts-ignore
        let fiber = root[reactKey];
        let safety = 0;
        while (fiber && safety < 500) {
          // Check hooks chain for the ref
          let hook = fiber.memoizedState;
          let hookSafety = 0;
          while (hook && hookSafety < 100) {
            const ms = hook.memoizedState;
            // useRef hooks store { current: value } in memoizedState
            if (ms && typeof ms === 'object' && ms.current && typeof ms.current === 'object') {
              // Check if this ref holds a BottomReservationState
              if ('collapse' in ms.current && 'pin' in ms.current) {
                (window as any).__E2E_BOTTOM_RESERVATION_REF__ = ms;
                return true;
              }
            }
            hook = hook.next;
            hookSafety++;
          }
          fiber = fiber.return;
          safety++;
        }
      }
      return false;
    });
  }

  /**
   * Directly add collapse compensation by manipulating the footer DOM.
   * This simulates the effect of collapse.px accumulation that happens in the bug:
   * footerHeightPx = inputStackFooterPx + collapse.px + pin.px
   *
   * In the real bug, collapse.px accumulates without being consumed, growing the
   * footer height and creating excess whitespace at the bottom of the message list.
   */
  async function addCollapseCompensation(amount: number): Promise<boolean> {
    return browser.execute((px: number) => {
      const footer = document.querySelector('.message-list-footer') as HTMLElement | null;
      if (!footer) return false;

      // Try to use the React ref if available (for complete bug reproduction)
      const ref = (window as any).__E2E_BOTTOM_RESERVATION_REF__;
      if (ref && ref.current && ref.current.collapse) {
        const prevPx = ref.current.collapse.px || 0;
        ref.current = {
          ...ref.current,
          collapse: {
            ...ref.current.collapse,
            px: prevPx + px,
          },
        };
      }

      // Directly grow the footer height to simulate the accumulated compensation
      // This matches what applyFooterCompensationNow does in the real code:
      //   footerHeightPx = inputStackFooterPx + compensationPx
      const currentHeight = parseInt(footer.style.height || '0', 10) || footer.offsetHeight;
      const newHeight = currentHeight + px;
      footer.style.height = `${newHeight}px`;
      footer.style.minHeight = `${newHeight}px`;

      // Force layout reflow
      void footer.offsetHeight;

      const scroller = document.querySelector('[data-flowchat-scroller]') as HTMLElement | null;
      if (scroller) void scroller.scrollHeight;

      return true;
    }, amount);
  }

  /**
   * Read current scroller geometry.
   */
  async function getScrollerGeometry(): Promise<{
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    maxScrollTop: number;
  }> {
    return browser.execute(() => {
      const el = (
        document.querySelector('[data-flowchat-scroller]') ||
        document.querySelector('.virtual-message-list__static-scroller') ||
        document.querySelector('.virtual-message-list')
      ) as HTMLElement | null;

      if (!el) return { scrollTop: 0, scrollHeight: 0, clientHeight: 0, maxScrollTop: 0 };
      return {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        maxScrollTop: Math.max(0, el.scrollHeight - el.clientHeight),
      };
    });
  }

  /**
   * Get footer height.
   */
  async function getFooterHeight(): Promise<number> {
    return browser.execute(() => {
      const footer = document.querySelector('.message-list-footer') as HTMLElement | null;
      return footer ? footer.offsetHeight : 0;
    });
  }

  // ---------------------------------------------------------------------------
  // Test 1: Verify session has dialog turns and VirtualMessageList renders
  // ---------------------------------------------------------------------------
  it('should have a session with dialog turns and VirtualMessageList rendered', async function () {
    if (!hasWorkspace) { this.skip(); return; }

    // Verify VirtualMessageList is in the DOM
    const vmlExists = await browser.execute(() => {
      return !!document.querySelector('.virtual-message-list');
    });
    expect(vmlExists).toBe(true);

    // Verify virtual items count > 0
    const virtualItemCount = await browser.execute(() => {
      const el = document.querySelector('[data-virtual-item-count]');
      return el ? parseInt(el.getAttribute('data-virtual-item-count') || '0', 10) : 0;
    });
    console.log('[L1-#1176] Virtual item count:', virtualItemCount);
    expect(virtualItemCount).toBeGreaterThan(0);

    // Verify scroller exists
    const scrollerExists = await browser.execute(() => {
      return !!document.querySelector('[data-flowchat-scroller]');
    });
    expect(scrollerExists).toBe(true);

    // Verify footer exists
    const footerExists = await browser.execute(() => {
      return !!document.querySelector('.message-list-footer');
    });
    expect(footerExists).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Helper: Set the last dialog turn's streaming state.
  // IMPORTANT: We must create a completely NEW session object (not just mutate
  // dialogTurns) because Zustand's useActiveSession() uses Object.is reference
  // comparison. If we pass the same session reference, the selector won't fire
  // and VirtualMessageList won't re-render, so isStreamingOutput won't change.
  // ---------------------------------------------------------------------------
  async function setLastTurnStreamingState(
    sid: string,
    streaming: boolean,
  ): Promise<boolean> {
    return browser.execute(async (sessionId: string, isStreaming: boolean) => {
      const { flowChatStore } = await import('/src/flow_chat/store/FlowChatStore.ts');
      const { useModernFlowChatStore } = await import('/src/flow_chat/store/modernFlowChatStore.ts');

      const session = flowChatStore.getState().sessions.get(sessionId);
      if (!session || session.dialogTurns.length === 0) return false;

      // Build completely new objects to ensure reference changes
      const newTurns = session.dialogTurns.map((turn, i) => {
        if (i !== session.dialogTurns.length - 1) return turn;
        return {
          ...turn,
          modelRounds: turn.modelRounds.map(r => ({
            ...r,
            isStreaming: isStreaming,
            status: isStreaming ? 'processing' : 'completed',
          })),
          status: isStreaming ? 'processing' : 'completed',
        };
      });

      // Create a NEW session object (spread to get new reference)
      const newSession = {
        ...session,
        dialogTurns: newTurns,
      };

      // Update flowChatStore's session too
      flowChatStore.getState().sessions.set(sessionId, newSession);

      // Push the new reference to the modern store
      useModernFlowChatStore.getState().setActiveSession(newSession);
      return true;
    }, sid, streaming);
  }

  // ---------------------------------------------------------------------------
  // Test 2: Verify streaming-stop cleanup drains collapse compensation (#1176 fix)
  // ---------------------------------------------------------------------------
  // The fix (issue #1176) adds a useEffect that drains any remaining
  // collapse.px when streaming transitions from true → false. This test
  // injects collapse.px through the React fiber ref, simulates a streaming
  // session ending, and verifies the compensation is cleared.
  // ---------------------------------------------------------------------------
  it('should drain collapse compensation when streaming stops (fix #1176)', async function () {
    if (!hasWorkspace) { this.skip(); return; }

    // Find and cache the component instance via React fiber
    const found = await findComponentInstance();
    console.log('[L1-#1176] Component instance found:', found);

    // Record baseline footer height
    const baselineFooter = await getFooterHeight();
    console.log('[L1-#1176] Baseline footer:', baselineFooter);

    // Step 1: Inject collapse compensation through the React fiber ref
    // This is the SAME ref the component reads internally
    const injected = await browser.execute((px: number) => {
      const ref = (window as any).__E2E_BOTTOM_RESERVATION_REF__;
      if (!ref || !ref.current || !ref.current.collapse) return false;

      ref.current = {
        ...ref.current,
        collapse: {
          ...ref.current.collapse,
          px: px,
          floorPx: 0,
        },
      };

      // Apply to DOM the same way the component does (mimics applyFooterCompensationNow)
      const footer = document.querySelector('.message-list-footer') as HTMLElement | null;
      if (footer) {
        const baseHeight = parseInt(footer.style.height || '0', 10) || footer.offsetHeight;
        footer.style.height = `${baseHeight + px}px`;
        footer.style.minHeight = `${baseHeight + px}px`;
        void footer.offsetHeight;
      }

      return true;
    }, 500);
    expect(injected).toBe(true);

    await browser.pause(200);
    const afterInjectFooter = await getFooterHeight();
    console.log('[L1-#1176] After injecting 500px collapse — footer:', afterInjectFooter);
    expect(afterInjectFooter).toBeGreaterThanOrEqual(baselineFooter + 400);

    // Step 2: Set streaming=true (creates baseline for true→false transition)
    const streamingStarted = await setLastTurnStreamingState(sessionId!, true);
    if (!streamingStarted) {
      console.log('[L1-#1176] Could not set streaming=true, skipping cleanup verification');
      this.skip();
      return;
    }

    // Wait for React to process the streaming=true state
    await browser.pause(500);

    // Step 3: Set streaming=false to trigger the streaming-stop cleanup useEffect
    await setLastTurnStreamingState(sessionId!, false);

    // Wait for the streaming-stop useEffect to fire (runs after React commit)
    await browser.pause(1000);

    // Step 4: Verify collapse.px has been cleared by the fix
    const finalState = await findVirtualMessageListState();
    const finalFooter = await getFooterHeight();
    console.log('[L1-#1176] After streaming stop — state:', JSON.stringify(finalState),
      'footer:', finalFooter);

    // The fix should have cleared collapse.px to ~0
    if (finalState.found) {
      expect(finalState.collapsePx).toBeLessThan(10);
    }

    // The footer should have returned close to baseline (the injected 500px
    // should have been drained by the streaming-stop cleanup)
    expect(finalFooter).toBeLessThan(baselineFooter + 50);
  });

  // ---------------------------------------------------------------------------
  // Test 3: Verify footer does not grow unbounded after multiple streaming cycles
  // ---------------------------------------------------------------------------
  // This test simulates the full bug scenario: multiple streaming turns where
  // collapse.px could accumulate without being consumed. With the fix, each
  // streaming-stop should clear residual collapse.px, preventing unbounded growth.
  // ---------------------------------------------------------------------------
  it('should not accumulate footer whitespace across multiple streaming cycles (fix #1176)', async function () {
    if (!hasWorkspace) { this.skip(); return; }

    const found = await findComponentInstance();
    console.log('[L1-#1176] Component instance found:', found);

    const baselineFooter = await getFooterHeight();
    console.log('[L1-#1176] Baseline footer:', baselineFooter);

    // Simulate 3 streaming cycles, each injecting collapse compensation
    for (let cycle = 0; cycle < 3; cycle++) {
      // Start streaming
      await setLastTurnStreamingState(sessionId!, true);
      await browser.pause(300);

      // Inject compensation (simulating tool-card collapses during streaming)
      await browser.execute((px: number) => {
        const ref = (window as any).__E2E_BOTTOM_RESERVATION_REF__;
        if (!ref || !ref.current || !ref.current.collapse) return;

        ref.current = {
          ...ref.current,
          collapse: { ...ref.current.collapse, px: px, floorPx: 0 },
        };

        const footer = document.querySelector('.message-list-footer') as HTMLElement | null;
        if (footer) {
          const baseHeight = parseInt(footer.style.height || '0', 10) || footer.offsetHeight;
          footer.style.height = `${baseHeight + px}px`;
          footer.style.minHeight = `${baseHeight + px}px`;
          void footer.offsetHeight;
        }
      }, 300);

      await browser.pause(100);

      // Stop streaming (triggers the fix cleanup)
      await setLastTurnStreamingState(sessionId!, false);
      await browser.pause(500);
    }

    // After 3 streaming cycles with the fix, footer should NOT have accumulated
    // 900px of compensation. It should be close to baseline.
    const finalFooter = await getFooterHeight();
    console.log('[L1-#1176] After 3 streaming cycles — footer:', finalFooter,
      '(baseline:', baselineFooter, ')');

    // The fix ensures each streaming-stop clears residual collapse.px.
    // Footer should not grow more than a small delta from baseline.
    expect(finalFooter).toBeLessThan(baselineFooter + 100);
  });

  // ---------------------------------------------------------------------------
  // Test 4: Verify session switch resets the compensation (user workaround)
  // ---------------------------------------------------------------------------
  it('should reset collapse compensation when switching sessions', async function () {
    if (!hasWorkspace) { this.skip(); return; }

    // Step 1: Record the baseline footer height (inputStack only, no compensation)
    const baselineFooter = await getFooterHeight();
    console.log('[L1-#1176] Baseline footer (inputStack only):', baselineFooter);

    // Step 2: Add significant compensation to simulate the bug
    await addCollapseCompensation(2000);
    await browser.pause(200);

    const beforeFooter = await getFooterHeight();
    console.log('[L1-#1176] After adding 2000px compensation — footer:', beforeFooter);
    expect(beforeFooter).toBeGreaterThanOrEqual(baselineFooter + 2000 * 0.8);

    // Step 3: Create and switch to a new session
    await browser.execute(async () => {
      const { flowChatStore } = await import('/src/flow_chat/store/FlowChatStore.ts');
      const { useModernFlowChatStore } = await import('/src/flow_chat/store/modernFlowChatStore.ts');

      // Create a second session
      const newSessionId = `e2e-switch-${Date.now()}`;
      const wsPath = flowChatStore.getState().sessions.get(flowChatStore.getState().activeSessionId!)?.workspacePath;

      flowChatStore.createSession(
        newSessionId,
        { workspacePath: wsPath, modelName: 'primary' },
        undefined,
        'E2E Switch Test',
        128128,
        'agentic',
        wsPath,
        undefined,
        undefined,
        { text: 'E2E Switch Test', titleSource: 'text' },
      );

      // Add one turn to the new session so VirtualMessageList renders
      const turnId = `dialog_switch_${Date.now()}`;
      flowChatStore.addDialogTurn(newSessionId, {
        id: turnId,
        sessionId: newSessionId,
        kind: 'user_dialog',
        agentType: 'agentic',
        userMessage: {
          id: `user_switch_${Date.now()}`,
          content: 'Switch test message',
          timestamp: Date.now(),
        },
        modelRounds: [{
          id: `round_switch_${Date.now()}`,
          index: 0,
          items: [{
            id: `text_switch_${Date.now()}`,
            type: 'text',
            timestamp: Date.now(),
            status: 'completed',
            content: 'Switch test response',
            isStreaming: false,
            isMarkdown: true,
          }],
          isStreaming: false,
          isComplete: true,
          status: 'completed',
          startTime: Date.now(),
        }],
        status: 'completed',
        startTime: Date.now(),
      });

      // Switch to the new session
      flowChatStore.switchSession(newSessionId);

      // Force sync to modern store
      const session = flowChatStore.getState().sessions.get(newSessionId);
      if (session) {
        useModernFlowChatStore.getState().setActiveSession(session);
      }
    });

    await browser.pause(2000);

    // Step 4: After switching, the footer height should be reset
    // (back to baseline inputStack, the 2000px compensation should be gone)
    const afterFooter = await getFooterHeight();
    console.log('[L1-#1176] After session switch — footer:', afterFooter,
      '(should be close to baseline', baselineFooter, ')');

    // The footer should be back near the baseline (inputStack only)
    // The compensation should have been reset by the component remount
    expect(afterFooter).toBeLessThan(baselineFooter + 100);

    // Switch back to original session
    if (sessionId) {
      await browser.execute(async (sid: string) => {
        const { flowChatStore } = await import('/src/flow_chat/store/FlowChatStore.ts');
        const { useModernFlowChatStore } = await import('/src/flow_chat/store/modernFlowChatStore.ts');
        flowChatStore.switchSession(sid);
        const session = flowChatStore.getState().sessions.get(sid);
        if (session) {
          useModernFlowChatStore.getState().setActiveSession(session);
        }
      }, sessionId);
      await browser.pause(1000);
    }
  });

  afterEach(async function () {
    if (this.currentTest?.state === 'failed') {
      await saveFailureScreenshot(`l1-chat-scroll-whitespace-${this.currentTest.title}`);
    }
  });

  after(async () => {
    await saveScreenshot('l1-chat-scroll-whitespace-complete');
    console.log('[L1-#1176] Scroll-whitespace tests complete');
  });
});
