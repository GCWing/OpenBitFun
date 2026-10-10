import {
  HostSessionCallbacks,
  HostSessionSource,
  HostSessionStream,
  HostStreamEventWire,
  HostStreamHint,
  HostStreamPage,
  HostStreamReadRequest
} from '../../services/HostSessionStream';

/**
 * A swarm session, published the way a live host publishes one.
 *
 * Two facts this fixture exists to keep straight, both read off a real
 * `Ultimate` session's record stream:
 *
 * 1. The parent stream carries the launch and nothing of the child. An
 *    `AgentSpawn` tool item names the child Session id it started
 *    (`subagentSessionId`, camelCase, exactly as `records_from_turns` serializes
 *    `ToolItemData`), holds the full task brief in `toolCall.input.prompt`, and
 *    answers with a text table of `agent_id / bg_task_id / status`. The rest of
 *    the parent's items are ordinary tool rows.
 * 2. A child's records are an ordinary session's records on the child's own
 *    stream id: thinking, tool and text items with the same key shapes and no
 *    subagent marker anywhere. A worker that ran to completion holds hundreds of
 *    records, so the fixture publishes its history in one page before the
 *    branch that reads it is opened.
 *
 * Nothing here fabricates a child item inside the parent stream. The records a
 * client reads are either the parent's own or a child's own, grouped by which
 * stream they arrived on.
 */

/** Host stream epoch for every fixture stream. */
const SWARM_PREVIEW_EPOCH: number = 1;
/** Fixture-local clock origin; the host stamps real epoch milliseconds. */
const SWARM_PREVIEW_CLOCK: number = 1767225600000;
const SWARM_PREVIEW_TOOL_MS: number = 640;

export const SWARM_PREVIEW_HOST: string = 'swarm-preview-host';
export const SWARM_PARENT_SESSION: string = 'swarm-preview-parent';
/** First worker: finished before its branch was opened, so its history backfills. */
export const SWARM_PAYMENTS_SESSION: string = 'swarm-preview-child-payments';
/** Second worker: still running while the parent's turn is on screen. */
export const SWARM_DOCS_SESSION: string = 'swarm-preview-child-docs';
/** Third worker: its own tools failed and it reported the failure. */
export const SWARM_FLAKY_SESSION: string = 'swarm-preview-child-flaky';
/** The wide delegation: ten workers launched at once, which is what the cap is for. */
export const SWARM_WIDE_PARENT_SESSION: string = 'swarm-preview-parent-wide';
/** Session id a wide worker runs in; the index is appended. */
export const SWARM_WIDE_CHILD_PREFIX: string = 'swarm-preview-wide-child-';
/** How many workers the wide delegation hands out at once. */
export const SWARM_WIDE_WORKERS: number = 10;
/** The dev key the preview's cold start stores its transcripts under. */
export const SWARM_PREVIEW_DEVICE_KEY: string = 'swarm-preview-device';

/**
 * The beats a preview can play, whichever delegation it is playing.
 *
 * The parent session id is part of the script because it is the session a
 * preview opens, and the children are the sessions a cold-start preview has to
 * mute so that only the transcript cache can answer for them.
 */
export interface SwarmBeatScript {
  parentSession(): string;
  childSessions(): string[];
  beatCount(): number;
  position(): number;
  advance(): boolean;
  drain(): void;
}

