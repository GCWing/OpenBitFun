/**
 * Shared service managing plan build state across components.
 *
 * Centralizes build-state tracking, TodoWrite → file sync, and subscriber
 * notifications so that PlanDisplay (chat card) and PlanViewer (editor)
 * stay in sync regardless of mount/unmount timing.
 */

import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { createLogger } from '@/shared/utils/logger';
import {
  parsePlanMarkdown,
  serializePlanMarkdown,
  type PlanTodo,
} from '@/shared/plan/planDocument';

const log = createLogger('PlanBuildStateService');

function yamlFrontmatter(content: string): string {
  return content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1].trim() ?? '';
}

export interface PlanBuildStateEvent {
  type: 'build-started' | 'build-completed' | 'build-cancelled' | 'build-stopped' | 'todos-updated';
  /** Whether the plan is still building after this event. */
  isBuilding: boolean;
  /** Updated todo list (present for todos-updated and build-completed). */
  updatedTodos?: PlanTodo[];
  /** Updated YAML frontmatter string (present for todos-updated and build-completed). */
  updatedFrontmatter?: string;
  /** Plan markdown content after frontmatter (present for todos-updated and build-completed). */
  planContent?: string;
}

export type BuildStateCallback = (event: PlanBuildStateEvent) => void;

interface BuildEntry {
  sessionId: string;
  turnId: string;
  todoIds: Set<string>;
  /** Original file path (preserves platform separators for API calls). */
  planFilePath: string;
  /** Workspace that owns the plan file; routes file IO when present. */
  workspaceId?: string;
  workspacePath: string;
  remoteConnectionId?: string;
  startedAt: number;
}

export interface PlanFileRef {
  planFilePath: string;
  /**
   * Workspace identity. When present it keys build state and routes file IO;
   * the path and connection fields below are then IO projections only and
   * serve pre-ID callers that cannot supply a workspace ID.
   */
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
}

export interface StartPlanBuildRequest extends PlanFileRef {
  sessionId: string;
  todoIds: string[];
}

type PlanFileTarget = string | PlanFileRef;

class PlanBuildStateService {
  private static instance: PlanBuildStateService;

  /** Active builds keyed by normalized planFilePath. */
  private buildingPlans = new Map<string, BuildEntry>();

  /** Subscribers keyed by normalized planFilePath. */
  private subscribers = new Map<string, Set<BuildStateCallback>>();

  /** Files currently being written (suppresses watcher reloads). */
  private writingFiles = new Set<string>();

  private constructor() {
    this.setupGlobalListeners();
  }

  static getInstance(): PlanBuildStateService {
    if (!PlanBuildStateService.instance) {
      PlanBuildStateService.instance = new PlanBuildStateService();
    }
    return PlanBuildStateService.instance;
  }

  // ==================== Public API ====================

