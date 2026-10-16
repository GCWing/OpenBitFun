import { REMOTE_CAPABILITY_SESSION_ROLLBACK_V1 } from '../../model/RemoteModels';

/**
 * Whether a message can start a rollback, and what that rollback is allowed to do.
 *
 * The frozen interaction (plan decision 4) is staged: choosing "roll back to this
 * message" sends nothing to the host. The timeline turns the target turn and
 * everything after it into local ghost rows, a rollback bar appears above the
 * composer, and the composer is refilled with the withdrawn prompt. Staging is
 * memory-only, so a restart or a reconnect simply returns to the real timeline.
 *
 * Three exits, no confirmation dialog:
 * - close: abandon the rollback; ghosts go back to real rows, and the refilled
 *   prompt is not kept — the composer returns to the snapshot taken when staging
 *   began;
 * - send: roll the host back and then send the (possibly edited) text from that
 *   point, as two steps in that order;
 * - confirm: run the rollback and keep the composer text to edit further.
 *
 * The policy is pure: it owns the decision and the state machine, and returns
 * effects for the viewmodel to apply. It sends no command, reads no composer and
 * touches no timeline, which is what keeps every exit host-testable.
 */

/** Why the rollback entry is not offered on a message. */
export enum RollbackEntryDenyReason {
  /** The entry is offered. */
  None = 'none',
  /** Only a user message can be a rollback target. */
  NotUserMessage = 'not_user_message',
  /** A dispatch session's history belongs to the target host. */
  DispatchSession = 'dispatch_session',
  /** The session is still running a turn; its history cannot change under it. */
  SessionBusy = 'session_busy',
  /** The connected host does not advertise `session_rollback_v1`. */
  HostUnsupported = 'host_unsupported'
}

export interface RollbackEntryRequest {
  /** The message the entry belongs to. */
  isUserMessage: boolean;
  /** Capability strings the connected host advertised in its handshake. */
  hostCapabilities: string[];
  /** True while a turn is running or a message is still queued. */
  sessionBusy: boolean;
  /** True for a detached dispatch session. */
  isDispatchSession: boolean;
}

export interface RollbackEntryDecision {
  allowed: boolean;
  reason: RollbackEntryDenyReason;
}

/** The two states of the staged rollback. */
export enum SessionRollbackStage {
  Idle = 'idle',
  Staging = 'staging'
}

/** No rollback is staged. */
export class SessionRollbackIdleState {
  readonly stage: SessionRollbackStage = SessionRollbackStage.Idle;
  /** Always empty while idle; staging carries the payload. */
  readonly targetTurnId: string = '';
  readonly targetText: string = '';
  readonly composerSnapshot: string = '';
}

/**
 * A rollback is staged locally and has not reached the host.
 *
 * `targetTurnId` and `targetText` come from the user message the entry was
 * opened on; `composerSnapshot` is the composer as it was before staging began,
 * which is what closing restores.
 */
export class SessionRollbackStagingState {
  readonly stage: SessionRollbackStage = SessionRollbackStage.Staging;
  readonly targetTurnId: string;
  readonly targetText: string;
  readonly composerSnapshot: string;

  constructor(targetTurnId: string, targetText: string, composerSnapshot: string) {
    this.targetTurnId = targetTurnId;
    this.targetText = targetText;
    this.composerSnapshot = composerSnapshot;
  }
}

/** The closed set of staging states; both shapes carry every field. */
export type SessionRollbackState = SessionRollbackIdleState | SessionRollbackStagingState;

/** What the user asked for, or what the host reported back. */
export enum SessionRollbackEventType {
  /** Open the entry for a user message: start staging it. */
  EnterStaging = 'enter_staging',
  /** Abandon the staged rollback. */
  CloseStaging = 'close_staging',
  /** Run the rollback and keep the current composer text. */
  ConfirmRollback = 'confirm_rollback',
  /** Run the rollback, then send `text` from the withdrawn point. */
  SendWhileStaging = 'send_while_staging',
  /** The host refused the rollback because the view it addresses moved on. */
  StaleViewDetected = 'stale_view_detected',
  /** The rollback failed for any other reason. */
  RollbackFailed = 'rollback_failed'
}

