import { ConversationUiMessageItem, ConversationUiToolStatus } from '../state/ConversationUiModels';
import { ActivityGroupPolicy, ActivityThinkingPart } from './ActivityGroupPolicy';
import { ThinkingPresentationPolicy } from './ThinkingPresentationPolicy';
import { ToolStatusPresentationPolicy } from './ToolStatusPresentationPolicy';

export interface StructuredRenderGroup {
  type: string;
  items: ConversationUiMessageItem[];
  itemStatuses: string[];
  itemStreaming: boolean[];
  itemChildActiveScopes: boolean[];
  tools: ConversationUiToolStatus[];
  key: string;
  path: string;
}

/** Pure projection of structured model output into renderable message groups. */
export class ChatMessageStructurePolicy {
  /**
   * A single top-level text item is the transport's structured form of an
   * ordinary assistant reply. Rendering it through the nested group pipeline
   * adds no information and makes a recycled empty row change its entire
   * subtree when the first token arrives. Keep that common case on the stable
   * Markdown leaf; reserve structured rendering for genuinely composite work.
   */
  static requiresStructuredRendering(items: ConversationUiMessageItem[]): boolean {
    const renderable = items.filter((entry: ConversationUiMessageItem) =>
      ChatMessageStructurePolicy.isRenderableStructuredEntry(entry));
    if (renderable.length !== 1) {
      return renderable.length > 0;
    }
    const entry = renderable[0];
    const hasSubItems = !!entry.subItems && entry.subItems.length > 0;
    return !ChatMessageStructurePolicy.isTextEntry(entry) || hasSubItems || !!entry.tool;
  }

  /**
   * A composite turn commonly ends with one growing top-level text item after
   * its reasoning and tools. Keep that volatile item out of the keyed
   * structured ForEach so its Markdown leaf can be retained while text grows.
   * Only peel it when it is the final renderable entry, preserving transcript
   * order for turns that continue with another tool or nested activity.
   */
  static trailingTopLevelText(items: ConversationUiMessageItem[]): string {
    const index = ChatMessageStructurePolicy.trailingTopLevelTextIndex(items);
    return index >= 0 ? (items[index].content || '') : '';
  }

  static withoutTrailingTopLevelText(items: ConversationUiMessageItem[]): ConversationUiMessageItem[] {
    const index = ChatMessageStructurePolicy.trailingTopLevelTextIndex(items);
    if (index < 0) return items;
    return items.slice(0, index).concat(items.slice(index + 1));
  }