  /** Mark a plan as building and return the turn ID that must own the build. */
  startBuild(request: StartPlanBuildRequest): string | null {
    const todoIds = request.todoIds.filter(id => id.trim().length > 0);
    if (todoIds.length === 0) {
      log.warn('Ignored plan build without valid todo IDs', {
        planFilePath: request.planFilePath,
        sessionId: request.sessionId,
      });
      return null;
    }

    const turnId = `dialog_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const key = this.targetKey(request);
    this.buildingPlans.set(key, {
      sessionId: request.sessionId,
      turnId,
      todoIds: new Set(todoIds),
      planFilePath: request.planFilePath,
      workspaceId: request.workspaceId?.trim() || undefined,
      workspacePath: request.workspacePath ?? '',
      remoteConnectionId: request.remoteConnectionId,
      startedAt: Date.now(),
    });
    this.notify(key, { type: 'build-started', isBuilding: true });
    return turnId;
  }

  /** Check whether a plan is currently building. */
  isBuildActive(target: PlanFileTarget): boolean {
    return this.buildingPlans.has(this.targetKey(target));
  }

  /** Cancel a build (e.g. on error) and notify subscribers. */
  cancelBuild(target: PlanFileTarget): void {
    const key = this.targetKey(target);
    if (this.buildingPlans.has(key)) {
      this.buildingPlans.delete(key);
      this.notify(key, { type: 'build-cancelled', isBuilding: false });
    }
  }

  /**
   * Subscribe to build-state changes for a plan file.
   * Returns an unsubscribe function.
   */
  subscribe(target: PlanFileTarget, callback: BuildStateCallback): () => void {
    const key = this.targetKey(target);
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    this.subscribers.get(key)!.add(callback);

    return () => {
      const subs = this.subscribers.get(key);
      if (subs) {
        subs.delete(callback);
        if (subs.size === 0) {
          this.subscribers.delete(key);
        }
      }
    };
  }

  /** Mark a file as being written to suppress watcher reloads. */
  markFileWriting(target: PlanFileTarget): void {
    const key = this.targetKey(target);
    this.writingFiles.add(key);
    setTimeout(() => this.writingFiles.delete(key), 1000);
  }

  /** Check whether a file is currently being written. */
  isFileWriting(target: PlanFileTarget): boolean {
    return this.writingFiles.has(this.targetKey(target));
  }

  // ==================== Internal ====================

  private normalizePath(path: string): string {
    return path.replace(/\\/g, '/');
  }

  private targetKey(target: PlanFileTarget): string {
    if (typeof target === 'string') {
      return `local::${this.normalizePath(target)}`;
    }
    const workspaceId = target.workspaceId?.trim();
    if (workspaceId) {
      return `workspace::${workspaceId}::${this.normalizePath(target.planFilePath)}`;
    }
    return [
      target.remoteConnectionId ?? 'local',
      this.normalizePath(target.workspacePath ?? ''),
      this.normalizePath(target.planFilePath),
    ].join('::');
  }

  private readPlanFile(entry: BuildEntry): Promise<string> {
    if (entry.workspaceId) {
      return workspaceAPI.readWorkspaceFile(entry.workspaceId, entry.planFilePath);
    }
    return workspaceAPI.readFileContent(entry.planFilePath, undefined, entry.remoteConnectionId);
  }

  private writePlanFile(entry: BuildEntry, content: string): Promise<void> {
    if (entry.workspaceId) {
      return workspaceAPI.writeWorkspaceFile(entry.workspaceId, entry.planFilePath, content);
    }
    return workspaceAPI.writeFileContent(
      entry.workspacePath,
      entry.planFilePath,
      content,
      entry.remoteConnectionId,
    );
  }

  private notify(key: string, event: PlanBuildStateEvent): void {
    const subs = this.subscribers.get(key);
    if (subs) {
      subs.forEach(cb => cb(event));
    }
  }

  private setupGlobalListeners(): void {
    window.addEventListener('openbitfun:todowrite-update', this.handleTodoWriteUpdate);
    window.addEventListener('openbitfun:dialog-cancelled', this.handleDialogCancelled);
    agentAPI.onDialogTurnCompleted(this.handleDialogTurnSettled);
    agentAPI.onDialogTurnFailed(this.handleDialogTurnSettled);
    agentAPI.onDialogTurnCancelled(this.handleDialogTurnSettled);
    agentAPI.onDialogTurnInterrupted(this.handleDialogTurnSettled);
  }

  /**
   * Global handler: when TodoWrite events arrive, update the plan file
   * and notify subscribers with the latest data.
   */
  private handleTodoWriteUpdate = async (event: Event): Promise<void> => {
    const customEvent = event as CustomEvent<{
      sessionId: string;
      turnId: string;
      todos: Array<{ id: string; content: string; status: string }>;
      merge: boolean;
    }>;
    const { sessionId, todos: incomingTodos } = customEvent.detail;

    if (!sessionId || !incomingTodos.length) return;

    for (const [key, entry] of this.buildingPlans.entries()) {
      if (entry.sessionId !== sessionId || entry.turnId !== customEvent.detail.turnId) continue;
      const matchedTodos = incomingTodos.filter(t => entry.todoIds.has(t.id));
      if (matchedTodos.length === 0) continue;

      try {
        const content = await this.readPlanFile(entry);
        const parsed = parsePlanMarkdown(content);

        const updatedTodos: PlanTodo[] = parsed.todos.map((todo) => {
          const incoming = incomingTodos.find(t => t.id === todo.id);
          return incoming ? { ...todo, status: incoming.status } : todo;
        });

        const updatedContent = serializePlanMarkdown(parsed, { todos: updatedTodos });
        const updatedDocument = parsePlanMarkdown(updatedContent);

        this.markFileWriting({
          planFilePath: entry.planFilePath,
          workspaceId: entry.workspaceId,
          workspacePath: entry.workspacePath,
          remoteConnectionId: entry.remoteConnectionId,
        });
        await this.writePlanFile(entry, updatedContent);

        const allCompleted = updatedTodos.every(t => t.status === 'completed');

        if (allCompleted) {
          this.buildingPlans.delete(key);
        }

        this.notify(key, {
          type: allCompleted ? 'build-completed' : 'todos-updated',
          isBuilding: !allCompleted,
          updatedTodos,
          updatedFrontmatter: yamlFrontmatter(updatedContent),
          planContent: updatedDocument.planContent,
        });
      } catch (error) {
        log.error('Failed to sync todo status', { filePath: entry.planFilePath, error });
      }
    }
  };

  /** Stop a build when the exact turn that owns it reaches any terminal state. */
  private handleDialogTurnSettled = (event: {
    sessionId?: string;
    session_id?: string;
    turnId?: string;
    turn_id?: string;
  }): void => {
    const sessionId = event.sessionId ?? event.session_id;
    const turnId = event.turnId ?? event.turn_id;
    if (!sessionId || !turnId) return;

    for (const [key, entry] of this.buildingPlans.entries()) {
      if (entry.sessionId !== sessionId || entry.turnId !== turnId) continue;
      this.notify(key, { type: 'build-stopped', isBuilding: false });
      this.buildingPlans.delete(key);
    }
  };

  /** Cancel active builds owned by the cancelled session. */
  private handleDialogCancelled = (event: Event): void => {
    const sessionId = (event as CustomEvent<{ sessionId?: unknown }>).detail?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      log.warn('Ignored dialog cancellation without a session ID');
      return;
    }

    for (const [key, entry] of this.buildingPlans.entries()) {
      if (entry.sessionId !== sessionId) continue;
      this.notify(key, { type: 'build-cancelled', isBuilding: false });
      this.buildingPlans.delete(key);
    }
  };
}

export const planBuildStateService = PlanBuildStateService.getInstance();