interface SwarmUserMessage { id: string; content: string; timestamp: number; }
interface SwarmTurnHeader {
  turnId: string; turnIndex: number; sessionId: string; timestamp: number;
  userMessage: SwarmUserMessage; status: string;
}
interface SwarmRoundHeader { id: string; turnId: string; roundIndex: number; timestamp: number; status: string; }
/** A tool call's own input: one flat object, holding only the keys that tool takes. */
export interface SwarmToolInput {
  pattern?: string;
  path?: string;
  glob?: string;
  output_mode?: string;
  file_path?: string;
  offset?: number;
  limit?: number;
  cmd?: string;
  workdir?: string;
  yield_time_ms?: number;
  agent_id?: string;
  agent_type?: string;
  prompt?: string;
  bg_task_ids?: string[];
  timeout_seconds?: number;
}
interface SwarmToolCall { id: string; input: SwarmToolInput; }
interface SwarmToolResult {
  result: string;
  success: boolean;
  resultForAssistant?: string;
  error?: string;
  durationMs?: number;
}
interface SwarmThinkingData {
  id: string; content: string; isStreaming: boolean; isCollapsed: boolean;
  timestamp: number; orderIndex: number; status: string;
}
interface SwarmTextData {
  id: string; content: string; isStreaming: boolean; timestamp: number;
  isMarkdown: boolean; orderIndex: number; status: string;
}
interface SwarmToolData {
  id: string; toolName: string; toolCall: SwarmToolCall; startTime: number;
  orderIndex: number; status: string; toolResult?: SwarmToolResult;
  endTime?: number; durationMs?: number; subagentSessionId?: string;
}
interface SwarmItem { type: string; data: Object; }
interface SwarmRecord {
  sessionId: string; id: string; revision: number; turn: SwarmTurnHeader;
  round?: SwarmRoundHeader; item?: SwarmItem;
}

/** Optional facts a published tool call can carry. */
export interface SwarmToolOptions {
  subagentSessionId?: string;
  success?: boolean;
  status?: string;
  error?: string;
  resultForAssistant?: string;
}

/**
 * One session's record log, published in the host's own order.
 *
 * Records are stamped with a per-session revision that rises with every
 * publication, which is what lets a client deduplicate a replayed page and
 * accept an updated status for an item it already has.
 */
export class SwarmSessionLog {
  readonly sessionId: string;
  private wake: (sessionId: string) => void;
  private turnId: string;
  private userText: string;
  private turnIndex: number;
  private published: HostStreamEventWire[] = [];
  private seq: number = 0;
  private revision: number = 0;
  private itemSeq: number = 0;
  private roundCount: number = -1;
  private roundId: string = '';
  private order: number = 0;
  private clock: number = SWARM_PREVIEW_CLOCK;
  private turnStatus: string = 'inprogress';

  constructor(sessionId: string, turnId: string, userText: string, turnIndex: number,
    wake: (sessionId: string) => void) {
    this.sessionId = sessionId;
    this.turnId = turnId;
    this.userText = userText;
    this.turnIndex = turnIndex;
    this.wake = wake;
  }

  records(): HostStreamEventWire[] { return this.published.slice(); }
  newestSeq(): number { return this.seq; }

  /** Publishes the turn record, which every later record of this log repeats. */
  openTurn(): void {
    this.publish(this.record(`turn/${this.turnId}`, undefined, undefined, true));
  }

  /**
   * Ends the turn this log is publishing, without publishing another item.
   *
   * A host writes a turn's own terminal status when the turn ends, and that
   * status is the only place a finished worker says it is finished: its step
   * count does not change at that moment, so nothing else in the log moves. It is
   * the turn's own record, not a round's: a turn record carries the header the
   * rounds repeat, which is what makes it the state of the turn.
   */
  settleTurn(status: string): void {
    this.turnStatus = status;
    this.publish(this.record(`turn/${this.turnId}`, undefined, undefined, true));
  }

  /** Opens the next model round and publishes it. */
  beginRound(status: string = 'inprogress'): void {
    this.roundCount++;
    this.roundId = `${this.turnId}-round-${this.roundCount}`;
    this.order = 0;
    const round: SwarmRoundHeader = {
      id: this.roundId, turnId: this.turnId, roundIndex: this.roundCount,
      timestamp: this.clock, status
    };
    this.publish(this.record(`round/${this.roundId}`, undefined, round));
  }

  thinking(content: string): void {
    const id = this.nextItemId('thinking');
    const data: SwarmThinkingData = {
      id, content, isStreaming: false, isCollapsed: false,
      timestamp: this.now(), orderIndex: this.order++, status: 'completed'
    };
    this.publishItem('thinking', id, data);
  }

  text(content: string): void {
    const id = this.nextItemId('text');
    const data: SwarmTextData = {
      id, content, isStreaming: false,
      timestamp: this.now(), isMarkdown: true, orderIndex: this.order++, status: 'completed'
    };
    this.publishItem('text', id, data);
  }

