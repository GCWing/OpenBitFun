import { sessionAPI, type UsageContextCategory } from '@/infrastructure/api/service-api/SessionAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { openAgentCanvasTabForSession, useAgentCanvasStore } from '@/app/components/panels/content-canvas/stores/canvasStore';
import { flowChatStore } from '../store/FlowChatStore';
import { resolveSessionDriverId } from '../session-drivers/resolve';

const PREVIEW_FILE_NAMES: Record<UsageContextCategory, string> = {
  systemPrompt: 'system-prompt.md',
  toolDefinitions: 'tool-definitions.md',
  rules: 'rules.md',
  skills: 'skills.md',
  mcpTools: 'mcp-and-dynamic-tools.md',
  subagentDefinitions: 'subagent-definitions.md',
};

export async function openSessionContextPreview(params: {
  sessionId: string;
  reportSessionId: string;
  workspaceId?: string;
  title: string;
  category: UsageContextCategory;
  emptyContent: string;
}): Promise<'opened' | 'unavailable' | 'stale'> {
  const surface = getActiveSurfaceScope();
  const session = flowChatStore.getState().sessions.get(params.sessionId);
  const workspaceId = params.workspaceId || session?.workspaceId || session?.config?.workspaceId;
  // Dispatch reports belong to the target. Never read the controller's prompt cache.
  if (!workspaceId || params.sessionId !== params.reportSessionId
    || resolveSessionDriverId(params.sessionId, session) !== 'local') return 'unavailable';

  const report = await sessionAPI.getSessionUsageReport({
    sessionId: params.sessionId,
    workspaceId,
    includeHiddenSubagents: false,
    contextPreviewCategory: params.category,
    ...(params.category === 'systemPrompt' ? { includeSystemPromptPreview: true } : {}),
  });
  if (!surface.isCurrent()) return 'stale';
  if (report.sessionId !== params.sessionId) return 'unavailable';
  const snapshot = report.contextPreview;
  const legacy = !snapshot && params.category === 'systemPrompt' ? report.systemPromptPreview : undefined;
  const content = snapshot?.category === params.category && typeof snapshot.content === 'string'
    ? snapshot.content : legacy?.content?.trim() ? legacy.content : undefined;
  if (content === undefined) return 'unavailable';

  openAgentCanvasTabForSession(params.sessionId, {
    type: params.category === 'toolDefinitions' ? 'tool-definitions' : 'markdown-editor',
    title: params.title,
    data: params.category === 'toolDefinitions' ? { content, readOnly: true }
      : { initialContent: content.trim() ? content : params.emptyContent, fileName: PREVIEW_FILE_NAMES[params.category], readOnly: true },
    metadata: {
      duplicateCheckKey: params.category === 'systemPrompt' ? `session-system-prompt-${params.sessionId}`
        : `session-context-${params.category}-${params.sessionId}`,
      sessionId: params.sessionId,
      capturedAt: snapshot?.capturedAt,
      cachedAt: legacy?.cachedAt,
      resourceScope: { surfaceId: surface.surfaceId, workspaceId },
    },
  });
  if (useAgentCanvasStore.getState().scopeKey === params.sessionId && typeof window !== 'undefined') {
    window.dispatchEvent(new window.CustomEvent('expand-right-panel'));
  }
  return 'opened';
}
