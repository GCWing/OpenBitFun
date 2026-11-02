import { ConversationUiToolStatus } from '../state/ConversationUiModels';
import { PlanToolPolicy } from './PlanToolPolicy';

export class ToolCollapseGroup {
  readonly type: string;
  readonly startIndex: number;
  readonly tools: ConversationUiToolStatus[];

  constructor(type: string, startIndex: number, tools: ConversationUiToolStatus[]) {
    this.type = type;
    this.startIndex = startIndex;
    this.tools = tools;
  }
}

export class ToolCollapsePolicy {
  static readonly MIN_SUMMARY_COUNT: number = 2;

  static shouldFoldIntoSummary(tool: ConversationUiToolStatus): boolean {
    if (PlanToolPolicy.isPlanTool(tool) ||
      ToolCollapsePolicy.isPending(tool) ||
      ToolCollapsePolicy.isQuestion(tool) ||
      ToolCollapsePolicy.isRunning(tool)) {
      return false;
    }
    return ToolCollapsePolicy.isCompleted(tool) || ToolCollapsePolicy.isCancelled(tool) ||
      ToolCollapsePolicy.hasError(tool);
  }

  static collapsedGroups(tools: ConversationUiToolStatus[]): ToolCollapseGroup[] {
    return ToolCollapsePolicy.groupTools(tools, false);
  }

  static expandedGroups(tools: ConversationUiToolStatus[]): ToolCollapseGroup[] {
    return ToolCollapsePolicy.groupTools(tools, true);
  }

  private static groupTools(
    tools: ConversationUiToolStatus[],
    includeMembers: boolean
  ): ToolCollapseGroup[] {
    const groups: ToolCollapseGroup[] = [];
    let folded: ConversationUiToolStatus[] = [];
    let foldedStart = 0;
    tools.forEach((tool: ConversationUiToolStatus, index: number) => {
      if (ToolCollapsePolicy.shouldFoldIntoSummary(tool)) {
        if (folded.length === 0) {
          foldedStart = index;
        }
        folded.push(tool);
        return;
      }
      ToolCollapsePolicy.flushFolded(groups, folded, foldedStart, includeMembers);
      folded = [];
      groups.push(new ToolCollapseGroup('tool', index, [tool]));
    });
    ToolCollapsePolicy.flushFolded(groups, folded, foldedStart, includeMembers);
    return groups;
  }

  private static flushFolded(
    groups: ToolCollapseGroup[],
    tools: ConversationUiToolStatus[],
    startIndex: number,
    includeMembers: boolean
  ): void {
    if (tools.length === 0) {
      return;
    }
    if (tools.length < ToolCollapsePolicy.MIN_SUMMARY_COUNT) {
      tools.forEach((tool: ConversationUiToolStatus, offset: number) => {
        groups.push(new ToolCollapseGroup('tool', startIndex + offset, [tool]));
      });
      return;
    }
    groups.push(new ToolCollapseGroup('summary', startIndex, tools));
    if (includeMembers) {
      tools.forEach((tool: ConversationUiToolStatus, offset: number) => {
        groups.push(new ToolCollapseGroup('tool', startIndex + offset, [tool]));
      });
    }
  }

  private static isRunning(tool: ConversationUiToolStatus): boolean {
    const normalized = (tool.status || '').toLowerCase();
    return normalized === 'running' || normalized === 'active';
  }

  private static isCompleted(tool: ConversationUiToolStatus): boolean {
    const normalized = (tool.status || '').toLowerCase();
    return normalized === 'completed' || normalized === 'done' || normalized === 'success';
  }

  private static isCancelled(tool: ConversationUiToolStatus): boolean {
    const normalized = (tool.status || '').toLowerCase();
    return normalized === 'cancelled' || normalized === 'canceled';
  }

  private static isPending(tool: ConversationUiToolStatus): boolean {
    const normalized = (tool.status || '').toLowerCase();
    return normalized === 'pending' || normalized === 'queued' ||
      normalized === 'pending_confirmation' || normalized === 'needs_confirmation';
  }

  private static isQuestion(tool: ConversationUiToolStatus): boolean {
    const raw = tool.name || '';
    const normalized = raw.replace(/[\s-]/g, '_').toLowerCase();
    return raw === 'AskUserQuestion' || normalized === 'askuserquestion' ||
      normalized === 'ask_user_question';
  }

  private static hasError(tool: ConversationUiToolStatus): boolean {
    const normalized = (tool.status || '').toLowerCase();
    return normalized === 'failed' || normalized === 'error' || normalized === 'timeout' ||
      (tool.error_preview || '').length > 0;
  }
}