  static structuredGroups(
    items: ConversationUiMessageItem[],
    prefix: string,
    activeScope: boolean,
    messageStatus: string
  ): StructuredRenderGroup[] {
    const scopedItems = ChatMessageStructurePolicy.scopeSubagentItems(items);
    const groups: StructuredRenderGroup[] = [];
    let toolBuffer: ConversationUiToolStatus[] = [];
    let activityItems: ConversationUiMessageItem[] = [];
    let activityStatuses: string[] = [];
    let activityStreaming: boolean[] = [];
    let activityChildScopes: boolean[] = [];
    let activityHasThinking = false;
    const activeItemIndex = activeScope ? ChatMessageStructurePolicy.lastRenderableItemIndex(scopedItems) : -1;

    // A key is view identity in ArkUI: changing it discards the node together
    // with its expansion state. Counting each kind separately keeps a key while
    // siblings of other kinds arrive, so appended output cannot renumber the
    // transcript that is already on screen.
    const ordinals: Map<string, number> = new Map<string, number>();
    const nextPath = (kind: string): string => {
      const ordinal = ordinals.get(kind) || 0;
      ordinals.set(kind, ordinal + 1);
      return `${prefix}-${kind}-${ordinal}`;
    };

    const flushTools = (): void => {
      if (toolBuffer.length === 0) return;
      const groupPath = nextPath('tools');
      groups.push({
        type: 'tool_group', items: [], itemStatuses: [], itemStreaming: [], itemChildActiveScopes: [],
        tools: toolBuffer,
        key: `${groupPath}-${ChatMessageStructurePolicy.stableToolHash(toolBuffer)}`,
        path: groupPath
      });
      toolBuffer = [];
    };

    const flushActivity = (): void => {
      if (activityItems.length === 0) return;
      if (!activityHasThinking) {
        activityItems.forEach((entry: ConversationUiMessageItem) => {
          if (entry.tool) toolBuffer.push(entry.tool);
        });
      } else if (activityItems.length === 1) {
        const entry = activityItems[0];
        flushTools();
        const itemPath = nextPath('thinking');
        groups.push({
          type: 'item', items: [entry], itemStatuses: [activityStatuses[0] || ''],
          itemStreaming: [activityStreaming[0] || false],
          itemChildActiveScopes: [activityChildScopes[0] || false], tools: [],
          key: ChatMessageStructurePolicy.structuredItemKey(entry, itemPath),
          path: itemPath
        });
      } else {
        flushTools();
        const groupPath = nextPath('activity');
        groups.push({
          type: 'activity_group', items: activityItems, itemStatuses: activityStatuses,
          itemStreaming: activityStreaming, itemChildActiveScopes: activityChildScopes, tools: [],
          key: ChatMessageStructurePolicy.activityGroupKey(activityItems, groupPath),
          path: groupPath
        });
      }
      activityItems = [];
      activityStatuses = [];
      activityStreaming = [];
      activityChildScopes = [];
      activityHasThinking = false;
    };

    scopedItems.forEach((entry: ConversationUiMessageItem, index: number) => {
      // Remote snapshots also mark tools executed inside a subagent. Those
      // are Task details, not sibling subagent cards in the parent timeline.
      if (ChatMessageStructurePolicy.isSubagentInternalTool(entry)) return;
      // Task tool entries are subagent branches, not ordinary tool rows, and a
      // subagent branch is never parent activity. Both checks run before the
      // activity fold so a child's reasoning is never summarised as the
      // parent's own, and so the branch keeps its title, children, and
      // lifecycle presentation.
      if (ChatMessageStructurePolicy.isSubagentEntry(entry)) {
        flushActivity();
        flushTools();
        const subagentPath = nextPath('subagent');
        groups.push({
          type: 'item', items: [entry],
          itemStatuses: [ChatMessageStructurePolicy.itemStatus(entry, index, activeItemIndex,
            activeScope, messageStatus)],
          itemStreaming: [ChatMessageStructurePolicy.itemShouldStream(entry, index, activeItemIndex, activeScope)],
          itemChildActiveScopes: [ChatMessageStructurePolicy.itemChildActiveScope(entry, index,
            activeItemIndex, activeScope)],
          tools: [], key: ChatMessageStructurePolicy.structuredItemKey(entry, subagentPath),
          path: subagentPath
        });
        return;
      }
      if (ChatMessageStructurePolicy.shouldFoldIntoActivityGroup(entry)) {
        activityItems.push(entry);
        activityStatuses.push(ChatMessageStructurePolicy.itemStatus(entry, index, activeItemIndex,
          activeScope, messageStatus));
        activityStreaming.push(ChatMessageStructurePolicy.itemShouldStream(entry, index, activeItemIndex, activeScope));
        activityChildScopes.push(ChatMessageStructurePolicy.itemChildActiveScope(entry, index,
          activeItemIndex, activeScope));
        activityHasThinking = activityHasThinking || ChatMessageStructurePolicy.isThinkingEntry(entry);
        return;
      }

      flushActivity();
      if (entry.tool) {
        toolBuffer.push(entry.tool);
        return;
      }
      flushTools();
      const itemPath = nextPath('item');
      groups.push({
        type: 'item', items: [entry],
        itemStatuses: [ChatMessageStructurePolicy.itemStatus(entry, index, activeItemIndex,
          activeScope, messageStatus)],
        itemStreaming: [ChatMessageStructurePolicy.itemShouldStream(entry, index, activeItemIndex, activeScope)],
        itemChildActiveScopes: [ChatMessageStructurePolicy.itemChildActiveScope(entry, index,
          activeItemIndex, activeScope)],
        tools: [], key: ChatMessageStructurePolicy.structuredItemKey(entry, itemPath),
        path: itemPath
      });
    });
    flushActivity();
    flushTools();
    return groups;
  }

