import {
  ChatMessage,
  RemoteImageContext,
  REMOTE_CAPABILITY_SESSION_ROLLBACK_V1,
  SessionRolledBackResult,
  SteerTurnResult
} from '../../model/RemoteModels';
import { RemoteChatCommandClient } from '../../services/RemoteChatCommandController';

/**
 * The mock host and the mock transcript behind the staged-rollback fixture.
 *
 * The frozen interaction (`.openbitfun/plans/mobile-copy-rollback.plan.md`,
 * decision 4) can only be read on a device: the entry rides a system selection
 * menu, the ghosts and the bar are drawn by the production pane, and the composer
 * is refilled through it. No paired host is reachable from an emulator, so the
 * fixture poses as one: it answers `rollback_session_to_turn` with a canned
 * response derived from the transcript it is showing, and it records the calls it
 * received so the order between the rollback and the send that follows it can be
 * read off a screenshot.
 *
 * Everything here is data and a transport, deliberately away from ArkUI: the
 * variant table, the transcript, the canned answer and the recorded call order
 * are all reachable from a host test (`tools/tests/rollback-preview.test.cjs`),
 * so the fixture cannot claim an answer its own transcript would not produce.
 */

/** Which answer the mock host gives. One variant per device-verification cell. */
export enum RollbackPreviewVariant {
  /** The host retires the target turn and everything after it. */
  Success = 'success',
  /** The host refuses the rollback for a reason the client must say out loud. */
  RollbackFailed = 'rollback_failed',
  /** The host no longer holds the turn this client addressed. */
  StaleTarget = 'stale_target',
  /** A turn is running, so the rollback entry refuses before any command. */
  SessionBusy = 'session_busy',
  /** The handshake never advertised `session_rollback_v1`. */
  HostUnsupported = 'host_unsupported',
  /** The rollback succeeds and the message staged with it is accepted. */
  SendAccepted = 'send_accepted',
  /** The rollback succeeds and the message staged with it is refused. */
  SendFailed = 'send_failed'
}

/** One mock turn: the user prompt the host can be rolled back to. */
export class RollbackPreviewTurn {
  readonly turnId: string;
  readonly prompt: string;

  constructor(turnId: string, prompt: string) {
    this.turnId = turnId;
    this.prompt = prompt;
  }
}

export class RollbackPreviewScenario {
  static readonly DEFAULT_ID: string = 'copy-rollback';
  private static readonly DARK_SUFFIX: string = '-dark';
  /** The refusal every other failure is, as the host words it. */
  static readonly FAILED_ERROR: string = 'Preview rollback was refused';
  /** One of the coordinator's own stale-target markers, verbatim. */
  static readonly STALE_ERROR: string = 'Session rollback target is stale';
  static readonly SEND_FAILED_ERROR: string = 'Preview send was refused';
  /** Two files, so the notice row's file count is a number the transcript cannot supply. */
  static readonly RESTORED_FILES: string[] = [
    'src/mobile/ChatTimeline.ets',
    'src/mobile/RollbackStagingBar.ets'
  ];
  /** The turn the mock host reports for an accepted send. */
  static readonly ACCEPTED_TURN_ID: string = 'turn-7';
  /**
   * The draft the composer already holds when the fixture opens, so "close restores
   * the pre-staging snapshot" is a comparison between two readable strings rather
   * than between one string and an empty field.
   */
  static readonly INITIAL_DRAFT: string = 'DRAFT-未发送的草稿-42';

  /** The scenario id without its colour-mode suffix, which never changes the variant. */
  static baseId(scenarioId: string): string {
    const id = scenarioId.length > 0 ? scenarioId : RollbackPreviewScenario.DEFAULT_ID;
    return id.endsWith(RollbackPreviewScenario.DARK_SUFFIX) ?
      id.substring(0, id.length - RollbackPreviewScenario.DARK_SUFFIX.length) : id;
  }

  static isDark(scenarioId: string): boolean {
    return (scenarioId.length > 0 ? scenarioId : RollbackPreviewScenario.DEFAULT_ID)
      .endsWith(RollbackPreviewScenario.DARK_SUFFIX);
  }

  static variant(scenarioId: string): RollbackPreviewVariant {
    switch (RollbackPreviewScenario.baseId(scenarioId)) {
      case 'copy-rollback-fail':
        return RollbackPreviewVariant.RollbackFailed;
      case 'copy-rollback-stale':
        return RollbackPreviewVariant.StaleTarget;
      case 'copy-rollback-busy':
        return RollbackPreviewVariant.SessionBusy;
      case 'copy-rollback-unsupported':
        return RollbackPreviewVariant.HostUnsupported;
      case 'copy-rollback-send':
        return RollbackPreviewVariant.SendAccepted;
      case 'copy-rollback-send-fail':
        return RollbackPreviewVariant.SendFailed;
      default:
        return RollbackPreviewVariant.Success;
    }
  }

