import { RemoteCommandCatalog, RemoteSessionUsageReport } from '../../model/RemoteModels';
import {
  CommandPaletteAvailability,
  CommandPaletteChip,
  CommandPaletteChipKind,
  CommandPaletteChipState,
  CommandPaletteNoticeKind,
  CommandPalettePolicy
} from '../../services/CommandPalettePolicy';
import {
  UsageReportPresentationPolicy,
  UsageReportSection
} from '../policy/UsageReportPresentationPolicy';

/** Lifecycle of the catalog read that doubles as the palette's behavior probe. */
export enum CommandPaletteCatalogStatus {
  /** No read yet: the row's chips wait rather than act. */
  Idle = 'idle',
  /** The probe is in flight. */
  Loading = 'loading',
  /** The host answered; its verbs are reachable. */
  Ready = 'ready',
  /** The host refused the read. The row degrades and the sheet offers a re-check. */
  Failed = 'failed'
}

export enum CommandPaletteUsageStatus {
  Idle = 'idle',
  Loading = 'loading',
  Ready = 'ready',
  Failed = 'failed'
}

/** Whether the probe's answer lets the row act at all. */
export function commandPaletteProbeReady(status: string): boolean {
  return status === CommandPaletteCatalogStatus.Ready;
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
   * The host's own refusal text for a failed probe.
   *
   * A palette verb can fail for a reason the user can act on — a locked
   * workspace, a session the desktop cannot find — and the host already said
   * which. Restating that in this app's words would lose it.
   */
  @Trace catalogErrorText: string = '';
  @Trace runningCommand: string = '';
  @Trace notice: CommandPaletteNotice = CommandPaletteNotice.none();
  @Trace usageStatus: string = CommandPaletteUsageStatus.Idle;
  @Trace usageReport: RemoteSessionUsageReport | undefined = undefined;
  @Trace usageErrorText: string = '';
  /** The single selected skill token, or '' when the composer carries none. */
  @Trace skillId: string = '';
  /** The goal chip is lit and its `/goal ` prefill is in the composer. */
  @Trace goalPending: boolean = false;

  availability(probeReady: boolean, hasSession: boolean, isBusy: boolean): CommandPaletteAvailability {
    return new CommandPaletteAvailability(
      probeReady, hasSession, isBusy, this.runningCommand, this.goalPending);
  }

  setCatalogLoading(): void {
    this.catalogStatus = CommandPaletteCatalogStatus.Loading;
    this.catalogErrorText = '';
  }

  setCatalogReady(catalog: RemoteCommandCatalog): void {
    this.catalog = catalog;
    this.catalogStatus = CommandPaletteCatalogStatus.Ready;
    this.catalogErrorText = '';
  }

  setCatalogFailed(errorText: string): void {
    this.catalog = undefined;
    this.catalogErrorText = errorText;
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

  setSkill(skillId: string): void {
    this.skillId = CommandPalettePolicy.applySkillSelection(this.skillId, skillId);
  }

  clearSkill(): void {
    this.skillId = '';
  }

  setGoalPending(pending: boolean): void {
    this.goalPending = pending;
  }

  /** Everything the previous conversation owned, dropped with it. */
  reset(): void {
    this.catalogStatus = CommandPaletteCatalogStatus.Idle;
    this.catalog = undefined;
    this.catalogErrorText = '';
    this.runningCommand = '';
    this.notice = CommandPaletteNotice.none();
    this.usageStatus = CommandPaletteUsageStatus.Idle;
    this.usageReport = undefined;
    this.usageErrorText = '';
    this.skillId = '';
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
  /** Persistent explanation under the row: a session-less or degraded surface. */
  readonly rowReasonKey: string;
  readonly notice: CommandPaletteNotice;
  readonly catalogStatus: string;
  readonly catalog?: RemoteCommandCatalog;
  /** The host's refusal text for a failed probe, empty otherwise. */
  readonly catalogErrorText: string;
  readonly usageStatus: string;
  readonly usageSections: UsageReportSection[];
  readonly usagePartial: boolean;
  readonly usageErrorText: string;
  readonly skillId: string;

  constructor(
    visible: boolean,
    chips: CommandPaletteChip[],
    rowReasonKey: string,
    notice: CommandPaletteNotice,
    catalogStatus: string,
    catalog: RemoteCommandCatalog | undefined,
    catalogErrorText: string,
    usageStatus: string,
    usageSections: UsageReportSection[],
    usagePartial: boolean,
    usageErrorText: string,
    skillId: string
  ) {
    this.visible = visible;
    this.chips = chips;
    this.rowReasonKey = rowReasonKey;
    this.notice = notice;
    this.catalogStatus = catalogStatus;
    this.catalog = catalog;
    this.catalogErrorText = catalogErrorText;
    this.usageStatus = usageStatus;
    this.usageSections = usageSections;
    this.usagePartial = usagePartial;
    this.usageErrorText = usageErrorText;
    this.skillId = skillId;
  }

  /** No row at all: the general surface, or a conversation with no session. */
  static hidden(): CommandPalettePresentation {
    return new CommandPalettePresentation(
      false, [], '', CommandPaletteNotice.none(),
      CommandPaletteCatalogStatus.Idle, undefined, '',
      CommandPaletteUsageStatus.Idle, [], false, '', '');
  }

  static project(
    state: CommandPaletteState,
    probeReady: boolean,
    hasSession: boolean,
    isBusy: boolean
  ): CommandPalettePresentation {
    if (!CommandPalettePolicy.visible(hasSession)) {
      return CommandPalettePresentation.hidden();
    }
    const availability = state.availability(probeReady, hasSession, isBusy);
    const usage = UsageReportPresentationPolicy.present(state.usageReport);
    return new CommandPalettePresentation(
      true,
      CommandPalettePolicy.chips(availability),
      CommandPalettePolicy.rowReasonKey(availability),
      state.notice,
      state.catalogStatus,
      state.catalog,
      state.catalogErrorText,
      state.usageStatus,
      usage.sections,
      usage.partial,
      state.usageErrorText,
      state.skillId);
  }

  chipState(kind: CommandPaletteChipKind): CommandPaletteChipState {
    const match = this.chips.find((chip: CommandPaletteChip): boolean => chip.kind === kind);
    return match ? match.state : CommandPaletteChipState.Dimmed;
  }
}