  /**
   * Rebuilds the branch hierarchy carried by the remote wire format.
   *
   * Live snapshots are intentionally flat and mark child-agent records with
   * `is_subagent`. The parent UI must attach those records to the Task that
   * owns them before grouping ordinary transcript activity. Older desktop
   * builds did not emit the marker, so while a Task is running we use the same
   * conservative fallback as mobile web and scope its following process items.
   *
   * A Task's children can arrive nested in its own items and again flat behind
   * it, so folding the restatement would draw every child twice. A counted
   * restatement is skipped, and a child that legitimately repeats survives.
   *
   * A marked record with no owning Task in this list — a partial snapshot, or a
   * child that arrived before its Task — keeps its own collapsed branch rather
   * than being dropped, because the process it carries is exactly what the
   * reader opened the branch to see.
   */
  static scopeSubagentItems(items: ConversationUiMessageItem[]): ConversationUiMessageItem[] {
    const result: ConversationUiMessageItem[] = [];
    const hasSubagentMarkers = items.some((entry: ConversationUiMessageItem) => entry.is_subagent === true);
    let currentTask: ConversationUiMessageItem | undefined = undefined;
    let carried: number[] = [];

    items.forEach((entry: ConversationUiMessageItem) => {
      if (ChatMessageStructurePolicy.isParentTaskEntry(entry)) {
        const task = ChatMessageStructurePolicy.copyItem(entry);
        result.push(task);
        currentTask = task;
        carried = (task.subItems || []).map((_child: ConversationUiMessageItem, index: number) => index);
        return;
      }
      if (entry.is_subagent === true) {
        if (currentTask) {
          ChatMessageStructurePolicy.appendScopedChild(currentTask, carried, entry);
        } else {
          result.push(ChatMessageStructurePolicy.orphanSubagentBranch(entry));
        }
        return;
      }
      if (!hasSubagentMarkers && currentTask &&
        ChatMessageStructurePolicy.isRunningTaskEntry(currentTask) &&
        ChatMessageStructurePolicy.isLegacySubagentProcessEntry(entry)) {
        ChatMessageStructurePolicy.appendScopedChild(currentTask, carried, entry);
        return;
      }
      result.push(entry);
    });
    return result;
  }

  /**
   * A marked record whose Task is not in this list still owns process the reader
   * must be able to open, so it becomes its own collapsed branch. The outer copy
   * keeps the marker and the tool identity that title and status come from; the
   * inner copy drops the marker so the same record renders as branch content
   * instead of nesting a second branch inside the first.
   *
   * A non-tool record's text is that content: leaving it on the outer copy would
   * print it twice, once as the branch label and once as the step it labels, so
   * the label falls back to the generic Task name and the body comes only from
   * the child. A tool record keeps its text, because its label already resolves
   * through the tool identity and its child draws a tool row rather than text.
   */
  private static orphanSubagentBranch(entry: ConversationUiMessageItem): ConversationUiMessageItem {
    const branch = ChatMessageStructurePolicy.copyItem(entry);
    if (branch.subItems && branch.subItems.length > 0) {
      return branch;
    }
    const child = ChatMessageStructurePolicy.copyItem(entry);
    child.is_subagent = false;
    child.subItems = [];
    if (!entry.tool) {
      branch.content = '';
    }
    branch.subItems = [child];
    return branch;
  }

  /** Only original nested occurrences are matched; new flat entries consume no quota. */
  private static appendScopedChild(
    task: ConversationUiMessageItem, carried: number[], entry: ConversationUiMessageItem
  ): void {
    const children = (task.subItems || []).slice();
    const match = carried.findIndex((index: number) =>
      ChatMessageStructurePolicy.sameChildIdentity(children[index], entry));
    if (match < 0) {
      children.push(entry);
    } else {
      const index = carried.splice(match, 1)[0];
      if (entry.tool) {
        // Flat records may carry newer status/output for the same nested tool.
        const updated = ChatMessageStructurePolicy.copyItem(entry);
        if (entry.subItems === undefined) updated.subItems = children[index].subItems;
        if (entry.content === undefined) updated.content = children[index].content;
        updated.tool = ChatMessageStructurePolicy.mergeChildTool(children[index].tool, entry.tool);
        children[index] = updated;
      }
    }
    task.subItems = children;
  }

  /**
   * What makes two subagent children the same piece of work.
   *
   * Children arrive without an id, so the kind, its content, and the tool it
   * names are all there is to tell one from the other.
   */
  private static childFingerprint(entry: ConversationUiMessageItem): string {
    return [
      (entry.type || '').toLowerCase(),
      entry.content || '',
      entry.tool ? ChatMessageStructurePolicy.toolIdentity(entry.tool) : ''
    ].join('\u0000');
  }

