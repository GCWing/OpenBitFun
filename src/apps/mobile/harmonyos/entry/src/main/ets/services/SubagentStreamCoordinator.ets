import { ChatMessage, ChatMessageItemResponse, RemoteToolStatusResponse } from '../model/RemoteModels';
import { DurableSessionReducer } from './DurableSessionReducer';
import { HostSessionCallbacks, HostSessionEvent, HostSessionStream } from './HostSessionStream';
import { RemoteLogger } from './RemoteLogger';

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

/**
 * Where a child branch's records are kept between app launches.
 *
 * This is the phone's own transcript cache, keyed by the child Session id —
 * `RemoteChatBranchCache` adapts `RemoteChatCache`, which is the storage the
 * parent session's transcript already uses. A child is an ordinary session on
 * its own stream id, so its transcript caches the same way; and because the
 * child Session id is what the parent's launching item names, the key is also
 * what maps a stored child back to the parent and the branch that owns it.
 */
export interface SubagentBranchCache {
  loadBranch(sessionId: string): Promise<ChatMessage[]>;
  saveBranch(sessionId: string, messages: ChatMessage[]): Promise<void>;
}

/** How many of a session's children are followed, and how many are waiting for a slot. */
export interface SubagentFollowState {
  branches: number;
  subscribed: number;
  waiting: number;
  /** Steps currently drawn from the transcript cache, i.e. what a cold start had. */
  restored: number;
}

/**
 * How many child sessions one parent session follows at once.
 *
 * Every child is another paged stream read over the same device RPC lane as the
 * parent session, and a delegation wider than this is past what a phone screen
 * presents at once. The cap never costs a card its content: a child that holds
 * no slot keeps the branch it already published (or what the transcript cache
 * holds for it), and takes a slot as soon as one frees or the reader opens its
 * card.
 */
const MAX_CONCURRENT_CHILD_STREAMS: number = 8;

/**
 * Longest a branch's transcript write is held back, in milliseconds.
 *
 * The same interval the parent transcript's own cache write uses, for the same
 * reason: a worker publishing a step at a time would otherwise rewrite (and
 * re-encrypt) the child's whole transcript on the thread that draws the screen.
 */
const BRANCH_CACHE_FLUSH_MS: number = 400;

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
  /** Whether this child's own stream is open right now. */
  subscribed: boolean;
  /** False until the child's first page settled, so its backfill is one publish. */
  caughtUp: boolean;
  /** True when the child's stream failed before it published anything. */
  streamFailed: boolean;
  /**
   * Steps read back from the transcript cache, i.e. what this branch published
   * in an earlier launch of the app. They are merged with whatever the child's
   * stream publishes now, never replaced by it: a child stream can start at its
   * newest page, so the cached prefix is the only copy of its earlier steps.
   */
  cached: ChatMessageItemResponse[];
  /**
   * The outcome the cached transcript ended on: running, completed or failed.
   *
   * A worker this phone watched before a restart is the one case where no stream
   * will ever say how it ended — the records it published are on the host, and a
   * host that is gone answers nothing — so its stored outcome is the only
   * reading of it left.
   */
  cachedStatus: string;
  items: ChatMessageItemResponse[];
  /** How many times this branch's content or status changed. Monotonic per branch. */
  changes: number;
  signature: string;
  /**
   * The worker's own lifecycle, derived from its stream: running, completed or
   * failed. Empty means this coordinator has nothing to say about the worker,
   * e.g. its stream failed before it published anything.
   */
  status: string;
  /**
   * Whether that reading came from the worker's own stream.
   *
   * A branch restored from the transcript cache answers with the outcome it was
   * stored with, and that is not a worker this session has seen finish: a phone
   * that just started holds a stored "completed" for a worker that may be
   * running its next turn right now. Until this child's stream has read a turn of
   * its own, nothing here is treated as settled — in particular its stream is
   * kept, because releasing it is what would make the stored reading permanent.
   */
  liveStatus: boolean;
  /** Monotonic stamp of when this child was last seen working; decides release order. */
  lastActivity: number;
  /** Pending transcript write, or -1 when none is scheduled. */
  flushTimer: number;
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
 *
 * Two facts about a branch are read from two different places, and are kept
 * apart on purpose:
 *
 * - The launching item's own status is the spawn call's outcome. A host answers
 *   an asynchronous `AgentSpawn` as soon as the worker starts, so that status
 *   says nothing about whether the worker is still working.
 * - The card's lifecycle is the worker's, so it is derived from the child's own
 *   stream here, and only that reading is what the card is fed.
 */