  /** A tool call the host has recorded but not finished: status running, no result. */
  toolStarted(id: string, name: string, input: SwarmToolInput, options?: SwarmToolOptions): void {
    this.publishTool(id, name, input, undefined, 'running', options);
  }

  /** The same tool call once its result is known, in the host's status vocabulary. */
  toolFinished(id: string, name: string, input: SwarmToolInput, output: string, options?: SwarmToolOptions): void {
    const status = options?.status ?? ((options?.success === false) ? 'failed' : 'completed');
    this.publishTool(id, name, input, output, status, options);
  }

  private publishTool(id: string, name: string, input: SwarmToolInput, output: string | undefined,
    status: string, options?: SwarmToolOptions): void {
    const start = this.now();
    const data: SwarmToolData = {
      id, toolName: name, toolCall: { id, input }, startTime: start,
      orderIndex: this.order++, status, subagentSessionId: options?.subagentSessionId
    };
    if (output !== undefined) {
      data.endTime = start + SWARM_PREVIEW_TOOL_MS;
      data.durationMs = SWARM_PREVIEW_TOOL_MS;
      data.toolResult = {
        result: output, success: options?.success !== false,
        resultForAssistant: options?.resultForAssistant, error: options?.error,
        durationMs: SWARM_PREVIEW_TOOL_MS
      };
    }
    this.publishItem('tool', id, data);
  }

  private publishItem(type: string, id: string, data: Object): void {
    this.publish(this.record(`item/${id}`, { type, data }));
  }

  private nextItemId(kind: string): string {
    this.itemSeq++;
    return `${this.turnId}-${kind}-${this.itemSeq}`;
  }

  private now(): number {
    this.clock += SWARM_PREVIEW_TOOL_MS;
    return this.clock;
  }

  /**
   * One record of this session's log.
   *
   * A record of a turn's own state carries no round: `turnOnly` is what a turn
   * header published on its own looks like, and a record stamped with the round
   * the log happens to be in is a round's record, not the turn's.
   */
  private record(id: string, item?: SwarmItem, round?: SwarmRoundHeader,
    turnOnly: boolean = false): SwarmRecord {
    this.revision++;
    const record: SwarmRecord = {
      sessionId: this.sessionId, id, revision: this.revision, turn: this.turnHeader()
    };
    if (round) {
      record.round = round;
    } else if (!turnOnly && this.roundId.length > 0) {
      record.round = {
        id: this.roundId, turnId: this.turnId, roundIndex: this.roundCount,
        timestamp: this.clock, status: this.turnStatus
      };
    }
    if (item) record.item = item;
    return record;
  }

  private turnHeader(): SwarmTurnHeader {
    return {
      turnId: this.turnId, turnIndex: this.turnIndex, sessionId: this.sessionId, timestamp: this.clock,
      userMessage: { id: `${this.turnId}-user`, content: this.userText, timestamp: this.clock },
      status: this.turnStatus
    };
  }

  private publish(payload: Object): void {
    this.seq++;
    this.published.push({ seq: this.seq, event: 'session-record', payload });
    this.wake(this.sessionId);
  }
}

/** Serves every fixture stream out of the one record log of its session. */
class SwarmStreamSource implements HostSessionSource {
  target: string = SWARM_PREVIEW_HOST;
  private ledger: SwarmLedger;
  private sessionId: string;

  constructor(ledger: SwarmLedger, sessionId: string) {
    this.ledger = ledger;
    this.sessionId = sessionId;
  }

  async read(request: HostStreamReadRequest): Promise<HostStreamPage> {
    return this.ledger.page(this.sessionId, request);
  }

  async unsubscribe(): Promise<void> {}

  /** The fixture never pushes hints; a publication wakes the stream instead. */
  onHint(_listener: (hint: HostStreamHint) => void): () => void {
    return (): void => {};
  }

  onReconnect(_listener: () => void): () => void {
    return (): void => {};
  }
}

/**
 * The fixture's stream transport: one log per session id, opened on demand.
 *
 * `openStream` is the same call the runtime connection makes for a session on
 * screen, so a child stream is read by the production stream reader — paging,
 * epoch, cursor and dedup included — and not by a fixture-shaped shortcut.
 */