  private static mergeChildTool(
    previous: ConversationUiToolStatus | undefined, incoming: ConversationUiToolStatus
  ): ConversationUiToolStatus {
    return {
      id: incoming.id ?? previous?.id,
      name: incoming.name ?? previous?.name,
      status: incoming.status ?? previous?.status,
      duration_ms: incoming.duration_ms ?? previous?.duration_ms,
      start_ms: incoming.start_ms ?? previous?.start_ms,
      input_preview: incoming.input_preview ?? previous?.input_preview,
      tool_input: incoming.tool_input ?? previous?.tool_input,
      stdout: incoming.stdout ?? previous?.stdout,
      stderr: incoming.stderr ?? previous?.stderr,
      tool_output: incoming.tool_output ?? previous?.tool_output,
      result_preview: incoming.result_preview ?? previous?.result_preview,
      error_preview: incoming.error_preview ?? previous?.error_preview,
      exit_code: incoming.exit_code ?? previous?.exit_code,
      plan: incoming.plan ?? previous?.plan,
      permission_request_id: incoming.permission_request_id ?? previous?.permission_request_id,
    };
  }

  private static sameChildIdentity(a: ConversationUiMessageItem, b: ConversationUiMessageItem): boolean {
    const aId = a.tool?.id || '';
    const bId = b.tool?.id || '';
    if (aId || bId) return aId.length > 0 && aId === bId;
    return ChatMessageStructurePolicy.childFingerprint(a) === ChatMessageStructurePolicy.childFingerprint(b);
  }

  /**
   * The tool a child names, identified by its id when the agent gave one.
   *
   * Status is left out: a restatement often carries a newer status for the same
   * piece of work, and treating that as identity would draw the child twice.
   */
  private static toolIdentity(tool: ConversationUiToolStatus): string {
    if (tool.id) return `id:${tool.id}`;
    return ChatMessageStructurePolicy.toolFingerprint(tool, false);
  }

  static structuredRenderKey(
    items: ConversationUiMessageItem[],
    prefix: string,
    activeScope: boolean,
    messageStatus: string
  ): string {
    const groupKeys = ChatMessageStructurePolicy.structuredGroups(
      items,
      prefix,
      activeScope,
      messageStatus
    ).map((group: StructuredRenderGroup) => group.key);
    return `${prefix}-structured-${ChatMessageStructurePolicy.stableTextHash(groupKeys.join('|'))}`;
  }

  static activityGroupTools(group: StructuredRenderGroup): ConversationUiToolStatus[] {
    const tools: ConversationUiToolStatus[] = [];
    group.items.forEach((entry: ConversationUiMessageItem) => {
      if (entry.tool) tools.push(entry.tool);
    });
    return tools;
  }

  static activityThinkingParts(group: StructuredRenderGroup, messageId: string): ActivityThinkingPart[] {
    const raw: ActivityThinkingPart[] = [];
    let toolsSeen = 0;
    let thinkingSeen = 0;
    group.items.forEach((entry: ConversationUiMessageItem, index: number) => {
      if (ChatMessageStructurePolicy.isThinkingEntry(entry)) {
        raw.push({
          beforeToolIndex: toolsSeen, text: entry.content || '', status: group.itemStatuses[index] || '',
          streaming: group.itemStreaming[index] || false,
          streamKey: `${messageId}-${group.path}-thinking-${thinkingSeen}`
        });
        thinkingSeen += 1;
      } else if (entry.tool) {
        toolsSeen += 1;
      }
    });
    return ActivityGroupPolicy.mergeThinkingParts(raw);
  }

  static activityThinkingCount(group: StructuredRenderGroup): number {
    return group.items.filter((entry: ConversationUiMessageItem) =>
      ChatMessageStructurePolicy.isThinkingEntry(entry)).length;
  }

  static activityThinkingText(group: StructuredRenderGroup): string {
    const parts = group.items.filter((entry: ConversationUiMessageItem) =>
      ChatMessageStructurePolicy.isThinkingEntry(entry)).map((entry: ConversationUiMessageItem) => entry.content || '');
    return ThinkingPresentationPolicy.mergedText(parts);
  }

