import {
  RollbackEntryDecision,
  RollbackEntryDenyReason,
  SessionRollbackPolicy,
  SessionRollbackStage,
  SessionRollbackState
} from './SessionRollbackPolicy';

/**
 * What the staged rollback looks like, decided away from the pane that draws it.
 *
 * `SessionRollbackPolicy` owns the gating decision and the staging state machine;
 * this module owns the three derivations the view would otherwise have to invent
 * inline: which text a refusal is said with, which rows the local preview grays
 * out, and what the bar above the composer shows.
 *
 * Nothing here reads a timeline, a composer or a locale catalog: the rows and the
 * target text arrive as data, and every refusal answers with an i18n key rather
 * than a sentence, so the same decisions are reachable from a host test.
 */

/**
 * One timeline row as the ghost preview addresses it.
 *
 * `key` is the row identity the virtual list renders with
 * (`ChatTimelineRevisionTracker.itemKey`); `turnId` is the turn the row belongs
 * to, which is what "the target and everything after it" is expressed in.
 */
export class RollbackGhostRow {
  readonly key: string;
  readonly turnId: string;

  constructor(key: string, turnId: string) {
    this.key = key;
    this.turnId = turnId;
  }
}

/**
 * The facts a tap on the rollback entry is judged with.
 *
 * Projected once with the rest of the conversation, then resolved at tap time so
 * a session that became busy between the render and the tap is judged as it is
 * now, not as it was when the row was drawn.
 */
export class RollbackEntryFacts {
  /** Capability strings the connected host advertised in its handshake. */
  readonly hostCapabilities: string[];
  /** True while a turn is running or a message is still queued. */
  readonly sessionBusy: boolean;
  /**
   * True for a session whose history belongs to another host.
   *
   * Always false on this controller: a detached dispatch projection is neither
   * listed nor openable here (`RemoteResponseMapper.isVisibleSession` keeps child
   * sessions out of the catalog), so the phone can never prove one and the host
   * refusal stays the loud answer. The field exists because the gating policy
   * asks for it and the phone must not silently answer "no" on its behalf.
   */
  readonly isDispatchSession: boolean;

  constructor(hostCapabilities: string[], sessionBusy: boolean, isDispatchSession: boolean) {
    this.hostCapabilities = hostCapabilities;
    this.sessionBusy = sessionBusy;
    this.isDispatchSession = isDispatchSession;
  }

  /** A surface with no host behind it — the local General Chat pane. */
  static none(): RollbackEntryFacts {
    return new RollbackEntryFacts([], false, false);
  }

  /**
   * Judge one tap.
   *
   * `isUserMessage` is constant here because the entry only ever exists on a user
   * message: the two entry surfaces are the user bubble and its full-text panel,
   * and the truncated bubble's menu is built from the same user-message policy.
   */
  resolve(): RollbackEntryDecision {
    return SessionRollbackPolicy.resolveRollbackEntry({
      isUserMessage: true,
      hostCapabilities: this.hostCapabilities,
      sessionBusy: this.sessionBusy,
      isDispatchSession: this.isDispatchSession
    });
  }
}

/** What the bar above the composer shows for one staging state. */
export class RollbackBarPresentation {
  /** The bar exists only while a rollback is staged. */
  readonly visible: boolean;
  /** Dotted i18n key for the bar's title. */
  readonly titleKey: string;
  /**
   * The withdrawn prompt, flattened to one line.
   *
   * Newlines become spaces rather than being cut here: the line that gets
   * ellipsized is the layout's, so the only job left to this policy is making the
   * preview a single line the layout can ellipsize.
   */
  readonly preview: string;

  constructor(visible: boolean, titleKey: string, preview: string) {
    this.visible = visible;
    this.titleKey = titleKey;
    this.preview = preview;
  }
}

export class RollbackPresentationPolicy {
  /** Bar title: "roll back to". */
  static readonly ROLLBACK_TO_KEY: string = 'chat.rollbackTo';
  /** Selection-menu item on a user message. */
  static readonly ROLLBACK_ITEM_KEY: string = 'chat.rollbackItem';
  /** The system hint row a successful rollback leaves behind. */
  static readonly ROLLED_BACK_NOTICE_KEY: string = 'chat.rolledBackNotice';
  /** The connected host does not serve `session_rollback_v1`. */
  static readonly UNSUPPORTED_KEY: string = 'chat.rollbackUnsupported';
  /** A turn is running; history cannot change under it. */
  static readonly SESSION_BUSY_KEY: string = 'chat.rollbackSessionBusy';
  /** This kind of session is not a rollback target. */
  static readonly DISPATCH_DENIED_KEY: string = 'chat.rollbackDispatchDenied';
  /** A refused or stale rollback the client could not repair quietly. */
  static readonly FAILED_KEY: string = 'chat.rollbackFailed';

  /**
   * The key a refusal is said with.
   *
   * `None` and `NotUserMessage` never reach a surface: the first is an allowed
   * entry, and the second cannot be produced by an entry that only exists on a
   * user message. Both fall back to the loud failure copy so an unreachable
   * combination still says something rather than nothing.
   */
  static denyMessageKey(reason: RollbackEntryDenyReason): string {
    if (reason === RollbackEntryDenyReason.DispatchSession) {
      return RollbackPresentationPolicy.DISPATCH_DENIED_KEY;
    }
    if (reason === RollbackEntryDenyReason.SessionBusy) {
      return RollbackPresentationPolicy.SESSION_BUSY_KEY;
    }
    if (reason === RollbackEntryDenyReason.HostUnsupported) {
      return RollbackPresentationPolicy.UNSUPPORTED_KEY;
    }
    return RollbackPresentationPolicy.FAILED_KEY;
  }

  /** The bar for one staging state; hidden unless the rollback is staged. */
  static bar(state: SessionRollbackState): RollbackBarPresentation {
    if (state.stage !== SessionRollbackStage.Staging) {
      return new RollbackBarPresentation(false, RollbackPresentationPolicy.ROLLBACK_TO_KEY, '');
    }
    return new RollbackBarPresentation(
      true,
      RollbackPresentationPolicy.ROLLBACK_TO_KEY,
      RollbackPresentationPolicy.singleLine(state.targetText)
    );
  }

  /**
   * The rows the staged preview grays out: the target turn and every row after it.
   *
   * A target this timeline does not contain — a transcript that already moved on —
   * ghosts nothing. The preview is a local statement about rows that are on
   * screen, and graying rows the target was never found among would be a guess
   * about where the cut belongs.
   */
  static ghostRowKeys(rows: RollbackGhostRow[], targetTurnId: string): string[] {
    const target = targetTurnId.trim();
    if (target.length === 0) {
      return [];
    }
    const start = rows.findIndex((row: RollbackGhostRow) => row.turnId === target);
    if (start < 0) {
      return [];
    }
    return rows.slice(start).map((row: RollbackGhostRow) => row.key);
  }

  /** Whitespace runs collapse into one space so the preview is a single line. */
  private static singleLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }
}