  /**
   * What the handshake advertised. A host that never promised the capability is
   * the one case where the entry is refused for a fact about the connection
   * rather than about the session.
   */
  static hostCapabilities(variant: RollbackPreviewVariant): string[] {
    if (variant === RollbackPreviewVariant.HostUnsupported) {
      return ['dialog_steer_v1'];
    }
    return ['dialog_steer_v1', REMOTE_CAPABILITY_SESSION_ROLLBACK_V1];
  }

  static sessionBusy(variant: RollbackPreviewVariant): boolean {
    return variant === RollbackPreviewVariant.SessionBusy;
  }

  static initialDraft(_variant: RollbackPreviewVariant): string {
    return RollbackPreviewScenario.INITIAL_DRAFT;
  }

  /** The host's refusal for a rollback, or an empty string when it accepts. */
  static rollbackError(variant: RollbackPreviewVariant): string {
    if (variant === RollbackPreviewVariant.RollbackFailed) {
      return RollbackPreviewScenario.FAILED_ERROR;
    }
    if (variant === RollbackPreviewVariant.StaleTarget) {
      return RollbackPreviewScenario.STALE_ERROR;
    }
    return '';
  }

  /** Whether the message sent alongside the rollback reaches the host at all. */
  static sendFails(variant: RollbackPreviewVariant): boolean {
    return variant === RollbackPreviewVariant.SendFailed;
  }
}

/**
 * The mock conversation: three turns, each a user prompt and its answer.
 *
 * Three shapes are needed and each of them is one entry surface: a short prompt
 * whose long press raises the system selection menu, an eleven-line prompt the
 * bubble truncates and a long press opens the lightweight menu on, and a
 * third turn whose rows make "the target and everything after it" a cut with
 * more than one turn behind it.
 */
export class RollbackPreviewTranscript {
  static readonly SESSION_ID: string = 'rollback-preview';
  static readonly SHORT_PROMPT: string = '这段代码为什么会有内存泄漏？';
  /**
   * Eleven lines against the eight-line rule, so the bubble truncates it and the
   * entry is reached through the truncated bubble's own menu.
   */
  static readonly LONG_PROMPT: string = [
    '请按下面的清单完整处理这次改动：',
    '1. 在会话时间线里定位用户消息的渲染路径；',
    '2. 为长消息加截断预览，并在行尾追加可点开的入口；',
    '3. 面板内要能长按选择并复制，手柄可以调整范围；',
    '4. 截断态气泡不给手柄，长按弹出轻量菜单；',
    '5. 暂存回滚要能预览被撤回的消息，再决定去留；',
    '6. 关闭、直接发送、确认回滚三条出口都要走一遍；',
    '7. 回滚成功后草稿必须保留，并且给出提示行；',
    '8. 浅色与深色主题都要检查对比度；',
    '9. 竖屏与平板横屏两种布局都要走一遍；',
    '10. 最后把设备证据截图归档。'
  ].join('\n');
  static readonly TAIL_PROMPT: string = '再补一条：深色主题与平板横屏也各走一遍。';

  static turns(): RollbackPreviewTurn[] {
    return [
      new RollbackPreviewTurn('turn-1', RollbackPreviewTranscript.SHORT_PROMPT),
      new RollbackPreviewTurn('turn-3', RollbackPreviewTranscript.LONG_PROMPT),
      new RollbackPreviewTurn('turn-5', RollbackPreviewTranscript.TAIL_PROMPT)
    ];
  }

  static messages(): ChatMessage[] {
    return [
      RollbackPreviewTranscript.message('preview-user-1', 'user', RollbackPreviewTranscript.SHORT_PROMPT, 'turn-1'),
      RollbackPreviewTranscript.message('preview-answer-1', 'assistant',
        '截断与全文面板都需要自己的选择表面，我先确认这两条路径。', 'turn-1'),
      RollbackPreviewTranscript.message('preview-user-3', 'user', RollbackPreviewTranscript.LONG_PROMPT, 'turn-3'),
      RollbackPreviewTranscript.message('preview-answer-3', 'assistant',
        '清单收到，我先按顺序改渲染路径，再回到这里核对回滚入口。', 'turn-3'),
      RollbackPreviewTranscript.message('preview-user-5', 'user', RollbackPreviewTranscript.TAIL_PROMPT, 'turn-5'),
      RollbackPreviewTranscript.message('preview-answer-5', 'assistant',
        '深色主题与横屏布局会各跑一遍。', 'turn-5')
    ];
  }

  /** The prompt a turn was sent with, which is what the host hands back to edit. */
  static promptFor(turnId: string): string {
    const turns = RollbackPreviewTranscript.turns();
    for (let index = 0; index < turns.length; index += 1) {
      if (turns[index].turnId === turnId) {
        return turns[index].prompt;
      }
    }
    return '';
  }

