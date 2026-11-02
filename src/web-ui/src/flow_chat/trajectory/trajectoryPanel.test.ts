// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '../types/flow-chat';
import type { PanelContent } from '@/shared/types/panelContent';
import type { TrajectoryRangeSummary } from './trajectoryRange';
const mocks = vi.hoisted(() => ({ open: vi.fn(), updateTabs: vi.fn(), update: vi.fn(), resources: {} as Record<string, any> }));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({ getActiveSurfaceScope: () => ({ surfaceId: 'peer:a' }) }));
vi.mock('@/app/components/panels/content-canvas/stores/canvasStore', () => ({ openAgentCanvasTabForSession: mocks.open, updateAgentCanvasTabsForSession: mocks.updateTabs }));
vi.mock('@/app/workbench/contentResourceStore', () => ({ useContentResourceStore: { getState: () => ({ resources: mocks.resources, update: mocks.update }) } }));
import { openTrajectoryPanel, showTrajectoryRange } from './trajectoryPanel';
const session = { sessionId: 's', workspaceId: 'remote', workspacePath: '/project' } as Session;
const range = { start: { id: 'a' }, end: { id: 'b' }, counts: { user: 1, model: 1, tool: 1, errors: 0 } } as TrajectoryRangeSummary;
beforeEach(() => { mocks.open.mockClear(); mocks.update.mockClear(); mocks.resources = {}; });
it('reuses the same session-scoped panel key for node and range selection', () => {
  openTrajectoryPanel(session, range.start, '', 'Details', 'v');
  showTrajectoryRange(session, range, 'Range', true, 'v');
  const first = mocks.open.mock.calls[0][1] as PanelContent;
  const second = mocks.open.mock.calls[1][1] as PanelContent;
  expect(first.metadata?.duplicateCheckKey).toBe(second.metadata?.duplicateCheckKey);
  expect(first.metadata?.resourceScope).toMatchObject({ surfaceId: 'peer:a', workspaceId: 'remote', workspacePath: '/project' });
});
it('passive range changes never modify another session or device resource', () => {
  for (const [id, sessionId, surfaceId] of [['own', 's', 'peer:a'], ['other-session', 'other', 'peer:a'], ['other-device', 's', 'peer:b']]) {
    mocks.resources[id] = { id, scope: { surfaceId }, content: { type: 'session-trajectory', title: 'Range', data: { sessionId, surfaceId, range } } };
  }
  showTrajectoryRange(session, range, 'Range', false, 'v');
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.update).toHaveBeenCalledTimes(1);
  expect(mocks.update.mock.calls[0][0]).toBe('own');
});