export class SubagentStreamCoordinator {
  private source: SubagentStreamSource;
  private branchCache?: SubagentBranchCache;
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
  /** Child session ids holding no slot, oldest first; newest is served first. */
  private waiters: string[] = [];
  /** Monotonic stamp backing `lastActivity`, so release order needs no clock. */
  private activitySeq: number = 0;

  constructor(source: SubagentStreamSource, notify: () => void, onError: (error: Error) => void,
    branchCache?: SubagentBranchCache) {
    this.source = source;
    this.branchCache = branchCache;
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
    this.openBranch(owner.subagentSessionId || '',
      owner.toolCall ? (owner.toolCall.id || '') : '');
  }

  /**
   * Follows the children the transcript itself names.
   *
   * A session that is read from its cached transcript — a phone that just
   * restarted, or a host that is not answering — delivers no parent records at
   * all, and the durable link is still there: the launching item keeps the child
   * Session id it was recorded with. Discovering children here is what lets a
   * cold or offline view open the same branches, whose steps then come from the
   * branch cache until the child's stream catches up.
   */
  observeParentMessages(messages: ChatMessage[]): void {
    if (this.parentSessionId.length === 0) return;
    messages.forEach((message: ChatMessage) => {
      (message.items || []).forEach((item: ChatMessageItemResponse) => {
        const tool = item.tool;
        if (!tool) return;
        this.openBranch(tool.subagent_session_id || '', tool.id || '');
      });
    });
  }

  /**
   * Makes sure the child behind one launching item is being followed.
   *
   * This is what a reader opening a card asks for. The branch may have lost its
   * slot to the cap, or never had one; either way an open card has to show the
   * worker's own steps rather than a prefix that stopped where its slot did.
   */
  ensureSubscribed(ownerToolCallId: string): void {
    if (this.parentSessionId.length === 0) return;
    const childSessionId = this.owners.get(ownerToolCallId);
    if (childSessionId === undefined) return;
    const branch = this.branches.get(childSessionId);
    if (!branch || branch.subscribed) return;
    RemoteLogger.info(`subagent branch re-attached session=${SubagentStreamCoordinator.shortId(childSessionId)}`);
    this.acquireSubscriber(branch);
  }