  static activityThinkingStatus(group: StructuredRenderGroup): string {
    const statuses: string[] = [];
    const streamings: boolean[] = [];
    group.items.forEach((entry: ConversationUiMessageItem, index: number) => {
      if (ChatMessageStructurePolicy.isThinkingEntry(entry)) {
        statuses.push(group.itemStatuses[index] || '');
        streamings.push(group.itemStreaming[index] || false);
      }
    });
    return ThinkingPresentationPolicy.mergedStatusValue(statuses, streamings);
  }

  static activityThinkingStreaming(group: StructuredRenderGroup): boolean {
    const streamings: boolean[] = [];
    group.items.forEach((entry: ConversationUiMessageItem, index: number) => {
      if (ChatMessageStructurePolicy.isThinkingEntry(entry)) streamings.push(group.itemStreaming[index] || false);
    });
    return ThinkingPresentationPolicy.mergedStreaming(streamings);
  }

  static toolsNotCoveredByItems(
    tools: ConversationUiToolStatus[],
    items: ConversationUiMessageItem[]
  ): ConversationUiToolStatus[] {
    const coveredTools = ChatMessageStructurePolicy.itemToolCoverageGroups(items);
    const matched: boolean[] = coveredTools.map((_keys: string[]) => false);
    return tools.filter((tool: ConversationUiToolStatus) => {
      const matchIndex = ChatMessageStructurePolicy.matchCoveredToolIndex(
        ChatMessageStructurePolicy.toolCoverageKeys(tool), coveredTools, matched);
      if (matchIndex >= 0) {
        matched[matchIndex] = true;
        return false;
      }
      return true;
    });
  }

  static isRenderableStructuredEntry(entry: ConversationUiMessageItem): boolean {
    if (ChatMessageStructurePolicy.isSubagentInternalTool(entry)) return false;
    if (ChatMessageStructurePolicy.isUserSteeringEntry(entry) ||
      ChatMessageStructurePolicy.isThinkingEntry(entry) || ChatMessageStructurePolicy.isTextEntry(entry) ||
      ChatMessageStructurePolicy.isSubagentEntry(entry) || !!entry.tool) return true;
    return !!entry.subItems && entry.subItems.some((child: ConversationUiMessageItem) =>
      ChatMessageStructurePolicy.isRenderableStructuredEntry(child));
  }

  static isThinkingEntry(entry: ConversationUiMessageItem): boolean {
    return (entry.type || '').toLowerCase() === 'thinking' && (entry.content || '').trim().length > 0;
  }

  static isUserSteeringEntry(entry: ConversationUiMessageItem): boolean {
    return (entry.type || '').toLowerCase() === 'user-steering' &&
      ((entry.content || '').trim().length > 0 || (entry.images || []).length > 0);
  }

  static isTextEntry(entry: ConversationUiMessageItem): boolean {
    const type = (entry.type || '').toLowerCase();
    if ((entry.content || '').trim().length === 0 || entry.tool ||
      ChatMessageStructurePolicy.isThinkingEntry(entry) || ChatMessageStructurePolicy.isSubagentEntry(entry)) {
      return false;
    }
    return type === 'text' || type === 'message' || type.length === 0;
  }

  static isSubagentEntry(entry: ConversationUiMessageItem): boolean {
    const type = (entry.type || '').toLowerCase();
    return entry.is_subagent === true || type === 'subagent' || type === 'agent' ||
      (!!entry.tool && ToolStatusPresentationPolicy.normalizedName(entry.tool) === 'task');
  }

  /**
   * The Task tool entry that owns a subagent branch.
   *
   * A Task entry may carry the subagent marker as well: the host records the
   * child Session id on the Task tool item, and the remote wire maps that field
   * onto `is_subagent`. The marker therefore means "this Task owns a subagent",
   * not "this entry is subagent output", so it must not disqualify the owner —
   * otherwise no Task ever opens a branch and every flat child record is lost.
   */
  private static isParentTaskEntry(entry: ConversationUiMessageItem): boolean {
    return !!entry.tool && ToolStatusPresentationPolicy.normalizedName(entry.tool) === 'task';
  }

  private static isRunningTaskEntry(entry: ConversationUiMessageItem): boolean {
    if (!entry.tool) return false;
    const status = (entry.tool.status || '').toLowerCase();
    return status === 'running' || status === 'active' || status === 'preparing' ||
      status === 'pending' || status === 'queued';
  }