export class SwarmLedger {
  private logs: Map<string, SwarmSessionLog> = new Map<string, SwarmSessionLog>();
  private streams: Map<string, HostSessionStream> = new Map<string, HostSessionStream>();
  private muted: Set<string> = new Set<string>();

  /** Creates (once) the log a session publishes into. */
  open(sessionId: string, turnId: string, userText: string, turnIndex: number = 0): SwarmSessionLog {
    const existing = this.logs.get(sessionId);
    if (existing) return existing;
    const log = new SwarmSessionLog(sessionId, turnId, userText, turnIndex,
      (woken: string): void => { this.wake(woken); });
    this.logs.set(sessionId, log);
    return log;
  }

  /**
   * Stops these sessions from answering, the way a host that is gone answers.
   *
   * A cold-start preview reads the session on screen from the record log it
   * publishes, and the workers it launched from nowhere at all: whatever a card
   * still shows at that point came from the transcript cache, which is exactly
   * what a phone that just restarted has.
   */
  muteSessions(sessionIds: string[]): void {
    sessionIds.forEach((sessionId: string): void => { this.muted.add(sessionId); });
  }

  openStream(sessionId: string, callbacks: HostSessionCallbacks): HostSessionStream {
    const stream = new HostSessionStream(sessionId, new SwarmStreamSource(this, sessionId), callbacks);
    this.streams.set(sessionId, stream);
    return stream;
  }

  /** A read page for one session: everything after the caller's cursor. */
  page(sessionId: string, request: HostStreamReadRequest): HostStreamPage {
    const log = this.logs.get(sessionId);
    const records: HostStreamEventWire[] = log && !this.muted.has(sessionId) ? log.records() : [];
    const cursor = log ? log.newestSeq() : 0;
    const after = request.after ?? 0;
    const page: HostStreamPage = {
      resp: 'stream_page', stream_id: sessionId, epoch: SWARM_PREVIEW_EPOCH, cursor,
      events: records.filter((entry: HostStreamEventWire) => entry.seq > after),
      has_more: false, oldest_seq: records.length > 0 ? records[0].seq : 1, truncated: false
    };
    return page;
  }

  private wake(sessionId: string): void {
    this.streams.get(sessionId)?.wake();
  }
}

/**
 * The swarm the preview plays out, one beat at a time.
 *
 * Each beat publishes the records a live host would publish at that moment.
 * Beats exist so the fixture can be captured mid-flight — a worker's steps
 * arriving one page at a time — instead of only in its finished state.
 */
export class SwarmScript implements SwarmBeatScript {
  private ledger: SwarmLedger;
  private parent: SwarmSessionLog;
  private payments: SwarmSessionLog;
  private docs: SwarmSessionLog;
  private flaky: SwarmSessionLog;
  private beats: (() => void)[] = [];
  private cursor: number = 0;

  constructor(ledger: SwarmLedger) {
    this.ledger = ledger;
    this.parent = ledger.open(SWARM_PARENT_SESSION, 'swarm-parent-turn-1',
      'Audit the payments module with a swarm and report what each worker found.', 0);
    this.payments = ledger.open(SWARM_PAYMENTS_SESSION, 'swarm-payments-turn-1', SWARM_PAYMENTS_BRIEF, 0);
    this.docs = ledger.open(SWARM_DOCS_SESSION, 'swarm-docs-turn-1', SWARM_DOCS_BRIEF, 0);
    this.flaky = ledger.open(SWARM_FLAKY_SESSION, 'swarm-flaky-turn-1', SWARM_FLAKY_BRIEF, 0);
    this.beats = [
      (): void => { this.beatOpening(); },
      (): void => { this.beatSpawnPayments(); },
      (): void => { this.beatSpawnFlaky(); },
      (): void => { this.beatSpawnDocs(); },
      (): void => { this.beatDocsThinking(); },
      (): void => { this.beatDocsSearchStarted(); },
      (): void => { this.beatDocsSearchFinished(); },
      (): void => { this.beatWait(); },
      (): void => { this.beatParentRows(); },
      (): void => { this.beatDocsReadPlan(); },
      (): void => { this.beatDocsGrepStarted(); },
      (): void => { this.beatDocsGrepFinished(); },
      (): void => { this.beatDocsReadStarted(); },
      (): void => { this.beatDocsSpawnSettles(); },
      // The workers answer, one turn at a time, after the parent has collected
      // them: a worker's turn can end without publishing another step, so these
      // beats are the only thing that moves a card's status.
      (): void => { this.payments.settleTurn('completed'); },
      (): void => { this.flaky.settleTurn('error'); },
      (): void => { this.docs.settleTurn('completed'); }
    ];
  }

