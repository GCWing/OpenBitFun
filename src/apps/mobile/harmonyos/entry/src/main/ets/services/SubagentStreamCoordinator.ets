import { ChatMessage, ChatMessageItemResponse, RemoteToolStatusResponse } from '../model/RemoteModels';
import { DurableSessionReducer } from './DurableSessionReducer';
import { HostSessionCallbacks, HostSessionEvent, HostSessionStream } from './HostSessionStream';

/**
 * The one call the coordinator needs from the runtime connection.
 *
 * `RemoteSessionManager` implements it, so the production path opens child
 * streams exactly the way it opens the session on screen; a preview fixture can
 * implement it over its own pages.
 */
export interface SubagentStreamSource {
  subscribeSession(sessionId: string, callbacks: HostSessionCallbacks): HostSessionStream;
}

/** Tool-item fields a launching record carries; the child Session id names its stream. */
interface SubagentOwnerItemData {
  toolName?: string;
  subagentSessionId?: string;
  toolCall?: SubagentOwnerToolCall;
}
interface SubagentOwnerToolCall { id?: string; }
interface SubagentOwnerItem { type?: string; data?: SubagentOwnerItemData; }
interface SubagentOwnerRecord { item?: SubagentOwnerItem; }

/** One child session whose records are drawn inside the branch that launched it. */
interface SubagentBranch {
  sessionId: string;
  ownerToolCallId: string;
  reducer: DurableSessionReducer;
  stream?: HostSessionStream;
  /** False until the child's first page settled, so its backfill is one publish. */
  caughtUp: boolean;
  /** How many times this branch's content changed. Monotonic per branch. */
  changes: number;
  items: ChatMessageItemResponse[];
  signature: string;
}

/**
 * Streams a delegation tool's child sessions into the branch that launched them.
 *
 * A host keeps a spawned child agent in its own hidden session: the parent
 * record names that session on the launching tool item, and nothing the child
 * does appears in the parent's own stream. The only place the child's steps
 * exist is its stream, so the branch content is grouped by the subscription the
 * records arrived on — the child session id the host named — and never by a
 * marker on a record.
 *
 * The parent session's reducer stays the single author of the parent
 * transcript: this coordinator only attaches each child's own projection as the
 * branch items of the item that owns it, and the transcript grouping policy
 * then draws that item as the card it already knew how to draw. A host that does
 * not name a child session produces no branch here at all, so an older desktop
 * keeps the plain tool rows it has always sent.
 */
export class SubagentStreamCoordinator {
  private source: SubagentStreamSource;
  private notify: () => void;
  private onError: (error: Error) => void;
  private parentSessionId: string = '';
  private branches: Map<string, SubagentBranch> = new Map<string, SubagentBranch>();
  /** Owner tool call id -> child session id, i.e. which item a child belongs to. */
  private owners: Map<string, string> = new Map<string, string>();
  /** Owner tool call id -> the digest of the last launch state this coordinator published. */
  private ownerDigests: Map<string, string> = new Map<string, string>();
  /** Owner tool call id -> the render version this coordinator has published for it. */
  private ownerVersions: Map<string, number> = new Map<string, number>();

  constructor(source: SubagentStreamSource, notify: () => void, onError: (error: Error) => void) {
    this.source = source;
    this.notify = notify;
    this.onError = onError;
  }

  /**
   * Binds the coordinator to the parent session that is being opened.
   *
   * Nothing survives a session switch: another session's children are not this
   * session's branches, and their streams would keep pushing records into a
   * transcript that is no longer on screen.
   */
  beginSession(parentSessionId: string): void {
    this.detach();
    this.parentSessionId = parentSessionId;
  }

  /** Closes every child stream; the parent session's own transcript is untouched. */
  endSession(): void {
    this.detach();
  }

  /**
   * Follows the parent's own records, which are the only place a child session
   * id is named.
   *
   * Nothing else is inferred: a launch item without that field is an ordinary
   * tool call, and no amount of tool ordering is treated as a subagent.
   */
  observeParentEvent(event: HostSessionEvent): void {
    if (this.parentSessionId.length === 0) return;
    const owner = SubagentStreamCoordinator.ownerData(event);
    if (!owner) return;
    const childSessionId = owner.subagentSessionId || '';
    const ownerToolCallId = owner.toolCall ? (owner.toolCall.id || '') : '';
    if (childSessionId.length === 0 || ownerToolCallId.length === 0 || this.parentSessionId === childSessionId) return;
    if (this.branches.has(childSessionId)) return;
    this.openBranch(childSessionId, ownerToolCallId);
  }

