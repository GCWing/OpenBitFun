import { RemoteCommandCatalog, RemoteSessionUsageReport } from '../../model/RemoteModels';
import {
  CommandPaletteAvailability,
  CommandPaletteCatalogStatus,
  CommandPaletteChip,
  CommandPaletteChipKind,
  CommandPaletteChipState,
  CommandPaletteNoticeKind,
  CommandPalettePolicy,
  CommandPaletteProbeFailure
} from '../../services/CommandPalettePolicy';
import {
  UsageReportPresentationPolicy,
  UsageReportSection
} from '../policy/UsageReportPresentationPolicy';

export enum CommandPaletteUsageStatus {
  Idle = 'idle',
  Loading = 'loading',
  Ready = 'ready',
  Failed = 'failed'
}

/**
 * What the chip row says under itself after a verb ran.
 *
 * One line at a time: a second verb replaces the first notice rather than
 * stacking a second line above the composer.
 */
export class CommandPaletteNotice {
  readonly kind: CommandPaletteNoticeKind;
  readonly labelKey: string;
  /** Host error text for a failure, empty otherwise. */
  readonly detail: string;
  /** The verb a retry would repeat, empty when there is nothing to repeat. */
  readonly retryCommand: string;

  constructor(kind: CommandPaletteNoticeKind, labelKey: string, detail: string, retryCommand: string) {
    this.kind = kind;
    this.labelKey = labelKey;
    this.detail = detail;
    this.retryCommand = retryCommand;
  }

  static none(): CommandPaletteNotice {
    return new CommandPaletteNotice(CommandPaletteNoticeKind.Done, '', '', '');
  }

  get visible(): boolean {
    return this.labelKey.length > 0;
  }

  get retryable(): boolean {
    return CommandPalettePolicy.canRetry(this.kind, this.retryCommand);
  }
}

/**
 * Observable command-palette state for the remote conversation.
 *
 * Owned by `RemotePageState`, written by `RemoteCommandPaletteController` through
 * the composition, and read only through `CommandPalettePresentation` so the
 * view never has to know which half of this is host truth and which half is a
 * local draft decision.
 */
@ObservedV2
export class CommandPaletteState {
  @Trace catalogStatus: string = CommandPaletteCatalogStatus.Idle;
  @Trace catalog: RemoteCommandCatalog | undefined = undefined;
  /**
   * Why the skill read failed, when it did.
   *
   * Kept beside the host's text because the two answer different questions: the
   * kind decides whether this app may tell the user their desktop is out of
   * date, and the text is the host's own account of what went wrong.
   */
  @Trace catalogFailure: string = CommandPaletteProbeFailure.None;
  /**
   * The host's own text for a failed read.
   *
   * A verb can fail for a reason the user can act on — a locked workspace, a
   * session the desktop cannot find — and the host already said which. Restating
   * that in this app's words would lose it.
   */
  @Trace catalogErrorText: string = '';
  @Trace runningCommand: string = '';
  @Trace notice: CommandPaletteNotice = CommandPaletteNotice.none();
  @Trace usageStatus: string = CommandPaletteUsageStatus.Idle;
  @Trace usageReport: RemoteSessionUsageReport | undefined = undefined;
  @Trace usageErrorText: string = '';
  /** The key of the single selected skill, or '' when the composer carries none. */
  @Trace skillId: string = '';
  /** The selected skill's name, which is the text its token carries. */
  @Trace skillLabel: string = '';
  /** The goal chip is lit and its `/goal ` prefill is in the composer. */
  @Trace goalPending: boolean = false;

  /**
   * The row's inputs, read from this state rather than passed in.
   *
   * The skill read's verdict belongs to whoever holds the answer, so the
   * projection no longer takes a pre-computed `probeReady` that could disagree
   * with the status sitting right beside it.
   */
  availability(hasSession: boolean, isBusy: boolean): CommandPaletteAvailability {
    return new CommandPaletteAvailability(
      this.catalogStatus, this.catalogFailure, hasSession, isBusy,
      this.runningCommand, this.goalPending);
  }

  setCatalogLoading(): void {
    this.catalogStatus = CommandPaletteCatalogStatus.Loading;
    this.catalogFailure = CommandPaletteProbeFailure.None;
    this.catalogErrorText = '';
  }

  setCatalogReady(catalog: RemoteCommandCatalog): void {
    this.catalog = catalog;
    this.catalogStatus = CommandPaletteCatalogStatus.Ready;
    this.catalogFailure = CommandPaletteProbeFailure.None;
    this.catalogErrorText = '';
  }

  setCatalogFailed(errorText: string, failure: string): void {
    this.catalog = undefined;
    this.catalogErrorText = errorText;
    this.catalogFailure = failure;
    this.catalogStatus = CommandPaletteCatalogStatus.Failed;
  }

  beginCommand(wireAction: string): void {
    this.runningCommand = wireAction;
    this.notice = CommandPaletteNotice.none();
  }

  settleCommand(wireAction: string, errorText: string): void {
    this.runningCommand = '';
    if (errorText.length === 0) {
      this.notice = new CommandPaletteNotice(
        CommandPaletteNoticeKind.Done,
        CommandPalettePolicy.doneNoticeKey(wireAction),
        '',
        '');
      return;
    }
    this.notice = new CommandPaletteNotice(
      CommandPaletteNoticeKind.Failed,
      CommandPalettePolicy.failedNoticeKey(wireAction),
      errorText,
      wireAction);
  }