  parentSession(): string { return SWARM_PARENT_SESSION; }
  childSessions(): string[] { return [SWARM_PAYMENTS_SESSION, SWARM_FLAKY_SESSION, SWARM_DOCS_SESSION]; }

  /** How many beats the swarm has; a driver stops when `advance` answers false. */
  beatCount(): number { return this.beats.length; }
  /** The beat that will be published next; equals `beatCount` when finished. */
  position(): number { return this.cursor; }

  /** Publishes the next beat; false when the swarm script has nothing left. */
  advance(): boolean {
    if (this.cursor >= this.beats.length) return false;
    const beat = this.beats[this.cursor];
    this.cursor++;
    beat();
    return true;
  }

  /** Publishes every remaining beat at once. */
  drain(): void {
    while (this.advance()) {
    }
  }

  // ── Beats ────────────────────────────────────────────────────────────────

  /** The parent's turn opens and it states what it is about to hand out. */
  private beatOpening(): void {
    const parent = this.parent;
    parent.openTurn();
    parent.beginRound();
    parent.thinking(PARENT_PLAN_REASONING);
    parent.text(PARENT_PLAN_TEXT);
  }

  /**
   * First worker launched, and it had already finished by the time the parent
   * published the launch: its history arrives as the child page the branch
   * reads, not as records inside the parent stream.
   */
  private beatSpawnPayments(): void {
    const payments = this.payments;
    payments.openTurn();
    payments.beginRound();
    payments.thinking('Locate every payment entry point before reading any of them.');
    payments.toolFinished('swarm-payments-search', 'Grep',
      { pattern: 'charge|refund|invoice', path: 'src/payments', output_mode: 'files_with_matches' },
      PAYMENTS_GREP_OUTPUT);
    payments.beginRound();
    payments.toolFinished('swarm-payments-read-a', 'Read',
      { file_path: 'src/payments/charge.ts', limit: 120 }, PAYMENTS_READ_A_OUTPUT);
    payments.thinking('The retry path re-enters the charge guard without the idempotency key.');
    payments.toolFinished('swarm-payments-read-b', 'Read',
      { file_path: 'src/payments/retry.ts', limit: 80 }, PAYMENTS_READ_B_OUTPUT);
    payments.beginRound();
    payments.text(PAYMENTS_REPORT);
    this.parent.toolFinished('swarm-payments-spawn', 'AgentSpawn', {
      agent_id: 'swarm-payments', agent_type: 'Explore', prompt: SWARM_PAYMENTS_BRIEF
    }, spawnTable('swarm-payments', 'bg-7f21c9'), {
      subagentSessionId: SWARM_PAYMENTS_SESSION, resultForAssistant: PAYMENTS_REPORT
    });
  }

  /** Third worker: its own tools failed, and it reported that back. */
  private beatSpawnFlaky(): void {
    const flaky = this.flaky;
    flaky.openTurn();
    flaky.beginRound();
    flaky.thinking('Run the migration check first; it is the only way to know the schema state.');
    flaky.toolFinished('swarm-flaky-exec', 'ExecCommand', {
      cmd: 'pnpm run migrate:check --json', workdir: '/workspace/app', yield_time_ms: 20000
    }, FLAKY_EXEC_OUTPUT, {
      success: false, error: 'script "migrate:check" does not exist in this workspace'
    });
    flaky.beginRound();
    flaky.text(FLAKY_REPORT);
    this.parent.toolFinished('swarm-flaky-spawn', 'AgentSpawn', {
      agent_id: 'swarm-flaky', agent_type: 'Explore', prompt: SWARM_FLAKY_BRIEF
    }, 'agent_id        bg_task_id      status\nswarm-flaky     bg-3c81ab        failed', {
      subagentSessionId: SWARM_FLAKY_SESSION, success: false, status: 'error',
      error: 'the worker could not run its workspace check'
    });
  }