  /**
   * The child branch items for every launching item the parent has published.
   *
   * Messages are returned unchanged when no branch applies, so a session without
   * spawned children pays nothing beyond one map lookup per tool item. An
   * affected message is copied with its owner's render version advanced by the
   * branch's own change count, because ArkUI keys the row by what changed in
   * the message and a branch grows without any parent record changing.
   */
  decorate(messages: ChatMessage[]): ChatMessage[] {
    if (this.branches.size === 0) return messages;
    return messages.map((message: ChatMessage) => this.decorateMessage(message));
  }

  private decorateMessage(message: ChatMessage): ChatMessage {
    const items = message.items;
    if (!items || items.length === 0) return message;
    let attached = 0;
    const decorated: ChatMessageItemResponse[] = items.map((item: ChatMessageItemResponse, index: number) => {
      const toolId = item.tool ? (item.tool.id || '') : '';
      if (toolId.length === 0) return item;
      const childSessionId = this.owners.get(toolId);
      if (!childSessionId) return item;
      const branch = this.branches.get(childSessionId);
      if (!branch) return item;
      attached += this.ownerVersion(toolId, branch, item.tool);
      if (branch.items.length === 0) return item;
      // A host that publishes the process inside its own stream keeps this item
      // on the path it has always used, and needs no branch attached here.
      if (SubagentStreamCoordinator.parentCarriesBranchItems(items, index)) return item;
      return {
        type: item.type,
        steering_id: item.steering_id,
        round_index: item.round_index,
        content: item.content,
        tool: item.tool,
        is_subagent: item.is_subagent,
        subItems: branch.items,
        images: item.images
      };
    });
    if (attached === 0) return message;
    return {
      id: message.id,
      role: message.role,
      text: message.text,
      status: message.status,
      renderVersion: (message.renderVersion || 0) + attached,
      turnId: message.turnId,
      detail: message.detail,
      error: message.error,
      timestamp: message.timestamp,
      thinking: message.thinking,
      tools: message.tools,
      items: decorated,
      images: message.images
    };
  }

  /**
   * The render version this coordinator publishes for one launch item.
   *
   * Two independent things alter a card: the worker's own process grew, and the
   * launch item's own record was updated. A launch settles as soon as the worker
   * starts, and a background worker's launch settles while its stream has
   * nothing new to say, so a version that only counted branch growth would leave
   * the header of exactly that card behind: the row is keyed by what changed in
   * the message, and a tool item's own status is not part of that key. Folding
   * the launch's own digest in here means a settled launch repaints the card it
   * belongs to even when its worker publishes no further step.
   *
   * The value is cumulative rather than a per-publication delta: the transcript
   * the controller publishes must be identical when nothing changed, or a row
   * would be rebuilt from a message that no longer carries its branch.
   */
  private ownerVersion(ownerToolCallId: string, branch: SubagentBranch,
    tool?: RemoteToolStatusResponse): number {
    const digest = [
      `${branch.changes}`,
      tool ? (tool.name || '') : '',
      tool ? (tool.status || '') : ''
    ].join('\u0000');
    if (this.ownerDigests.get(ownerToolCallId) !== digest) {
      this.ownerDigests.set(ownerToolCallId, digest);
      this.ownerVersions.set(ownerToolCallId, (this.ownerVersions.get(ownerToolCallId) || 0) + 1);
    }
    return this.ownerVersions.get(ownerToolCallId) || 0;
  }

  /**
   * Whether the parent stream itself already carries this owner's process.
   *
   * Older hosts published a subagent's records inside the parent stream and
   * marked them, and the transcript grouping already attaches those records to
   * the item that launched them. Attaching the child session's records here as
   * well would draw every step twice, so a marked sibling record — up to the
   * next launch item, which owns its own records — keeps that host on the path
   * it has always used.
   */
  private static parentCarriesBranchItems(items: ChatMessageItemResponse[], ownerIndex: number): boolean {
    for (let index = ownerIndex + 1; index < items.length; index++) {
      const entry = items[index];
      if (entry.is_subagent !== true) continue;
      if (entry.tool && SubagentStreamCoordinator.isOwnerToolName(entry.tool.name || '')) return false;
      return true;
    }
    return false;
  }

  private static isOwnerToolName(rawName: string): boolean {
    const name = rawName.trim().replace(/[\s-]/g, '_').toLowerCase();
    return name === 'task' || name === 'agentspawn';
  }