  /** What this coordinator currently follows, for previews and focused tests. */
  followState(): SubagentFollowState {
    let restored = 0;
    this.branches.forEach((branch: SubagentBranch) => { restored += branch.cached.length; });
    return {
      branches: this.branches.size,
      subscribed: this.subscribedCount(),
      waiting: this.waiters.length,
      restored: restored
    };
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
      return SubagentStreamCoordinator.ownerItem(item, branch, index, items);
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
   * One launching item, as the card reads it.
   *
   * Two things are replaced and nothing else: the status the card draws is the
   * worker's own lifecycle, and the branch's items are the worker's own process.
   * The launching record's status stays where it belongs — in the digest below,
   * which is what decides whether the card repaints.
   *
   * A host that publishes the process inside its own stream keeps this item on
   * the path it has always used, and needs no branch attached here.
   */
  private static ownerItem(item: ChatMessageItemResponse, branch: SubagentBranch, ownerIndex: number,
    items: ChatMessageItemResponse[]): ChatMessageItemResponse {
    const tool = branch.status.length > 0 ? SubagentStreamCoordinator.toolWithStatus(item.tool, branch.status) : item.tool;
    const subItems = branch.items.length === 0 ||
      SubagentStreamCoordinator.parentCarriesBranchItems(items, ownerIndex) ? item.subItems : branch.items;
    if (tool === item.tool && subItems === item.subItems) return item;
    return {
      type: item.type,
      steering_id: item.steering_id,
      round_index: item.round_index,
      content: item.content,
      tool: tool,
      is_subagent: item.is_subagent,
      subItems: subItems,
      images: item.images
    };
  }

  /** The same tool record, with the worker's lifecycle as its status. */
  private static toolWithStatus(tool: RemoteToolStatusResponse | undefined,
    status: string): RemoteToolStatusResponse | undefined {
    if (!tool) return tool;
    return {
      permission_request_id: tool.permission_request_id,
      id: tool.id,
      name: tool.name,
      status: status,
      duration_ms: tool.duration_ms,
      start_ms: tool.start_ms,
      input_preview: tool.input_preview,
      tool_input: tool.tool_input,
      stdout: tool.stdout,
      stderr: tool.stderr,
      tool_output: tool.tool_output,
      result_preview: tool.result_preview,
      error_preview: tool.error_preview,
      exit_code: tool.exit_code,
      plan: tool.plan,
      subagent_session_id: tool.subagent_session_id
    };
  }

  /**
   * The render version this coordinator publishes for one launch item.
   *
   * Three independent things alter a card: the worker's own process grew, the
   * worker's own lifecycle changed (a turn settling adds no step), and the
   * launch item's own record was updated. A launch settles as soon as the worker
   * starts, and a background worker's launch settles while its stream has
   * nothing new to say, so a version that only counted branch growth would leave
   * the header of exactly that card behind: the row is keyed by what changed in
   * the message, and a tool item's own status is not part of that key. Folding
   * every one of those readings in here means a settled launch repaints the card
   * it belongs to even when its worker publishes no further step.
   *
   * The value is cumulative rather than a per-publication delta: the transcript
   * the controller publishes must be identical when nothing changed, or a row
   * would be rebuilt from a message that no longer carries its branch.
   */
  private ownerVersion(ownerToolCallId: string, branch: SubagentBranch,
    tool?: RemoteToolStatusResponse): number {
    const digest = [
      `${branch.changes}`,
      branch.status,
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
    // A host that names no child session, or names this very session, has no
    // branch to open: the launch item stays the plain tool row it always was.
    if (childSessionId.length === 0 || ownerToolCallId.length === 0) return;
    if (this.parentSessionId === childSessionId) return;
    if (this.owners.has(ownerToolCallId)) return;
    const resumed = this.branches.get(childSessionId);
    if (resumed !== undefined) {
      // The same worker, named by a launch this session has not seen before: a
      // reusable child that was continued. It is one branch — its steps are the
      // worker's, not the launch's — but the launch happening now is what its
      // records have to land under, and a branch the cap released has to be
      // followed again, or the turn it is taking would never arrive. Only a new
      // launch does this: the same launch republished by every poll is not a
      // reason to take a slot back from a worker that is using one.
      this.owners.set(ownerToolCallId, childSessionId);
      resumed.ownerToolCallId = ownerToolCallId;
      resumed.lastActivity = ++this.activitySeq;
      if (!resumed.subscribed) this.acquireSubscriber(resumed);
      return;
    }
    const branch: SubagentBranch = {
      sessionId: childSessionId,
      ownerToolCallId: ownerToolCallId,
      reducer: new DurableSessionReducer(),
      subscribed: false,
      caughtUp: false,
      streamFailed: false,
      cached: [],
      cachedStatus: '',
      items: [],
      changes: 0,
      signature: '',
      status: '',
      liveStatus: false,
      lastActivity: ++this.activitySeq,
      flushTimer: -1
    };
    this.branches.set(childSessionId, branch);
    this.owners.set(ownerToolCallId, childSessionId);
    this.hydrate(branch);
    this.acquireSubscriber(branch);
  }

  /**
   * Reads back what this child published in an earlier launch of the app.
   *
   * The steps land as the branch's cached prefix, and the child's stream is
   * merged into them as it arrives, so a cold start shows a worker's process
   * before (and without) its stream — and a worker whose stream only starts at
   * its newest page keeps the earlier steps it had.
   */
  private hydrate(branch: SubagentBranch): void {
    const cache = this.branchCache;
    if (!cache) return;
    cache.loadBranch(branch.sessionId).then((messages: ChatMessage[]): void => {
      const current = this.branches.get(branch.sessionId);
      // A branch replaced by a session switch belongs to nobody now.
      if (!current || current !== branch) return;
      const cached = SubagentStreamCoordinator.branchItems(messages);
      if (cached.length === 0) return;
      branch.cached = cached;
      branch.cachedStatus = SubagentStreamCoordinator.turnStatus(messages);
      RemoteLogger.info(
        `subagent branch restored session=${SubagentStreamCoordinator.shortId(branch.sessionId)} ` +
        `steps=${cached.length} status=${branch.cachedStatus}`
      );
      this.refresh(branch);
    }).catch((error: Object): void => {
      RemoteLogger.error(`subagent branch restore failed: ${SubagentStreamCoordinator.reason(error)}`);
    });
  }

  /**
   * Opens a child's stream if this session can follow one more child.
   *
   * Past the cap a slot is taken from another child, oldest activity first and
   * a settled child before a working one: a worker that already reported is the
   * one whose stream can be released for nothing, and a working one that loses
   * its slot keeps the branch it published and waits to be re-attached.
   */
  private acquireSubscriber(branch: SubagentBranch): void {
    if (branch.subscribed) return;
    if (this.subscribedCount() >= MAX_CONCURRENT_CHILD_STREAMS) {
      const victim = this.releaseCandidate(branch);
      if (!victim) {
        this.waitForSlot(branch);
        return;
      }
      this.releaseSubscription(victim, true);
    }
    this.forgetWaiter(branch);
    this.subscribe(branch);
    // Subscribing decides what can be said about the worker: a branch opened
    // over the cap has no reading until this point.
    this.refresh(branch);
  }

  private subscribe(branch: SubagentBranch): void {
    try {
      branch.stream = this.source.subscribeSession(branch.sessionId, {
        onEvent: async (event: HostSessionEvent): Promise<void> => {
          this.applyChildEvent(branch.sessionId, event);
        },
        onCaughtUp: async (): Promise<void> => {
          const current = this.branches.get(branch.sessionId);
          if (!current) return;
          current.caughtUp = true;
          current.streamFailed = false;
          this.refresh(current);
        },
        onGap: async (): Promise<void> => {
          // The host restarted this child's stream: everything reduced so far
          // came from its previous epoch, so it is dropped before the replay.
          const current = this.branches.get(branch.sessionId);
          if (!current) return;
          current.reducer = new DurableSessionReducer();
          current.caughtUp = false;
        },
        onError: (error: Error): void => {
          const current = this.branches.get(branch.sessionId);
          // A child stream that failed before it published anything says nothing
          // about the worker, so no lifecycle is invented for it: the card keeps
          // the launching item's own status. The stream keeps retrying by itself.
          if (current && current.items.length === 0 && current.cached.length === 0) {
            current.streamFailed = true;
            this.refresh(current);
          }
          this.onError(error);
        }
      });
      branch.subscribed = true;
      RemoteLogger.info(
        `subagent branch followed session=${SubagentStreamCoordinator.shortId(branch.sessionId)} ` +
        `streams=${this.subscribedCount()}/${this.branches.size}`
      );
    } catch (_error) {
      // A child stream that cannot be opened is not a reason to fail the
      // session on screen: the launch item keeps its own row and result, and its
      // branch stays empty instead of showing fabricated steps.
      this.releaseSubscription(branch, false);
      if (branch.items.length === 0 && branch.cached.length === 0 && !branch.caughtUp) {
        this.branches.delete(branch.sessionId);
        this.owners.delete(branch.ownerToolCallId);
      }
    }
  }

  /** Closes one child's stream, keeping the branch and everything it published. */
  private releaseSubscription(branch: SubagentBranch, wait: boolean): void {
    const wasSubscribed = branch.subscribed;
    const before = this.subscribedCount();
    branch.stream?.close();
    branch.stream = undefined;
    branch.subscribed = false;
    if (wasSubscribed) {
      RemoteLogger.info(
        `subagent branch released session=${SubagentStreamCoordinator.shortId(branch.sessionId)} ` +
        `streams=${before - 1}/${this.branches.size}`
      );
    }
    // Whatever the child has published so far is written now: this branch may
    // not be the one that is subscribed when its stream would have said more.
    if (branch.changes > 0) this.flushBranch(branch);
    if (wait) this.waitForSlot(branch);
  }

  /**
   * Which child gives up its slot, or undefined when every other child is
   * already waiting.
   *
   * The most recently active children stay followed — a card the reader is
   * watching is the one that just changed — and a settled child goes before a
   * working one, because releasing it cannot lose a step.
   */
  private releaseCandidate(except: SubagentBranch): SubagentBranch | undefined {
    let settled: SubagentBranch | undefined = undefined;
    let oldest: SubagentBranch | undefined = undefined;
    this.branches.forEach((branch: SubagentBranch) => {
      if (branch === except || !branch.subscribed) return;
      if (oldest === undefined || branch.lastActivity < oldest.lastActivity) oldest = branch;
      if (SubagentStreamCoordinator.isSettled(branch) &&
        (settled === undefined || branch.lastActivity < settled.lastActivity)) settled = branch;
    });
    return settled || oldest;
  }

  private waitForSlot(branch: SubagentBranch): void {
    if (this.waiters.indexOf(branch.sessionId) < 0) this.waiters.push(branch.sessionId);
  }

  private forgetWaiter(branch: SubagentBranch): void {
    this.waiters = this.waiters.filter((sessionId: string): boolean => sessionId !== branch.sessionId);
  }

  /**
   * Follows waiting children as slots free, newest first.
   *
   * Newest first because a launch the reader just watched appear is the card
   * most likely to be on screen; the older ones keep their branch and are served
   * when their turn comes or when their card is opened.
   */
  private drainWaiters(): void {
    let budget = this.waiters.length;
    while (budget > 0 && this.subscribedCount() < MAX_CONCURRENT_CHILD_STREAMS) {
      budget--;
      const sessionId = this.waiters.pop();
      if (sessionId === undefined) return;
      const branch = this.branches.get(sessionId);
      if (!branch || branch.subscribed) continue;
      this.acquireSubscriber(branch);
    }
  }

  private subscribedCount(): number {
    let count = 0;
    this.branches.forEach((branch: SubagentBranch) => {
      if (branch.subscribed) count++;
    });
    return count;
  }

  /**
   * A child that has settled: its own stream read a turn of it and no turn of it
   * is in progress.
   *
   * The stream is what makes a branch settled. A reading that came out of the
   * transcript cache is a reading of an earlier launch of the app, and releasing
   * on it would keep a worker that is working right now reported as finished.
   */
  private static isSettled(branch: SubagentBranch): boolean {
    return branch.caughtUp && branch.liveStatus && branch.status.length > 0 && branch.status !== 'running';
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
    branch.streamFailed = false;
    branch.lastActivity = ++this.activitySeq;
    if (!branch.caughtUp) return;
    this.refresh(branch);
  }

  /**
   * Republishes a branch that changed in any way the card can show.
   *
   * The items are what the card draws; the status is what its header says, and a
   * child's turn can settle without publishing another item, so both are
   * compared before the transcript is republished.
   */
  private refresh(branch: SubagentBranch): void {
    const wasSettled = SubagentStreamCoordinator.isSettled(branch);
    const items = SubagentStreamCoordinator.mergeBranchItems(
      branch.cached, SubagentStreamCoordinator.branchItems(branch.reducer.messages()));
    const signature = SubagentStreamCoordinator.branchSignature(items);
    const live = SubagentStreamCoordinator.turnStatus(branch.reducer.messages());
    const status = SubagentStreamCoordinator.childStatus(branch, live);
    branch.liveStatus = live.length > 0;
    if (signature === branch.signature && status === branch.status) return;
    branch.signature = signature;
    branch.items = items;
    branch.status = status;
    branch.changes++;
    this.notify();
    this.scheduleFlush(branch);
    // A settled worker will not publish again, so it costs nothing to stop
    // following it — unless it is the child that just held a slot, in which case
    // its stream has already been closed above. It is the transition that
    // releases: a worker that settled, was continued and then settled again keeps
    // its stream until the cap wants the slot back, which is where a settled
    // branch is the first one to be taken.
    if (!wasSettled && SubagentStreamCoordinator.isSettled(branch) && branch.subscribed) {
      this.releaseSubscription(branch, false);
      this.drainWaiters();
    }
  }

  /**
   * The worker's own lifecycle, as its stream describes it.
   *
   * A child session is an ordinary session with its own turns, so the reading is
   * the child's own: a turn of it still in progress means the worker is working,
   * and the last turn's outcome is what a finished worker reported. Multi-turn
   * children — a worker continued after it answered once — are running again the
   * moment any of their turns is.
   *
   * Nothing is invented from what is missing. Before the child has said anything
   * at all the worker was started and is not finished, so it reads as running;
   * a stream that failed before publishing anything says nothing, and the
   * launching item's own status stands. The one reading that survives a restart
   * is the branch itself: a worker whose stored transcript is all this phone has
   * left is reported at the outcome it was stored with, because its stream will
   * never say more.
   */
  private static childStatus(branch: SubagentBranch, live: string): string {
    if (live.length > 0) return live;
    if (branch.streamFailed && branch.cached.length === 0) return '';
    return branch.caughtUp && branch.cachedStatus.length > 0 ? branch.cachedStatus : 'running';
  }

  /** A child transcript's lifecycle reading, or '' when it holds no turn yet. */
  private static turnStatus(messages: ChatMessage[]): string {
    let sawTurn = false;
    let running = false;
    let lastOutcome = '';
    messages.forEach((message: ChatMessage) => {
      if (message.role !== 'assistant') return;
      sawTurn = true;
      const status = (message.status || '').toLowerCase();
      if (SubagentStreamCoordinator.isRunningStatus(status)) {
        running = true;
        return;
      }
      lastOutcome = SubagentStreamCoordinator.isFailedStatus(status) ? 'failed' : 'completed';
    });
    if (!sawTurn) return '';
    return running ? 'running' : lastOutcome;
  }

  private static isRunningStatus(status: string): boolean {
    return status === 'running' || status === 'active' || status === 'inprogress' ||
      status === 'preparing' || status === 'pending' || status === 'queued';
  }

  private static isFailedStatus(status: string): boolean {
    return status === 'failed' || status === 'error' || status === 'timeout' ||
      status === 'cancelled' || status === 'canceled' || status === 'rejected';
  }

  /**
   * Writes the child's transcript to the phone cache, at most once per interval.
   *
   * A child that is still publishing is not a reason to hold the write back
   * either: the flush is what a later cold start renders from, so the newest
   * state of a worker in progress is worth having.
   *
   * A stored child is one more session in the same per-device store the sessions
   * the reader opens live in, and the store keeps its own bounded number of them.
   * That is the right shelf for it: a child transcript is reconstructible by
   * asking the host for the child's stream again, so being evicted costs a read,
   * not a step.
   */
  private scheduleFlush(branch: SubagentBranch): void {
    if (!this.branchCache || branch.flushTimer !== -1) return;
    branch.flushTimer = setTimeout((): void => {
      branch.flushTimer = -1;
      this.flushBranch(branch);
    }, BRANCH_CACHE_FLUSH_MS);
  }

  private flushBranch(branch: SubagentBranch): void {
    const cache = this.branchCache;
    if (!cache) return;
    const messages = branch.reducer.messages();
    // Nothing of this child's own stream has arrived, so there is nothing to
    // store: writing an empty transcript would erase what the cache holds.
    if (messages.length === 0) return;
    cache.saveBranch(branch.sessionId, messages).catch((error: Object): void => {
      RemoteLogger.error(`subagent branch cache write failed: ${SubagentStreamCoordinator.reason(error)}`);
    });
  }

  /**
   * The process a child session publishes, in its own order.
   *
   * A child session is an ordinary session: it has its own turns and its own
   * user message (the brief it was spawned with), which the card already shows
   * as the branch title, so only the assistant's items are branch content.
   */
  private static branchItems(messages: ChatMessage[]): ChatMessageItemResponse[] {
    const items: ChatMessageItemResponse[] = [];
    messages.forEach((message: ChatMessage) => {
      if (message.role !== 'assistant') return;
      (message.items || []).forEach((item: ChatMessageItemResponse) => { items.push(item); });
    });
    return items;
  }

  /**
   * What the cache restored, with everything the child's stream published since.
   *
   * Neither list can replace the other. The stream replays a child session from
   * its own start, so it restates steps the cache already holds — those are
   * updated in place, which is how a step that finished while the app was closed
   * shows its newer state without a second copy. And a stream can also start
   * only at its newest page, so a cached step the stream never mentions is the
   * only copy of it: it stays where it was.
   */
  private static mergeBranchItems(cached: ChatMessageItemResponse[],
    live: ChatMessageItemResponse[]): ChatMessageItemResponse[] {
    if (cached.length === 0) return live;
    if (live.length === 0) return cached;
    const merged = cached.slice();
    const claimed: boolean[] = merged.map((_item: ChatMessageItemResponse): boolean => false);
    live.forEach((item: ChatMessageItemResponse) => {
      const index = merged.findIndex((candidate: ChatMessageItemResponse, position: number): boolean =>
        !claimed[position] && SubagentStreamCoordinator.sameStep(candidate, item));
      if (index < 0) {
        merged.push(item);
        return;
      }
      claimed[index] = true;
      merged[index] = item;
    });
    return merged;
  }

  /**
   * What makes two branch steps the same piece of work.
   *
   * A tool call is identified by its id, exactly as the transcript grouping
   * identifies it; reasoning and text carry no id, so their kind and content are
   * all there is to tell one from the other. Status and output are deliberately
   * left out: a restated step carries the newer ones for the same step.
   */
  private static sameStep(a: ChatMessageItemResponse, b: ChatMessageItemResponse): boolean {
    const aId = a.tool ? (a.tool.id || '') : '';
    const bId = b.tool ? (b.tool.id || '') : '';
    if (aId.length > 0 || bId.length > 0) return aId.length > 0 && aId === bId;
    return SubagentStreamCoordinator.stepFingerprint(a) === SubagentStreamCoordinator.stepFingerprint(b);
  }

  private static stepFingerprint(item: ChatMessageItemResponse): string {
    return [(item.type || '').toLowerCase(), item.content || ''].join('\u0000');
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

  private static shortId(value: string): string {
    if (value.length <= 10) return value;
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
  }

  private static reason(error: Object): string {
    return error instanceof Error ? error.message : `${error}`;
  }

  private detach(): void {
    this.branches.forEach((branch: SubagentBranch) => {
      if (branch.flushTimer !== -1) {
        clearTimeout(branch.flushTimer);
        branch.flushTimer = -1;
      }
      // The session is closing, so what the child published is written now:
      // the timer that would have written it belongs to a session that is gone.
      if (branch.changes > 0) this.flushBranch(branch);
      branch.stream?.close();
      branch.stream = undefined;
      branch.subscribed = false;
    });
    this.branches.clear();
    this.owners.clear();
    this.ownerDigests.clear();
    this.ownerVersions.clear();
    this.waiters = [];
    this.parentSessionId = '';
  }
}