  /** Second worker launched into the background: the call returns, the worker keeps going. */
  private beatSpawnDocs(): void {
    this.parent.beginRound();
    this.parent.toolStarted('swarm-docs-spawn', 'AgentSpawn', {
      agent_id: 'swarm-docs', agent_type: 'Explore', prompt: SWARM_DOCS_BRIEF
    }, { subagentSessionId: SWARM_DOCS_SESSION });
  }

  private beatDocsThinking(): void {
    const docs = this.docs;
    docs.openTurn();
    docs.beginRound();
    docs.thinking('Start from the documentation index, then follow every link into the guides.');
  }

  private beatDocsSearchStarted(): void {
    this.docs.toolStarted('swarm-docs-search', 'Grep', {
      pattern: 'quickstart|getting-started', path: 'docs', glob: '*.md'
    });
  }

  private beatDocsSearchFinished(): void {
    this.docs.toolFinished('swarm-docs-search', 'Grep', {
      pattern: 'quickstart|getting-started', path: 'docs', glob: '*.md'
    }, DOCS_GREP_OUTPUT);
  }

  /** The parent collects the background workers it handed out. */
  private beatWait(): void {
    this.parent.beginRound();
    this.parent.toolFinished('swarm-wait', 'AgentWait', {
      bg_task_ids: ['bg-7f21c9', 'bg-3c81ab', 'bg-9d40e2'], timeout_seconds: 600
    }, SWARM_WAIT_REPORT);
  }

  /**
   * Ordinary parent work, published while the last worker is still streaming.
   *
   * These rows are the parent's own: nothing may fold them into a card just
   * because a launch precedes them.
   */
  private beatParentRows(): void {
    const parent = this.parent;
    parent.beginRound();
    parent.toolFinished('swarm-parent-grep', 'Grep', {
      pattern: 'swarm', path: 'src/agents', output_mode: 'files_with_matches'
    }, PARENT_GREP_OUTPUT);
    parent.toolFinished('swarm-parent-read', 'Read', {
      file_path: 'src/agents/swarm.ts', limit: 60
    }, PARENT_READ_OUTPUT);
  }

  private beatDocsReadPlan(): void {
    const docs = this.docs;
    docs.beginRound();
    docs.thinking('Two guides disagree about the install step; read both before writing the summary.');
  }

  private beatDocsGrepStarted(): void {
    this.docs.toolStarted('swarm-docs-links', 'Grep', {
      pattern: 'npm install|pnpm install', path: 'docs/guides'
    });
  }

  private beatDocsGrepFinished(): void {
    this.docs.toolFinished('swarm-docs-links', 'Grep', {
      pattern: 'npm install|pnpm install', path: 'docs/guides'
    }, DOCS_LINKS_OUTPUT);
  }

  private beatDocsReadStarted(): void {
    this.docs.toolStarted('swarm-docs-read', 'Read', {
      file_path: 'docs/guides/install.md', offset: 1, limit: 60
    });
  }

  /** The launch settles while its worker is still running. */
  private beatDocsSpawnSettles(): void {
    this.parent.toolFinished('swarm-docs-spawn', 'AgentSpawn', {
      agent_id: 'swarm-docs', agent_type: 'Explore', prompt: SWARM_DOCS_BRIEF
    }, spawnTable('swarm-docs', 'bg-9d40e2'), { subagentSessionId: SWARM_DOCS_SESSION });
  }
}

/**
 * The wide delegation: ten workers handed out at once.
 *
 * This is the delegation the follow cap exists for. Every launch is answered with
 * the status the host answers a background worker with, so every card's own
 * launch record says the call is done while its worker has only just started;
 * each worker then publishes one step of its own. What the preview reads back is
 * ten cards holding ten workers' process while only the cap's worth of child
 * streams are open, and which of those streams is open follows what the reader
 * opened and what finished.
 */
export class SwarmWideScript implements SwarmBeatScript {
  private parent: SwarmSessionLog;
  private children: SwarmSessionLog[] = [];
  private beats: (() => void)[] = [];
  private cursor: number = 0;