export interface SessionRollbackEvent {
  type: SessionRollbackEventType;
  /** `EnterStaging`: the user message being withdrawn. */
  targetTurnId?: string;
  targetText?: string;
  /** `EnterStaging`: the composer text from before staging began. */
  composerSnapshot?: string;
  /** `SendWhileStaging`: the text to send once the rollback succeeded. */
  text?: string;
}

/** What the viewmodel does for one transition. */
export enum SessionRollbackEffectType {
  /** Write `text` into the composer. */
  RefillComposer = 'refill_composer',
  /** Put the composer back to `text`, the pre-staging snapshot. */
  RestoreComposerSnapshot = 'restore_composer_snapshot',
  /** Leave the composer exactly as the user left it. */
  KeepComposerText = 'keep_composer_text',
  /** Render the target turn and everything after it as local ghost rows. */
  ShowGhostRows = 'show_ghost_rows',
  /** Drop the ghost rows and show the real transcript again. */
  ClearGhostRows = 'clear_ghost_rows',
  /** Send `rollback_session_to_turn` for `targetTurnId`. */
  SendRollbackCommand = 'send_rollback_command',
  /** Send `text` as a new message, after the rollback above succeeded. */
  SendMessageAfterRollback = 'send_message_after_rollback',
  /** Surface a user-visible notice instead of failing silently. */
  ShowDegradeNotice = 'show_degrade_notice',
  /** Reload the authoritative transcript from the host. */
  ResyncTimeline = 'resync_timeline'
}

export interface SessionRollbackEffect {
  type: SessionRollbackEffectType;
  /** Composer payload, or the message for `SendMessageAfterRollback`. */
  text?: string;
  /** The withdrawn turn, for the ghost preview and the command. */
  targetTurnId?: string;
}

export interface SessionRollbackTransition {
  state: SessionRollbackState;
  effects: SessionRollbackEffect[];
}

export class SessionRollbackPolicy {
  /**
   * Decide whether the entry is offered.
   *
   * The order is the order the user can act on: a message that is not the
   * user's own has no entry at all, a dispatch session cannot be rolled back by
   * anyone, a busy session only needs to finish, and only then does the host's
   * own version decide. Reporting an older host for a session that is merely
   * busy would send the user to the wrong fix.
   */
  static resolveRollbackEntry(request: RollbackEntryRequest): RollbackEntryDecision {
    if (!request.isUserMessage) {
      return { allowed: false, reason: RollbackEntryDenyReason.NotUserMessage };
    }
    if (request.isDispatchSession) {
      return { allowed: false, reason: RollbackEntryDenyReason.DispatchSession };
    }
    if (request.sessionBusy) {
      return { allowed: false, reason: RollbackEntryDenyReason.SessionBusy };
    }
    if (!SessionRollbackPolicy.hostSupportsRollback(request.hostCapabilities)) {
      return { allowed: false, reason: RollbackEntryDenyReason.HostUnsupported };
    }
    return { allowed: true, reason: RollbackEntryDenyReason.None };
  }

  static initial(): SessionRollbackState {
    return new SessionRollbackIdleState();
  }