  /** The completion line's dwell time ran out. */
  expireNotice(wireAction: string): void {
    if (this.notice.visible && this.notice.retryCommand.length === 0 &&
      CommandPalettePolicy.doneNoticeKey(wireAction) === this.notice.labelKey) {
      this.notice = CommandPaletteNotice.none();
    }
  }

  clearNotice(): void {
    this.notice = CommandPaletteNotice.none();
  }

  setUsageLoading(): void {
    this.usageStatus = CommandPaletteUsageStatus.Loading;
    this.usageErrorText = '';
  }

  setUsageReady(report: RemoteSessionUsageReport | undefined): void {
    this.usageReport = report;
    this.usageStatus = CommandPaletteUsageStatus.Ready;
  }

  setUsageFailed(errorText: string): void {
    this.usageReport = undefined;
    this.usageErrorText = errorText;
    this.usageStatus = CommandPaletteUsageStatus.Failed;
  }

  /** Picks a skill. The key decides whether it is a new pick; the label is its token. */
  setSkill(skillId: string, skillLabel: string): void {
    const next = CommandPalettePolicy.applySkillSelection(this.skillId, skillId);
    if (next === this.skillId && next.length > 0) {
      // Re-picking the row that is already in the composer: the token stays the
      // one already drawn rather than being rewritten under the user.
      return;
    }
    this.skillId = next;
    this.skillLabel = next.length > 0 ? skillLabel.trim() : '';
  }

  clearSkill(): void {
    this.skillId = '';
    this.skillLabel = '';
  }

  setGoalPending(pending: boolean): void {
    this.goalPending = pending;
  }

  /** Everything the previous conversation owned, dropped with it. */
  reset(): void {
    this.catalogStatus = CommandPaletteCatalogStatus.Idle;
    this.catalog = undefined;
    this.catalogFailure = CommandPaletteProbeFailure.None;
    this.catalogErrorText = '';
    this.runningCommand = '';
    this.notice = CommandPaletteNotice.none();
    this.usageStatus = CommandPaletteUsageStatus.Idle;
    this.usageReport = undefined;
    this.usageErrorText = '';
    this.skillId = '';
    this.skillLabel = '';
    this.goalPending = false;
  }
}

/**
 * The command palette as the conversation view reads it.
 *
 * Immutable, computed once per projection: the chips a tap may act on, the
 * explanation the row owes the user, the notice line, and the two sheets' data.
 */
export class CommandPalettePresentation {
  readonly visible: boolean;
  readonly chips: CommandPaletteChip[];
  /** Persistent explanation under the row: a session-less surface. */
  readonly rowReasonKey: string;
  readonly notice: CommandPaletteNotice;
  readonly catalogStatus: string;
  readonly catalog?: RemoteCommandCatalog;
  /** Why the read failed, which is what the picker's copy follows. */
  readonly catalogFailure: string;
  /** The host's own text for a failed read, empty otherwise. */
  readonly catalogErrorText: string;
  readonly usageStatus: string;
  readonly usageSections: UsageReportSection[];
  readonly usagePartial: boolean;
  readonly usageErrorText: string;
  /** The selected skill's key, which is what its row's check mark compares. */
  readonly skillId: string;
  /** The selected skill's name, which is the text its token carries. */
  readonly skillLabel: string;

  constructor(
    visible: boolean,
    chips: CommandPaletteChip[],
    rowReasonKey: string,
    notice: CommandPaletteNotice,
    catalogStatus: string,
    catalog: RemoteCommandCatalog | undefined,
    catalogFailure: string,
    catalogErrorText: string,
    usageStatus: string,
    usageSections: UsageReportSection[],
    usagePartial: boolean,
    usageErrorText: string,
    skillId: string,
    skillLabel: string
  ) {
    this.visible = visible;
    this.chips = chips;
    this.rowReasonKey = rowReasonKey;
    this.notice = notice;
    this.catalogStatus = catalogStatus;
    this.catalog = catalog;
    this.catalogFailure = catalogFailure;
    this.catalogErrorText = catalogErrorText;
    this.usageStatus = usageStatus;
    this.usageSections = usageSections;
    this.usagePartial = usagePartial;
    this.usageErrorText = usageErrorText;
    this.skillId = skillId;
    this.skillLabel = skillLabel;
  }

  /** No row at all: the general surface, or a conversation with no session. */
  static hidden(): CommandPalettePresentation {
    return new CommandPalettePresentation(
      false, [], '', CommandPaletteNotice.none(),
      CommandPaletteCatalogStatus.Idle, undefined, CommandPaletteProbeFailure.None, '',
      CommandPaletteUsageStatus.Idle, [], false, '', '', '');
  }

  static project(
    state: CommandPaletteState,
    hasSession: boolean,
    isBusy: boolean
  ): CommandPalettePresentation {
    if (!CommandPalettePolicy.visible(hasSession)) {
      return CommandPalettePresentation.hidden();
    }
    const availability = state.availability(hasSession, isBusy);
    const usage = UsageReportPresentationPolicy.present(state.usageReport);
    return new CommandPalettePresentation(
      true,
      CommandPalettePolicy.chips(availability),
      CommandPalettePolicy.rowReasonKey(availability),
      state.notice,
      state.catalogStatus,
      state.catalog,
      state.catalogFailure,
      state.catalogErrorText,
      state.usageStatus,
      usage.sections,
      usage.partial,
      state.usageErrorText,
      state.skillId,
      state.skillLabel);
  }

  chipState(kind: CommandPaletteChipKind): CommandPaletteChipState {
    const match = this.chips.find((chip: CommandPaletteChip): boolean => chip.kind === kind);
    return match ? match.state : CommandPaletteChipState.Dimmed;
  }
}
