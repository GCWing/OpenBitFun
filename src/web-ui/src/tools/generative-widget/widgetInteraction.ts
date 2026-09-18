import { globalEventBus } from '@/infrastructure/event-bus';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { createLogger } from '@/shared/utils/logger';
import path from 'path-browserify';
import { fileTabManager } from '@/shared/services/FileTabManager';
import { notificationService } from '@/shared/notification-system';

const log = createLogger('widgetInteraction');

export type WidgetBridgeEvent =
  | {
      type: 'openbitfun-widget:prompt';
      widgetId?: string;
      text?: string;
    }
  | {
      type: 'openbitfun-widget:event';
      widgetId?: string;
      payload?: unknown;
    }
  | {
      type: 'openbitfun-widget:open-file';
      widgetId?: string;
      filePath?: string;
      line?: number;
      column?: number;
      lineEnd?: number;
      nodeType?: string;
    };

export interface WidgetInteractionDetail {
  sessionId: string | null;
  widgetId?: string;
  source: 'tool-card' | 'panel';
  interactionType: 'prompt' | 'event';
  text?: string;
  payload?: unknown;
}

function getActiveSessionId(): string | null {
  return flowChatStore.getState().activeSessionId;
}

function getActiveWorkspacePath(): string | undefined {
  return flowChatStore.getActiveSession()?.workspacePath;
}

function getActiveWorkspaceId(): string | undefined {
  const session = flowChatStore.getActiveSession();
  return session?.workspaceId || session?.config?.workspaceId || undefined;
}

function stringifyPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function emitInteraction(detail: WidgetInteractionDetail): void {
  globalEventBus.emit<WidgetInteractionDetail>('widget:interaction', detail, 'widgetInteraction');
}

function normalizeFileTarget(filePath: string, workspacePath?: string): string {
  const isWindowsAbsolutePath = /^[A-Za-z]:[\\/]/.test(filePath);
  if (isWindowsAbsolutePath || path.isAbsolute(filePath) || !workspacePath) {
    return filePath;
  }

  return path.join(workspacePath, filePath);
}

export function handleWidgetBridgeEvent(
  event: WidgetBridgeEvent | null | undefined,
  source: 'tool-card' | 'panel',
): void {
  if (!event) return;

  const sessionId = getActiveSessionId();

  if (event.type === 'openbitfun-widget:prompt') {
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (!text) return;

    emitInteraction({
      sessionId,
      widgetId: event.widgetId,
      source,
      interactionType: 'prompt',
      text,
    });

    void flowChatManager.sendMessage(text, sessionId ?? undefined).catch((error) => {
      log.warn('Auto-send from widget prompt failed, falling back to chat input', {
        sessionId,
        widgetId: event.widgetId,
        error,
      });
      globalEventBus.emit('fill-chat-input', { content: text }, 'widgetInteraction');
    });
    return;
  }

  if (event.type === 'openbitfun-widget:open-file') {
    const filePath = typeof event.filePath === 'string' ? event.filePath.trim() : '';
    if (!filePath) return;

    const sessionId = getActiveSessionId();
    const workspacePath = getActiveWorkspacePath();
    const workspaceId = getActiveWorkspaceId();
    const absoluteFilePath = normalizeFileTarget(filePath, workspacePath);
    const line = typeof event.line === 'number' && event.line > 0 ? event.line : undefined;
    const column = typeof event.column === 'number' && event.column > 0 ? event.column : undefined;
    const lineEnd = typeof event.lineEnd === 'number' && event.lineEnd >= (line ?? 1) ? event.lineEnd : undefined;

    emitInteraction({
      sessionId,
      widgetId: event.widgetId,
      source,
      interactionType: 'event',
      payload: {
        action: 'open-file',
        filePath: absoluteFilePath,
        line,
        column,
        lineEnd,
        nodeType: event.nodeType,
      },
    });

    try {
      if (line && lineEnd && lineEnd > line) {
        fileTabManager.openFile({
          filePath: absoluteFilePath,
          workspaceId,
          workspacePath,
          jumpToRange: { start: line, end: lineEnd },
          mode: 'agent',
        });
      } else if (line) {
        fileTabManager.openFileAndJump(absoluteFilePath, line, column, {
          workspaceId,
          workspacePath,
          mode: 'agent',
        });
      } else {
        fileTabManager.openFile({
          filePath: absoluteFilePath,
          workspaceId,
          workspacePath,
          mode: 'agent',
        });
      }
    } catch (error) {
      log.error('Widget file navigation failed', {
        source,
        sessionId,
        widgetId: event.widgetId,
        filePath: absoluteFilePath,
        error,
      });
      notificationService.error(`Unable to open file: ${absoluteFilePath}`);
    }
    return;
  }

  if (event.type === 'openbitfun-widget:event' && event.payload !== undefined) {
    emitInteraction({
      sessionId,
      widgetId: event.widgetId,
      source,
      interactionType: 'event',
      payload: event.payload,
    });

    const payloadText = stringifyPayload(event.payload);
    globalEventBus.emit(
      'fill-chat-input',
      {
        content: `Widget interaction:\n${payloadText}`,
      },
      'widgetInteraction',
    );
  }
}