  constructor(ledger: SwarmLedger) {
    this.parent = ledger.open(SWARM_WIDE_PARENT_SESSION, 'swarm-wide-turn-1', SWARM_WIDE_PROMPT, 0);
    for (let index = 0; index < SWARM_WIDE_WORKERS; index++) {
      this.children.push(ledger.open(wideChildSession(index), `swarm-wide-turn-${index}`,
        SWARM_WIDE_BRIEF, 0));
    }
    this.beats.push((): void => { this.beatOpening(); });
    for (let index = 0; index < SWARM_WIDE_WORKERS; index++) {
      this.beats.push((): void => { this.beatSpawn(index); });
    }
    for (let index = 0; index < SWARM_WIDE_WORKERS; index++) {
      this.beats.push((): void => { this.beatWorkerStep(index); });
    }
  }

  parentSession(): string { return SWARM_WIDE_PARENT_SESSION; }

  childSessions(): string[] {
    const sessions: string[] = [];
    for (let index = 0; index < this.children.length; index++) sessions.push(wideChildSession(index));
    return sessions;
  }

  beatCount(): number { return this.beats.length; }
  position(): number { return this.cursor; }

  advance(): boolean {
    if (this.cursor >= this.beats.length) return false;
    const beat = this.beats[this.cursor];
    this.cursor++;
    beat();
    return true;
  }

  drain(): void {
    while (this.advance()) {
    }
  }

  private beatOpening(): void {
    const parent = this.parent;
    parent.openTurn();
    parent.beginRound();
    parent.thinking(SWARM_WIDE_PLAN_REASONING);
    parent.text(SWARM_WIDE_PLAN_TEXT);
  }

  /** One launch, answered at once: the worker behind it has not reported yet. */
  private beatSpawn(index: number): void {
    this.parent.beginRound();
    this.parent.toolFinished(wideSpawnId(index), 'AgentSpawn', {
      agent_id: wideAgentId(index), agent_type: 'Explore', prompt: SWARM_WIDE_BRIEF
    }, spawnTable(wideAgentId(index), `bg-${index}4c0a1`), { subagentSessionId: wideChildSession(index) });
  }

  /** The worker's own first step, published on the worker's own stream. */
  private beatWorkerStep(index: number): void {
    const child = this.children[index];
    child.openTurn();
    child.beginRound();
    child.thinking(SWARM_WIDE_WORKER_THINKING);
    child.toolFinished(wideStepId(index), 'Grep', {
      pattern: 'audit', path: `src/area-${index}`, output_mode: 'files_with_matches'
    }, `src/area-${index}/index.ts`);
  }
}

/** The session one wide worker runs in. */
export function wideChildSession(index: number): string {
  return `${SWARM_WIDE_CHILD_PREFIX}${index}`;
}

/** The tool call that launched one wide worker; what its card is keyed by. */
export function wideSpawnId(index: number): string {
  return `swarm-wide-spawn-${index}`;
}

function wideAgentId(index: number): string {
  return `audit-area-${index}`;
}

function wideStepId(index: number): string {
  return `swarm-wide-grep-${index}`;
}

/** The text table an `AgentSpawn` answers with while its worker runs. */
function spawnTable(agentId: string, bgTaskId: string): string {
  return ['agent_id          bg_task_id      status', `${agentId}     ${bgTaskId}        started`].join('\n');
}

/**
 * The brief a worker is spawned with: the full task text, mixed Markdown, long
 * enough that the card's one-line title is the part a reader can see.
 */
const SWARM_PAYMENTS_BRIEF: string = [
  'Audit the payments module and report only what you can prove from the code.',
  '',
  'Steps:',
  '1. find every entry point that can charge or refund a customer;',
  '2. read the retry, idempotency and ledger paths end to end;',
  '3. name each defect with file, symbol and the input that triggers it;',
  '4. state explicitly what you could not verify.',
  '',
  'Do not refactor anything. Do not run the test suite; this workspace has no',
  'payment fixtures. Your report is read by another agent, so keep it factual.'
].join('\n');

const SWARM_DOCS_BRIEF: string = [
  'Check the documentation for drift against the shipped CLI.',
  '',
  'Walk docs/ from the index, follow every internal link, and record each place',
  'where a command, flag or default differs from what the binary does today.',
  'Report the drift with the file and the line that has to change.'
].join('\n');