  private static ownerData(event: HostSessionEvent): SubagentOwnerItemData | undefined {
    if (event.event !== 'session-record') return undefined;
    const record = event.payload as SubagentOwnerRecord;
    const item = record.item;
    if (!item || item.type !== 'tool' || !item.data) return undefined;
    return item.data.subagentSessionId ? item.data : undefined;
  }

  private openBranch(childSessionId: string, ownerToolCallId: string): void {
    const branch: SubagentBranch = {
      sessionId: childSessionId,
      ownerToolCallId: ownerToolCallId,
      reducer: new DurableSessionReducer(),
      caughtUp: false,
      changes: 0,
      items: [],
      signature: ''
    };
    this.branches.set(childSessionId, branch);
    this.owners.set(ownerToolCallId, childSessionId);
    try {
      branch.stream = this.source.subscribeSession(childSessionId, {
        onEvent: async (event: HostSessionEvent): Promise<void> => {
          this.applyChildEvent(childSessionId, event);
        },
        onCaughtUp: async (): Promise<void> => {
          const current = this.branches.get(childSessionId);
          if (!current) return;
          current.caughtUp = true;
          this.refresh(current);
        },
        onGap: async (): Promise<void> => {
          // The host restarted this child's stream: everything reduced so far
          // came from its previous epoch, so it is dropped before the replay.
          const current = this.branches.get(childSessionId);
          if (!current) return;
          current.reducer = new DurableSessionReducer();
          current.caughtUp = false;
        },
        onError: (error: Error): void => { this.onError(error); }
      });
    } catch (_error) {
      // A child stream that cannot be opened is not a reason to fail the
      // session on screen: the launch item keeps its own row and result, and its
      // branch stays empty instead of showing fabricated steps.
      this.branches.delete(childSessionId);
      this.owners.delete(ownerToolCallId);
    }
  }

  /**
   * One record of one child session.
   *
   * Records are deduplicated by identity and revision inside the child's own
   * reducer, which is the same reducer the session on screen uses, so a
   * replayed page cannot publish a step twice. Until the child's first page has
   * settled the parent is not republished at all: a child that finished before
   * its branch was opened backfills hundreds of records, and each of them
   * republishing the parent transcript would repaint the whole conversation per
   * record for a branch nobody has seen yet.
   */
  private applyChildEvent(childSessionId: string, event: HostSessionEvent): void {
    const branch = this.branches.get(childSessionId);
    if (!branch || this.parentSessionId.length === 0) return;
    if (!branch.reducer.apply(event)) return;
    if (!branch.caughtUp) return;
    this.refresh(branch);
  }

  private refresh(branch: SubagentBranch): void {
    const items = SubagentStreamCoordinator.branchItems(branch.reducer);
    const signature = SubagentStreamCoordinator.branchSignature(items);
    if (signature === branch.signature) return;
    branch.signature = signature;
    branch.items = items;
    branch.changes++;
    this.notify();
  }

  /**
   * The process a child session publishes, in its own order.
   *
   * A child session is an ordinary session: it has its own turns and its own
   * user message (the brief it was spawned with), which the card already shows
   * as the branch title, so only the assistant's items are branch content.
   */
  private static branchItems(reducer: DurableSessionReducer): ChatMessageItemResponse[] {
    const items: ChatMessageItemResponse[] = [];
    reducer.messages().forEach((message: ChatMessage) => {
      if (message.role !== 'assistant') return;
      (message.items || []).forEach((item: ChatMessageItemResponse) => { items.push(item); });
    });
    return items;
  }

  /** Everything about a branch that can change what the card draws. */
  private static branchSignature(items: ChatMessageItemResponse[]): string {
    const parts: string[] = [];
    items.forEach((item: ChatMessageItemResponse) => {
      const tool = item.tool;
      parts.push([
        item.type || '',
        `${(item.content || '').length}`,
        tool ? `${tool.id || ''}:${tool.name || ''}:${tool.status || ''}` : ''
      ].join('\u0000'));
    });
    return `${items.length}\u0001${parts.join('\u0002')}`;
  }

  private detach(): void {
    this.branches.forEach((branch: SubagentBranch) => {
      branch.stream?.close();
      branch.stream = undefined;
    });
    this.branches.clear();
    this.owners.clear();
    this.ownerDigests.clear();
    this.ownerVersions.clear();
    this.parentSessionId = '';
  }
}