  /**
   * The turn ids the host retires for one target, in transcript order.
   *
   * `retired_turn_ids` includes the target turn itself (see `RemoteModels`), so
   * this is the target's turn and every turn after it — derived from the rows the
   * fixture shows rather than written out, because a canned list that disagreed
   * with the transcript would be a mock answering about history that is not on
   * screen.
   */
  static retiredTurnIds(targetTurnId: string): string[] {
    const rows = RollbackPreviewTranscript.messages();
    const retired: string[] = [];
    let started = false;
    for (let index = 0; index < rows.length; index += 1) {
      const turnId = rows[index].turnId || '';
      if (!started && turnId === targetTurnId) {
        started = true;
      }
      if (started && retired.indexOf(turnId) < 0) {
        retired.push(turnId);
      }
    }
    return retired;
  }

  /** Index of the first row of one turn, or -1 when the transcript has no such turn. */
  static startIndex(targetTurnId: string): number {
    const rows = RollbackPreviewTranscript.messages();
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index].turnId === targetTurnId) {
        return index;
      }
    }
    return -1;
  }

  /** The rows a successful rollback leaves on screen: everything before the target. */
  static rowsBefore(targetTurnId: string): ChatMessage[] {
    const rows = RollbackPreviewTranscript.messages();
    const start = RollbackPreviewTranscript.startIndex(targetTurnId);
    if (start < 0) {
      return rows;
    }
    return rows.slice(0, start);
  }

  /** The answer the mock host gives one rollback, consistent with this transcript. */
  static cannedResponse(sessionId: string, targetTurnId: string): SessionRolledBackResult {
    return {
      sessionId,
      retiredTurnIds: RollbackPreviewTranscript.retiredTurnIds(targetTurnId),
      restoredFiles: RollbackPreviewScenario.RESTORED_FILES.slice(),
      composerText: RollbackPreviewTranscript.promptFor(targetTurnId),
      changed: true
    };
  }

  private static message(id: string, role: string, text: string, turnId: string): ChatMessage {
    return {
      id,
      role,
      text,
      status: 'completed',
      turnId,
      detail: '',
      timestamp: '0'
    };
  }
}

/**
 * The mock host as the command layer sees it: the same interface
 * `RemoteChatCommandClient` gives the production transport.
 *
 * `calls` is the whole point of it. "The mock must observe the rollback before
 * the send" is not a claim any screenshot of the pane can carry, so the fixture
 * states what its host received, in the order it received it, and the diagnostic
 * strip prints that.
 */
export class RollbackPreviewTransport implements RemoteChatCommandClient {
  readonly calls: string[] = [];
  private readonly variant: RollbackPreviewVariant;

  constructor(variant: RollbackPreviewVariant) {
    this.variant = variant;
  }

  /** The calls received so far, in order: `rollback→send`, `rollback`, or `(none)`. */
  order(): string {
    if (this.calls.length === 0) {
      return '(none)';
    }
    const steps: string[] = [];
    for (let index = 0; index < this.calls.length; index += 1) {
      steps.push(this.calls[index].indexOf('rollback') === 0 ? 'rollback' : 'send');
    }
    return steps.join('→');
  }

  async rollbackSessionToTurn(sessionId: string, targetTurnId: string): Promise<SessionRolledBackResult> {
    this.calls.push(`rollback:${targetTurnId}`);
    const failure = RollbackPreviewScenario.rollbackError(this.variant);
    if (failure.length > 0) {
      throw new Error(failure);
    }
    return RollbackPreviewTranscript.cannedResponse(sessionId, targetTurnId);
  }

  async sendMessage(_sessionId: string, text: string, _agentType?: string, _turnId?: string): Promise<string> {
    this.calls.push(`send:${text.length}`);
    if (RollbackPreviewScenario.sendFails(this.variant)) {
      throw new Error(RollbackPreviewScenario.SEND_FAILED_ERROR);
    }
    return RollbackPreviewScenario.ACCEPTED_TURN_ID;
  }

  async sendMessageWithImages(sessionId: string, text: string, _agentType: string,
    _imageContexts: RemoteImageContext[], turnId?: string): Promise<string> {
    return this.sendMessage(sessionId, text, _agentType, turnId);
  }

  async steerTurn(_sessionId: string, _turnId: string, _text: string, _displayContent: string,
    _imageContexts: RemoteImageContext[]): Promise<SteerTurnResult> {
    throw new Error('Unused preview operation');
  }

  async buildPlan(_sessionId: string, _planFilePath: string, _planName: string,
    _agentType: string): Promise<string> {
    throw new Error('Unused preview operation');
  }

  async cancelTask(_sessionId: string, _turnId?: string): Promise<void> {}

  async renameSession(_sessionId: string, _title: string): Promise<void> {}
}