const SWARM_FLAKY_BRIEF: string = [
  'Verify the database migrations can be replayed from an empty schema.',
  'Run the workspace check script and report its exit status verbatim.'
].join('\n');

const PARENT_PLAN_REASONING: string =
  'The audit splits into independent areas, so hand each one to a worker and collect their reports.';
const PARENT_PLAN_TEXT: string =
  'I will run three workers in parallel: payment entry points, documentation drift, and a migration replay.';

const SWARM_WIDE_PROMPT: string =
  'Audit every area of the workspace at once and report which ones a reader should look at first.';
const SWARM_WIDE_BRIEF: string = [
  'Audit one area of the workspace and report the entry points it exposes.',
  'Name each file you read and state what the area is responsible for.'
].join('\n');
const SWARM_WIDE_PLAN_REASONING: string =
  'Ten areas, one worker each: the widest delegation this phone has had to draw.';
const SWARM_WIDE_PLAN_TEXT: string =
  'I will hand the audit to ten workers and follow every one of their streams.';
const SWARM_WIDE_WORKER_THINKING: string =
  'Read the area index first, then name what it covers.';

const PAYMENTS_GREP_OUTPUT: string = [
  'src/payments/charge.ts', 'src/payments/refund.ts', 'src/payments/retry.ts',
  'src/payments/invoice.ts', 'src/payments/ledger.ts'
].join('\n');

const PAYMENTS_READ_A_OUTPUT: string = [
  'export async function charge(request: ChargeRequest): Promise<ChargeResult> {',
  '  const key = request.idempotencyKey ?? randomKey();',
  '  return ledger.append(await gateway.charge(request, key));',
  '}'
].join('\n');

const PAYMENTS_READ_B_OUTPUT: string = [
  'export async function retry(captured: Captured): Promise<ChargeResult> {',
  '  // The guard runs again before the key is restored from the capture.',
  '  if (captured.attempts > MAX_ATTEMPTS) throw new RetryExhausted(captured);',
  '  return charge(captured.request);',
  '}'
].join('\n');

const PAYMENTS_REPORT: string = [
  'Reported two defects and one gap.',
  '',
  '- retry.ts re-enters charge() without restoring the captured idempotency key,',
  '  so a retried charge is recorded twice in the ledger (charge.ts:12, retry.ts:4).',
  '- invoice.ts rounds the taxable amount before summing line items, which drifts',
  '  by one cent on invoices with more than four lines.',
  '- I could not verify the refund path: it needs a signed ledger entry this',
  '  workspace cannot produce.'
].join('\n');

const FLAKY_EXEC_OUTPUT: string =
  'ERR_PNPM_NO_SCRIPT  Missing script: migrate:check\nCommand failed with exit code 1.';

const FLAKY_REPORT: string = [
  'The migration replay could not be attempted.',
  '',
  'The workspace has no migrate:check script, so the check I was asked to run does',
  'not exist here. Everything else in this brief depends on it, so this worker',
  'stopped rather than reporting a result it could not prove.'
].join('\n');

const DOCS_GREP_OUTPUT: string = [
  'docs/index.md', 'docs/guides/quickstart.md', 'docs/guides/install.md', 'docs/reference/cli.md'
].join('\n');

const DOCS_LINKS_OUTPUT: string = [
  'docs/guides/install.md:18:  pnpm install',
  'docs/guides/install.md:31:  pnpm add -g openbitfun',
  'docs/guides/quickstart.md:12:  npm install -g openbitfun'
].join('\n');

const SWARM_WAIT_REPORT: string = [
  'Two workers reported, one failed.',
  '',
  'payments: double ledger entry on retry, invoice rounding drift.',
  'docs: quickstart.md still installs with npm while the CLI ships as pnpm.',
  'flaky: could not run its check; the script it was told to use does not exist.'
].join('\n');

const PARENT_GREP_OUTPUT: string = 'src/agents/swarm.ts\nsrc/agents/swarm/plan.ts';

const PARENT_READ_OUTPUT: string = [
  'export function planWorkers(areas: AuditArea[]): WorkerPlan {',
  '  return areas.map((area) => ({ area, agentType: area.preferredAgent }));',
  '}'
].join('\n');
