import { createTab } from '@/shared/utils/tabUtils';
import type { PanelContent } from '@/app/components/panels/base/types';
import type { SessionUsageReport } from '@/infrastructure/api/service-api/SessionAPI';
import type { SessionUsagePanelTab } from '../components/usage/sessionUsagePanelTypes';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import {
  openAgentCanvasTabForSession,
  updateAgentCanvasTabsForSession,
} from '@/app/components/panels/content-canvas/stores/canvasStore';
import { useContentResourceStore } from '@/app/workbench/contentResourceStore';

export const SESSION_USAGE_PANEL_TYPE = 'session-usage' as const;

export interface SessionUsagePanelData {
  report: SessionUsageReport;
  markdown?: string;
  sessionId?: string;
  sessionTitle?: string;
  workspaceId?: string;
  workspacePath?: string;
  title?: string;
  initialTab?: SessionUsagePanelTab;
}

/** The request owns one session's side-panel tab, including while that session is hidden. */
export function beginSessionUsagePanel(params: {
  sessionId: string;
  sessionTitle?: string;
  workspaceId: string;
  workspacePath: string;
  title: string;
}) {
  const surface = getActiveSurfaceScope();
  const requestId = crypto.randomUUID();
  const duplicateCheckKey = `session-usage-live-${params.sessionId}`;
  const content: PanelContent = {
    type: SESSION_USAGE_PANEL_TYPE,
    title: params.title,
    data: { ...params, requestId, isLoading: true },
    metadata: {
      duplicateCheckKey,
      sessionId: params.sessionId,
      contentRole: SESSION_USAGE_PANEL_TYPE,
      resourceScope: {
        surfaceId: surface.surfaceId,
        workspaceId: params.workspaceId,
        workspacePath: params.workspacePath,
      },
    },
  };
  openAgentCanvasTabForSession(params.sessionId, content);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new window.CustomEvent('expand-right-panel'));
  }

  const update = (patch: { report?: SessionUsageReport; markdown?: string; error?: string }): boolean => {
    if (!surface.isCurrent()) return false;
    const replace = (previous: PanelContent): PanelContent | undefined => (
      previous.type === SESSION_USAGE_PANEL_TYPE && previous.data?.requestId === requestId
        ? { ...previous, data: { ...previous.data, ...patch, isLoading: false } }
        : undefined
    );
    let updated = updateAgentCanvasTabsForSession(params.sessionId, replace);
    // A pending panel can be moved into a main workbench tab before it completes.
    const resources = useContentResourceStore.getState();
    for (const resource of Object.values(resources.resources)) {
      if (resource.scope.surfaceId !== surface.surfaceId) continue;
      const next = replace(resource.content);
      if (!next) continue;
      resources.update(resource.id, { content: next });
      updated = true;
    }
    return updated;
  };

  return {
    isCurrent: surface.isCurrent,
    complete: (report: SessionUsageReport, markdown: string) => update({ report, markdown }),
    fail: (error: string) => update({ error }),
  };
}

export interface SessionUsagePanelMetadata {
  duplicateCheckKey: string;
  reportId: string;
  sessionId: string;
  contentRole: 'session-usage';
}

export const getSessionUsageDuplicateKey = (reportId: string) => `session-usage-${reportId}`;

export function buildSessionUsagePanelContent(params: SessionUsagePanelData): PanelContent {
  return {
    type: SESSION_USAGE_PANEL_TYPE,
    // Caller supplies the localized title so this panel helper does not eagerly
    // initialize the i18n singleton in message-rendering tests.
    title: params.title ?? 'Context Usage Report',
    data: params,
    metadata: {
      duplicateCheckKey: getSessionUsageDuplicateKey(params.report.reportId),
      reportId: params.report.reportId,
      sessionId: params.sessionId ?? params.report.sessionId,
      contentRole: 'session-usage',
    } satisfies SessionUsagePanelMetadata,
  };
}

export function openSessionUsagePanel(params: SessionUsagePanelData & { expand?: boolean }): void {
  const content = buildSessionUsagePanelContent(params);

  if (params.expand !== false && typeof window !== 'undefined') {
    window.dispatchEvent(new window.CustomEvent('expand-right-panel'));
  }

  createTab({
    type: content.type,
    title: content.title,
    data: content.data,
    metadata: content.metadata,
    checkDuplicate: true,
    duplicateCheckKey: content.metadata?.duplicateCheckKey,
    replaceExisting: !!params.initialTab,
    mode: 'agent',
  });
}