  /**
   * The branch entry a Task card is drawing, read from the transcript as it is
   * now.
   *
   * The structured ForEach is keyed by the branch view key, which deliberately
   * does not change while a subagent publishes steps, so its item builder keeps
   * the entry it first captured — including the empty child list of a Task whose
   * subagent had not started yet. Param expressions are re-evaluated on every
   * render, so the card re-reads its branch through here instead of trusting that
   * snapshot, and a step published later reaches a card that is already open.
   *
   * Branches are identified by the Task's tool call when the host sent one, and
   * by the ordinal the render path numbered them with otherwise.
   */
  static subagentBranchAt(
    items: ConversationUiMessageItem[],
    ordinal: number,
    ownerToolId: string
  ): ConversationUiMessageItem | undefined {
    const branches = ChatMessageStructurePolicy.scopeSubagentItems(items)
      .filter((entry: ConversationUiMessageItem) => ChatMessageStructurePolicy.isSubagentEntry(entry));
    if (ownerToolId.length > 0) {
      const owned = branches.find((entry: ConversationUiMessageItem) =>
        !!entry.tool && entry.tool.id === ownerToolId);
      if (owned) return owned;
    }
    return ordinal >= 0 && ordinal < branches.length ? branches[ordinal] : undefined;
  }

  /** The ordinal a branch path was numbered with, e.g. `item-subagent-2` is 2. */
  static subagentOrdinal(path: string): number {
    const marker = path.lastIndexOf('-subagent-');
    if (marker < 0) return 0;
    const ordinal = Number(path.slice(marker + '-subagent-'.length));
    return Number.isFinite(ordinal) && ordinal >= 0 ? ordinal : 0;
  }

  private static isLegacySubagentProcessEntry(entry: ConversationUiMessageItem): boolean {
    return ChatMessageStructurePolicy.isThinkingEntry(entry) ||
      ChatMessageStructurePolicy.isTextEntry(entry) || !!entry.tool;
  }

  private static copyItem(entry: ConversationUiMessageItem): ConversationUiMessageItem {
    return {
      type: entry.type,
      steering_id: entry.steering_id,
      round_index: entry.round_index,
      content: entry.content,
      tool: entry.tool,
      is_subagent: entry.is_subagent,
      subItems: entry.subItems ? entry.subItems.slice() : [],
      images: entry.images ? entry.images.slice() : undefined
    };
  }

  private static isSubagentInternalTool(entry: ConversationUiMessageItem): boolean {
    // A marked record that already carries children is a branch of its own, not
    // an internal tool of some other branch.
    if (!!entry.subItems && entry.subItems.length > 0) return false;
    return entry.is_subagent === true && !!entry.tool &&
      ToolStatusPresentationPolicy.normalizedName(entry.tool) !== 'task';
  }

  static subagentTitle(entry: ConversationUiMessageItem): string {
    const taskTool = !!entry.tool && ToolStatusPresentationPolicy.normalizedName(entry.tool) === 'task';
    if (entry.tool && taskTool) {
      const title = ChatMessageStructurePolicy.subagentTaskTitle(entry.tool);
      if (title.length > 0) return title;
    }
    const content = ChatMessageStructurePolicy.plainSubagentLabel(entry.content || '');
    if (content.length > 0 && content.length <= 80) return content;
    if (entry.tool && entry.tool.name && !taskTool) {
      return ChatMessageStructurePolicy.plainSubagentLabel(entry.tool.name);
    }
    return '';
  }

  static subagentBody(entry: ConversationUiMessageItem): string {
    if (entry.tool && ToolStatusPresentationPolicy.normalizedName(entry.tool) === 'task') return '';
    const content = ChatMessageStructurePolicy.plainSubagentLabel(entry.content || '');
    if (content.length === 0 || content === ChatMessageStructurePolicy.subagentTitle(entry)) return '';
    return content;
  }