  /**
   * The whole staged-rollback state machine.
   *
   * `EnterStaging` is the only event that reads the composer's current value;
   * every other event either leaves the composer alone or restores the snapshot.
   * Staging a second message replaces the target and keeps the first snapshot,
   * because closing must return the composer to where it was before staging
   * began, not to where it was before the second entry.
   */
  static reduce(state: SessionRollbackState, event: SessionRollbackEvent): SessionRollbackTransition {
    const staging = state.stage === SessionRollbackStage.Staging;
    switch (event.type) {
      case SessionRollbackEventType.EnterStaging:
        return SessionRollbackPolicy.enterStaging(state, staging, event);
      case SessionRollbackEventType.CloseStaging:
        if (!staging) {
          return SessionRollbackPolicy.noop(state);
        }
        return {
          state: new SessionRollbackIdleState(),
          effects: [
            { type: SessionRollbackEffectType.ClearGhostRows },
            { type: SessionRollbackEffectType.RestoreComposerSnapshot, text: state.composerSnapshot }
          ]
        };
      case SessionRollbackEventType.ConfirmRollback:
        if (!staging) {
          return SessionRollbackPolicy.noop(state);
        }
        return {
          state: new SessionRollbackIdleState(),
          effects: [
            { type: SessionRollbackEffectType.SendRollbackCommand, targetTurnId: state.targetTurnId },
            { type: SessionRollbackEffectType.ClearGhostRows },
            { type: SessionRollbackEffectType.KeepComposerText }
          ]
        };
      case SessionRollbackEventType.SendWhileStaging:
        if (!staging) {
          return SessionRollbackPolicy.noop(state);
        }
        // Two steps, in this order: the host retires the turn first, and the new
        // message is sent from the withdrawn point. A rollback that succeeds and
        // a send that fails is recoverable — staging is over and the draft stays.
        return {
          state: new SessionRollbackIdleState(),
          effects: [
            { type: SessionRollbackEffectType.SendRollbackCommand, targetTurnId: state.targetTurnId },
            { type: SessionRollbackEffectType.SendMessageAfterRollback, text: event.text || '' },
            { type: SessionRollbackEffectType.ClearGhostRows }
          ]
        };
      case SessionRollbackEventType.StaleViewDetected:
        return {
          state: new SessionRollbackIdleState(),
          effects: SessionRollbackPolicy.hostOutcomeEffects(staging, false)
        };
      case SessionRollbackEventType.RollbackFailed:
        return {
          state: new SessionRollbackIdleState(),
          effects: SessionRollbackPolicy.hostOutcomeEffects(staging, true)
        };
      default:
        return SessionRollbackPolicy.noop(state);
    }
  }

  private static enterStaging(
    state: SessionRollbackState,
    staging: boolean,
    event: SessionRollbackEvent
  ): SessionRollbackTransition {
    const snapshot = staging ? state.composerSnapshot : (event.composerSnapshot || '');
    const target = new SessionRollbackStagingState(
      event.targetTurnId || '',
      event.targetText || '',
      snapshot
    );
    return {
      state: target,
      effects: [
        { type: SessionRollbackEffectType.RefillComposer, text: target.targetText },
        { type: SessionRollbackEffectType.ShowGhostRows, targetTurnId: target.targetTurnId }
      ]
    };
  }

  /**
   * A host outcome is meaningful in either state: confirm and send leave staging
   * before the host answers, so a refusal arrives while the client is already
   * idle and must still repair the transcript instead of being swallowed.
   */
  private static hostOutcomeEffects(staging: boolean, notice: boolean): SessionRollbackEffect[] {
    const effects: SessionRollbackEffect[] = [];
    if (staging) {
      effects.push({ type: SessionRollbackEffectType.ClearGhostRows });
    }
    effects.push({ type: SessionRollbackEffectType.ResyncTimeline });
    if (notice) {
      effects.push({ type: SessionRollbackEffectType.ShowDegradeNotice });
    }
    return effects;
  }

  private static noop(state: SessionRollbackState): SessionRollbackTransition {
    return { state: state, effects: [] };
  }

  /**
   * The capability is matched as the exact advertised string, the same way
   * `supportsHostCapability` does: a near-miss is a different promise.
   */
  private static hostSupportsRollback(capabilities: string[]): boolean {
    return (capabilities || []).indexOf(REMOTE_CAPABILITY_SESSION_ROLLBACK_V1) >= 0;
  }
}
