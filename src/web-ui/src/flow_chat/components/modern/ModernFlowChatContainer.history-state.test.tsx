import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const componentSource = fs.readFileSync(
  path.resolve(__dirname, 'ModernFlowChatContainer.tsx'),
  'utf8',
);

describe('ModernFlowChatContainer natural navigation contract', () => {
  it('restores historical tails through natural end alignment', () => {
    expect(componentSource).toContain('scrollToTurnEnd(latestTurnId)');
    expect(componentSource).toContain('prepareTurnNavigation');
  });

  it('does not recreate sticky latest or pin reservation modes', () => {
    expect(componentSource).not.toContain('sticky-latest');
    expect(componentSource).not.toContain('pinTurnToTop');
    expect(componentSource).not.toContain('prepareTurnPinToTop');
  });

  it('keeps provisional mount snapshots and auto-tail placement out of session restoration', () => {
    expect(componentSource).toContain('viewportRestorePendingSessionIdRef');
    expect(componentSource).toContain('viewportRestorePendingSessionIdRef.current === snapshot.sessionId');
    expect(componentSource).toContain('onViewportRestoreSettled={handleViewportRestoreSettled}');
    expect(componentSource).toContain('viewportRestorePendingSessionId === sessionId');
  });

  it('dismisses a pending open shield when its global transition is cancelled', () => {
    expect(componentSource).toContain('subscribeHistorySessionOpenTransition');
    expect(componentSource).toContain("transition?.sessionId !== current.sessionId ? null : current");
  });

  it('uses settled presentation to release background history after paint', () => {
    expect(componentSource).not.toContain('isTurnTextRenderedInViewport');
    expect(componentSource).not.toContain('HISTORY_INITIAL_CONTENT_PAINT_MAX_ATTEMPTS');
    expect(componentSource).toContain('if (!isHistoryContentPresented) return;');
    expect(componentSource).toContain('scheduleAfterStartupPaint(releaseAfterPaint, { frameCount: 2 })');
    expect(componentSource).toContain('releaseSessionHistoryCompletionAfterInitialPaint(sessionId)');
  });
});