  static isAttentionTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.hasError(tool) ||
      ChatMessageStructurePolicy.isPendingTool(tool) ||
      ChatMessageStructurePolicy.isRunningTool(tool) || ToolStatusPresentationPolicy.isQuestionLike(tool);
  }

  static hasAttentionItems(items: ConversationUiMessageItem[]): boolean {
    return items.some((entry: ConversationUiMessageItem) => {
      if (entry.tool && ChatMessageStructurePolicy.isAttentionTool(entry.tool)) return true;
      return !!entry.subItems && ChatMessageStructurePolicy.hasAttentionItems(entry.subItems);
    });
  }

  static hasAttentionTools(tools: ConversationUiToolStatus[]): boolean {
    return tools.some((tool: ConversationUiToolStatus) => ChatMessageStructurePolicy.isAttentionTool(tool));
  }

  private static lastRenderableItemIndex(items: ConversationUiMessageItem[]): number {
    for (let index = items.length - 1; index >= 0; index--) {
      if (ChatMessageStructurePolicy.isRenderableStructuredEntry(items[index])) return index;
    }
    return -1;
  }

  private static trailingTopLevelTextIndex(items: ConversationUiMessageItem[]): number {
    const index = ChatMessageStructurePolicy.lastRenderableItemIndex(items);
    if (index < 0 || !ChatMessageStructurePolicy.isTextEntry(items[index])) return -1;
    return index;
  }

  private static itemStatus(
    entry: ConversationUiMessageItem,
    index: number,
    activeItemIndex: number,
    activeScope: boolean,
    messageStatus: string
  ): string {
    if (ChatMessageStructurePolicy.isThinkingEntry(entry) && index === activeItemIndex && activeScope) {
      return messageStatus || 'active';
    }
    return ChatMessageStructurePolicy.isThinkingEntry(entry) ? 'done' : '';
  }

  private static itemShouldStream(
    entry: ConversationUiMessageItem,
    index: number,
    activeItemIndex: number,
    activeScope: boolean
  ): boolean {
    if (index !== activeItemIndex || !activeScope) return false;
    return ChatMessageStructurePolicy.isThinkingEntry(entry) || ChatMessageStructurePolicy.isTextEntry(entry) ||
      (ChatMessageStructurePolicy.isSubagentEntry(entry) && (!entry.subItems || entry.subItems.length === 0));
  }

  private static itemChildActiveScope(
    entry: ConversationUiMessageItem,
    index: number,
    activeItemIndex: number,
    activeScope: boolean
  ): boolean {
    return index === activeItemIndex && activeScope && !!entry.subItems && entry.subItems.length > 0;
  }

  private static shouldFoldIntoActivityGroup(entry: ConversationUiMessageItem): boolean {
    return ActivityGroupPolicy.shouldFoldEntry(
      ChatMessageStructurePolicy.isThinkingEntry(entry),
      ChatMessageStructurePolicy.isSubagentEntry(entry), entry.tool);
  }

  private static stableToolHash(tools: ConversationUiToolStatus[]): string {
    return ChatMessageStructurePolicy.stableTextHash(tools.map((tool: ConversationUiToolStatus) =>
      `${tool.id || ''}:${tool.name || ''}:${tool.status || ''}`).join('|'));
  }

  private static itemToolCoverageGroups(items: ConversationUiMessageItem[]): string[][] {
    const groups: string[][] = [];
    items.forEach((entry: ConversationUiMessageItem) => {
      if (entry.tool) groups.push(ChatMessageStructurePolicy.toolCoverageKeys(entry.tool));
      if (entry.subItems) {
        ChatMessageStructurePolicy.itemToolCoverageGroups(entry.subItems).forEach((keys: string[]) => groups.push(keys));
      }
    });
    return groups;
  }

  private static matchCoveredToolIndex(keys: string[], groups: string[][], matched: boolean[]): number {
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      if (matched[groupIndex]) continue;
      for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
        if (groups[groupIndex].indexOf(keys[keyIndex]) >= 0) return groupIndex;
      }
    }
    return -1;
  }

  private static toolCoverageKeys(tool: ConversationUiToolStatus): string[] {
    const keys: string[] = [];
    const toolId = tool.id || '';
    if (toolId.length > 0) keys.push(`id:${toolId}`);
    keys.push(`full:${ChatMessageStructurePolicy.toolFingerprint(tool, true)}`);
    if (toolId.length === 0 || ChatMessageStructurePolicy.hasToolFingerprintData(tool)) {
      keys.push(`stable:${ChatMessageStructurePolicy.toolFingerprint(tool, false)}`);
    }
    return keys;
  }

  private static toolFingerprint(tool: ConversationUiToolStatus, includeStatus: boolean): string {
    return ChatMessageStructurePolicy.stableTextHash([
      ToolStatusPresentationPolicy.normalizedName(tool), includeStatus ? (tool.status || '') : '',
      tool.input_preview || '', tool.result_preview || '', tool.error_preview || '', tool.stdout || '',
      tool.stderr || '', `${tool.exit_code || 0}`, ChatMessageStructurePolicy.objectSignature(tool.tool_input),
      ChatMessageStructurePolicy.objectSignature(tool.tool_output)
    ].join('|'));
  }

  private static hasToolFingerprintData(tool: ConversationUiToolStatus): boolean {
    return (tool.input_preview || '').length > 0 || (tool.result_preview || '').length > 0 ||
      (tool.error_preview || '').length > 0 || (tool.stdout || '').length > 0 ||
      (tool.stderr || '').length > 0 || !!tool.tool_input || !!tool.tool_output;
  }

  private static objectSignature(value?: Object): string {
    if (!value) return '';
    try {
      return JSON.stringify(value);
    } catch (_err) {
      return 'object';
    }
  }

  private static subagentTaskTitle(tool: ConversationUiToolStatus): string {
    return ChatMessageStructurePolicy.plainSubagentLabel(ToolStatusPresentationPolicy.taskTitle(tool));
  }

  private static plainSubagentLabel(raw: string): string {
    let text = (raw || '').trim();
    const wrappers: string[] = ['**', '__', '`', '*', '_'];
    for (let index = 0; index < wrappers.length; index++) {
      const wrapper = wrappers[index];
      if (text.length > wrapper.length * 2 && text.startsWith(wrapper) && text.endsWith(wrapper)) {
        text = text.slice(wrapper.length, text.length - wrapper.length).trim();
        break;
      }
    }
    while (text.startsWith('#')) {
      text = text.slice(1).trim();
    }
    return text;
  }

  static structuredItemKey(entry: ConversationUiMessageItem, path: string): string {
    if (ChatMessageStructurePolicy.isThinkingEntry(entry)) return `${path}-thinking`;
    if (ChatMessageStructurePolicy.isUserSteeringEntry(entry) && entry.steering_id) {
      return `${path}-steering-${entry.steering_id}`;
    }
    if (entry.tool && entry.tool.id) return `${path}-tool-${entry.tool.id}`;
    const content = entry.content || '';
    const childCount = entry.subItems ? entry.subItems.length : 0;
    return `${path}-${entry.type || 'item'}-${entry.is_subagent === true ? 'subagent' : 'main'}-` +
      `${content.length}-${ChatMessageStructurePolicy.stableTextHash(content)}-${childCount}`;
  }

  private static activityGroupKey(items: ConversationUiMessageItem[], path: string): string {
    const parts: string[] = [];
    // Counting each kind separately keeps the key while siblings of other kinds
    // arrive inside the group, the same way the group paths above do.
    const ordinals: Map<string, number> = new Map<string, number>();
    items.forEach((entry: ConversationUiMessageItem) => {
      const thinking = ChatMessageStructurePolicy.isThinkingEntry(entry);
      const kind = thinking ? 'thinking' : entry.tool ? 'tool' : 'item';
      const ordinal = ordinals.get(kind) || 0;
      ordinals.set(kind, ordinal + 1);
      parts.push([
        `${kind}-${ordinal}`, entry.type || '',
        thinking ? 'thinking' : `${(entry.content || '').length}:${ChatMessageStructurePolicy.stableTextHash(entry.content || '')}`,
        entry.tool ? `${entry.tool.id || ''}:${entry.tool.name || ''}:${entry.tool.status || ''}` : ''
      ].join(':'));
    });
    return `${path}-${ChatMessageStructurePolicy.stableTextHash(parts.join('|'))}`;
  }

  private static stableTextHash(text: string): string {
    let hash = 0;
    for (let index = 0; index < text.length; index++) hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    return Math.abs(hash).toString(36);
  }

  private static isRunningTool(tool: ConversationUiToolStatus): boolean {
    const status = (tool.status || '').toLowerCase();
    return status === 'running' || status === 'active';
  }

  private static isPendingTool(tool: ConversationUiToolStatus): boolean {
    const status = (tool.status || '').toLowerCase();
    return status === 'pending' || status === 'queued' ||
      status === 'pending_confirmation' || status === 'needs_confirmation';
  }
}
