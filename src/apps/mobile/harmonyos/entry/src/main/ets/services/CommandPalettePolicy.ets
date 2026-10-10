/**
 * The composer command palette's rules, kept pure so they can be exercised
 * without ArkUI.
 *
 * Everything here answers one of three questions: which chip may be tapped
 * right now, what a tapped chip does to the draft, and what the draft becomes
 * when it is sent. The palette never guesses a session, never opens the picker
 * before the host has answered the skill read, and never rewrites a draft the
 * user owns.
 */

/** Lifecycle of the catalog read that doubles as the palette's behavior probe. */
export enum CommandPaletteCatalogStatus {
  /** No read yet: the picker's chip waits rather than acts. */
  Idle = 'idle',
  /** The read is in flight. */
  Loading = 'loading',
  /** The host answered; the picker has rows to offer. */
  Ready = 'ready',
  /** The read failed. The chip still opens the picker, which explains and re-checks. */
  Failed = 'failed'
}

/**
 * Why the skill read failed.
 *
 * The three cases are not interchangeable to the person holding the phone, and
 * only one of them justifies telling them their desktop is out of date. A read
 * that reached nothing is a connection to fix; a read the host refused without
 * naming a version gap is the host saying no; only a host that reports the gap
 * itself is an upgrade.
 */
export enum CommandPaletteProbeFailure {
  None = '',
  /** The host answered, and its own words name the version gap. */
  VersionGap = 'version_gap',
  /** The host answered and refused, for a reason it stated itself. */
  Refused = 'refused',
  /** Nothing answered: a transport, timeout or unusable-payload failure. */
  Unreachable = 'unreachable'
}

/** Whether the probe's answer lets the picker offer rows. */
export function commandPaletteProbeReady(status: string): boolean {
  return status === CommandPaletteCatalogStatus.Ready;
}

/**
 * The host's own wording when it does not have a command in this version.
 *
 * `PeerRefusal::UnknownToHost` is the peer-host registry's sentence, and it is
 * the only thing that names a version. The desktop's command registry answers
 * `Command not found: <name>` for a name it does not carry, which is a refusal
 * about the command rather than a statement about the build: it keeps the
 * refusal copy and leaves the upgrade claim to the sentence that makes it.
 */
const VERSION_GAP_MARKERS: string[] = [
  'unknown to this openbitfun',
  'peer host version'
];

/**
 * The bridge's own wording when it never got to a command handler.
 *
 * `host_invoke` answers `ok: false` for two unrelated events: a command the host
 * declined, and the bridge between the relay and the desktop failing to deliver
 * it at all (`peer_host_invoke.rs`: the app handle is not up yet, the request
 * could not be emitted, the channel closed, or the whole call timed out). The
 * second kind is a connection that did not reach a command, so it must not be
 * described as the desktop having answered — the refusal copy asserts an answer,
 * and the version claim would be pure invention.
 */
const NON_ANSWER_MARKERS: string[] = [
  'peer host invoke',
  'peer app handle not ready',
  'failed to emit',
  'channel closed',
  'lock poisoned'
];

/** The five chips of the composer command row, in their on-screen order. */
export enum CommandPaletteChipKind {
  Compact = 'compact',
  Init = 'init',
  Goal = 'goal',
  Usage = 'usage',
  Skills = 'skills'
}

export enum CommandPaletteChipState {
  Ready = 'ready',
  /** The goal chip waiting for its argument; drawn filled. */
  Pending = 'pending',
  /** The verb this chip starts is in flight; a spinner replaces its icon. */
  InFlight = 'inflight',
  /** Greyed. Still tappable, so the row can explain itself. */
  Dimmed = 'dimmed'
}

/**
 * Why a chip is not ready, and therefore what the row says about it.
 *
 * A chip's own business is the only thing that holds it back. The skill read is
 * the picker's business alone, so a failed read no longer greys the row: the
 * verbs exist on every host this app can reach, and a host that refuses one says
 * so when it is run.
 */
export enum CommandPaletteDegradeReason {
  /** The skill read has not answered, or answered with a failure. */
  Probe = 'probe',
  /** Another palette verb is still running. */
  Busy = 'busy',
  /** No session is open, so there is nothing to act on. */
  Session = 'session',
  None = 'none'
}

export enum CommandPaletteNoticeKind {
  Busy = 'busy',
  Done = 'done',
  Failed = 'failed'
}

/** What the row is allowed to do, as a snapshot of the live surface. */
export class CommandPaletteAvailability {
  /** The skill read's lifecycle, which gates the picker's chip and nothing else. */
  readonly probeStatus: string;
  /** Why the read failed, when it did; the badge and the copy follow from this. */
  readonly probeFailure: string;
  readonly hasSession: boolean;
  readonly isBusy: boolean;
  /** Wire id of the palette verb currently in flight, or '' when idle. */
  readonly runningCommand: string;
  /** The goal chip is prefilled and waiting for its argument. */
  readonly goalPending: boolean;

  constructor(
    probeStatus: string,
    probeFailure: string,
    hasSession: boolean,
    isBusy: boolean,
    runningCommand: string = '',
    goalPending: boolean = false
  ) {
    this.probeStatus = probeStatus;
    this.probeFailure = probeFailure;
    this.hasSession = hasSession;
    this.isBusy = isBusy;
    this.runningCommand = runningCommand;
    this.goalPending = goalPending;
  }

  get probeReady(): boolean {
    return commandPaletteProbeReady(this.probeStatus);
  }
}

/** One rendered chip: its label, its state, and what a tap does. */
export class CommandPaletteChip {
  readonly kind: CommandPaletteChipKind;
  readonly state: CommandPaletteChipState;
  readonly labelKey: string;
  /** Badge shown on the chip's corner, empty when the chip has none. */
  readonly badgeKey: string;
  readonly showsChevron: boolean;
  /** Empty unless the chip has something to explain. */
  readonly reasonKey: string;
  /** False while a tap must not reach the host; the reason line still shows. */
  readonly runsAction: boolean;

  constructor(
    kind: CommandPaletteChipKind,
    state: CommandPaletteChipState,
    labelKey: string,
    badgeKey: string,
    showsChevron: boolean,
    reasonKey: string,
    runsAction: boolean
  ) {
    this.kind = kind;
    this.state = state;
    this.labelKey = labelKey;
    this.badgeKey = badgeKey;
    this.showsChevron = showsChevron;
    this.reasonKey = reasonKey;
    this.runsAction = runsAction;
  }
}

/** The goal chip's two-way toggle result. */
export class GoalPrefillToggle {
  readonly draft: string;
  readonly pending: boolean;

  constructor(draft: string, pending: boolean) {
    this.draft = draft;
    this.pending = pending;
  }
}

const GOAL_COMMAND: string = '/goal';
const GOAL_PREFILL: string = '/goal ';

export class CommandPalettePolicy {
  static readonly compactLabelKey: string = 'commands.compact';
  static readonly initLabelKey: string = 'commands.init';
  static readonly goalLabelKey: string = 'commands.goal';
  static readonly usageLabelKey: string = 'commands.usage';
  static readonly skillsLabelKey: string = 'commands.skills';
  static readonly upgradeBadgeKey: string = 'commands.upgradeBadge';
  static readonly degradedReasonKey: string = 'commands.degradedReason';
  static readonly busyReasonKey: string = 'commands.busyReason';
  static readonly probeWaitReasonKey: string = 'commands.probeWaitReason';
  static readonly probeRefusedReasonKey: string = 'commands.probeRefusedReason';
  static readonly probeUnreachableReasonKey: string = 'commands.probeUnreachableReason';

  /**
   * The internal ids of the two verbs that run on tap.
   *
   * They are not wire values: each maps to a desktop command through the
   * palette's `host_invoke` client, and they are what the row, the notices and
   * the single-flight guard compare against.
   */
  static readonly compactWireAction: string = 'compact';
  static readonly initWireAction: string = 'init_agents_md';

  /** The verb a chip starts, or '' for the chips that only shape the draft. */
  static wireAction(kind: CommandPaletteChipKind): string {
    if (kind === CommandPaletteChipKind.Compact) return CommandPalettePolicy.compactWireAction;
    if (kind === CommandPaletteChipKind.Init) return CommandPalettePolicy.initWireAction;
    return '';
  }

  /** Whether this verb is one the row may start. */
  static isRunnable(wireAction: string): boolean {
    return wireAction === CommandPalettePolicy.compactWireAction ||
      wireAction === CommandPalettePolicy.initWireAction;
  }

  /**
   * The row, in order. A chip is degraded rather than hidden the moment the host
   * cannot serve it: a missing answer has to be visible and explainable, not
   * silently absent, and every chip stays tappable so the row can say why.
   */
  static chips(availability: CommandPaletteAvailability): CommandPaletteChip[] {
    return [
      CommandPalettePolicy.chip(availability, CommandPaletteChipKind.Compact),
      CommandPalettePolicy.chip(availability, CommandPaletteChipKind.Init),
      CommandPalettePolicy.chip(availability, CommandPaletteChipKind.Goal),
      CommandPalettePolicy.chip(availability, CommandPaletteChipKind.Usage),
      CommandPalettePolicy.chip(availability, CommandPaletteChipKind.Skills)
    ];
  }

  static chip(
    availability: CommandPaletteAvailability,
    kind: CommandPaletteChipKind
  ): CommandPaletteChip {
    const labelKey = CommandPalettePolicy.labelKey(kind);
    const chevron = kind === CommandPaletteChipKind.Skills;
    if (!availability.hasSession) {
      return new CommandPaletteChip(
        kind, CommandPaletteChipState.Dimmed, labelKey,
        '', chevron, CommandPalettePolicy.sessionReasonKey(), false);
    }
    // Goals are plain message text: the host parses `/goal <objective>` on the
    // send path it already has, so this chip is honest about working even when
    // the palette's own verbs do not.
    if (kind === CommandPaletteChipKind.Goal) {
      return new CommandPaletteChip(
        kind,
        availability.goalPending ? CommandPaletteChipState.Pending : CommandPaletteChipState.Ready,
        labelKey, '', false, '', true);
    }
    // The picker is the one surface whose reach depends on the host's answer, so
    // it is the one chip the skill read gates.
    if (kind === CommandPaletteChipKind.Skills) {
      return CommandPalettePolicy.skillsChip(availability, labelKey);
    }
    // Compacting, initializing and the usage report exist on every host this app
    // can reach, and each one answers for itself when it is run — refusing it is
    // the host's message to give, not a verdict this row can reach in advance.
    const wireAction = CommandPalettePolicy.wireAction(kind);
    if (availability.runningCommand.length > 0 && availability.runningCommand === wireAction) {
      return new CommandPaletteChip(
        kind, CommandPaletteChipState.InFlight, labelKey, '', false, '', false);
    }
    if (availability.isBusy || availability.runningCommand.length > 0) {
      return new CommandPaletteChip(
        kind, CommandPaletteChipState.Dimmed, labelKey,
        '', false, CommandPalettePolicy.busyReasonKey, false);
    }
    return new CommandPaletteChip(
      kind, CommandPaletteChipState.Ready, labelKey, '', false, '', true);
  }

  /**
   * The 技能 chip, which is where the skill read's answer shows.
   *
   * A read still in flight is neither a refusal nor a promise, so the chip waits
   * and says so — no badge, and no sentence about the desktop's version. Only a
   * host that reported the version gap itself gets the upgrade badge.
   */
  private static skillsChip(
    availability: CommandPaletteAvailability,
    labelKey: string
  ): CommandPaletteChip {
    const kind = CommandPaletteChipKind.Skills;
    if (availability.probeStatus === CommandPaletteCatalogStatus.Failed) {
      // The picker keeps opening: it is where the reason, the host's own text and
      // the re-check live, so a dead chip would say strictly less.
      return new CommandPaletteChip(
        kind,
        CommandPaletteChipState.Dimmed,
        labelKey,
        CommandPalettePolicy.probeBadgeKey(availability.probeFailure),
        true,
        CommandPalettePolicy.probeReasonKey(availability.probeFailure),
        true);
    }
    if (availability.probeReady) {
      return new CommandPaletteChip(kind, CommandPaletteChipState.Ready, labelKey, '', true, '', true);
    }
    return new CommandPaletteChip(
      kind, CommandPaletteChipState.Dimmed, labelKey, '', true,
      CommandPalettePolicy.probeWaitReasonKey, false);
  }

  /** The corner badge for a failed read: only a version gap is an upgrade. */
  static probeBadgeKey(failure: string): string {
    return failure === CommandPaletteProbeFailure.VersionGap ?
      CommandPalettePolicy.upgradeBadgeKey : '';
  }

  /** The chip's own sentence for a failed read. */
  static probeReasonKey(failure: string): string {
    if (failure === CommandPaletteProbeFailure.VersionGap) {
      return CommandPalettePolicy.degradedReasonKey;
    }
    return failure === CommandPaletteProbeFailure.Refused ?
      CommandPalettePolicy.probeRefusedReasonKey : CommandPalettePolicy.probeUnreachableReasonKey;
  }

  /** The picker's heading for a failed read. */
  static probeTitleKey(failure: string): string {
    if (failure === CommandPaletteProbeFailure.VersionGap) return 'commands.skills.degradedTitle';
    return failure === CommandPaletteProbeFailure.Refused ?
      'commands.skills.refusedTitle' : 'commands.skills.unavailableTitle';
  }

  /** The picker's explanation for a failed read. */
  static probeBodyKey(failure: string): string {
    if (failure === CommandPaletteProbeFailure.VersionGap) return 'commands.skills.degradedBody';
    return failure === CommandPaletteProbeFailure.Refused ?
      'commands.skills.refusedBody' : 'commands.skills.unavailableBody';
  }

  /**
   * Classifies a failed skill read.
   *
   * `answered` is what the wire says: the host's bridge replied to this very
   * command with a refusal rather than the request never landing. That is still
   * not enough to tell the user their desktop is out of date, so the text
   * decides — the bridge failing to deliver is a connection problem whatever
   * `answered` says, the host's version-gap sentence is the upgrade, and the
   * rest is the host declining for a reason of its own.
   */
  static probeFailure(answered: boolean, hostText: string): string {
    if (!answered) {
      return CommandPaletteProbeFailure.Unreachable;
    }
    const text = hostText.toLowerCase();
    // Checked before the version markers: a bridge that never reached a command
    // handler has no opinion about the command set either.
    for (const marker of NON_ANSWER_MARKERS) {
      if (text.indexOf(marker) >= 0) {
        return CommandPaletteProbeFailure.Unreachable;
      }
    }
    for (const marker of VERSION_GAP_MARKERS) {
      if (text.indexOf(marker) >= 0) {
        return CommandPaletteProbeFailure.VersionGap;
      }
    }
    return CommandPaletteProbeFailure.Refused;
  }

  static labelKey(kind: CommandPaletteChipKind): string {
    if (kind === CommandPaletteChipKind.Compact) return CommandPalettePolicy.compactLabelKey;
    if (kind === CommandPaletteChipKind.Init) return CommandPalettePolicy.initLabelKey;
    if (kind === CommandPaletteChipKind.Goal) return CommandPalettePolicy.goalLabelKey;
    if (kind === CommandPaletteChipKind.Usage) return CommandPalettePolicy.usageLabelKey;
    return CommandPalettePolicy.skillsLabelKey;
  }

  static sessionReasonKey(): string {
    return 'commands.sessionReason';
  }

  /**
   * The row's own line, which is now only ever about the session.
   *
   * A failed skill read is one chip's business and is explained there and in the
   * picker; repeating it under a row of working chips would say the row is broken
   * when it is not.
   */
  static rowReasonKey(availability: CommandPaletteAvailability): string {
    return availability.hasSession ? '' : CommandPalettePolicy.sessionReasonKey();
  }

  /** Whether the palette renders at all: one chip row needs a session to act on. */
  static visible(hasSession: boolean): boolean {
    return hasSession;
  }

  static canRun(chip: CommandPaletteChip): boolean {
    return chip.runsAction;
  }

  /** A settled failure is the only notice worth a retry affordance. */
  static canRetry(kind: CommandPaletteNoticeKind, wireAction: string): boolean {
    return kind === CommandPaletteNoticeKind.Failed &&
      CommandPalettePolicy.isRunnable(wireAction);
  }

  static busyNoticeKey(wireAction: string): string {
    return wireAction === CommandPalettePolicy.initWireAction ? 'commands.initRunning' : 'commands.compactRunning';
  }

  static doneNoticeKey(wireAction: string): string {
    return wireAction === CommandPalettePolicy.initWireAction ? 'commands.initDone' : 'commands.compactDone';
  }

  static failedNoticeKey(wireAction: string): string {
    return wireAction === CommandPalettePolicy.initWireAction ? 'commands.initFailed' : 'commands.compactFailed';
  }

  /** The prefill the goal chip writes into the draft. */
  static goalPrefillText(): string {
    return GOAL_PREFILL;
  }

  /**
   * Whether `/goal ` may replace what is in the composer.
   *
   * Only an empty draft may be filled: a prefill that overwrote typed text would
   * turn one tap into data loss.
   */
  static canPrefillGoal(draft: string): boolean {
    return draft.trim().length === 0;
  }

  /** Whether the draft is the goal prefill and nothing else. */
  static isGoalPrefill(draft: string): boolean {
    return draft === GOAL_PREFILL;
  }

  /**
   * `true` for a bare `/goal`, which carries no argument and is therefore not a
   * message yet. A trailing space is the prefill, not an argument.
   */
  static isBareGoalCommand(text: string): boolean {
    return text.trim() === GOAL_COMMAND;
  }

  /** Whether this draft must not be sent as it stands. */
  static blocksSend(text: string): boolean {
    return CommandPalettePolicy.isBareGoalCommand(text);
  }

  /**
   * Tapping the goal chip.
   *
   * First tap prefills an empty draft and lights the chip; tapping again takes
   * the prefill back off, but only while the draft is still just the prefill —
   * once an argument is typed the chip only stops being pending.
   */
  static toggleGoal(draft: string, pending: boolean): GoalPrefillToggle {
    if (pending) {
      if (CommandPalettePolicy.isGoalPrefill(draft)) {
        return new GoalPrefillToggle('', false);
      }
      return new GoalPrefillToggle(draft, false);
    }
    if (!CommandPalettePolicy.canPrefillGoal(draft)) {
      return new GoalPrefillToggle(draft, false);
    }
    return new GoalPrefillToggle(GOAL_PREFILL, true);
  }

  /**
   * Picking a skill.
   *
   * One token at a time: the newest pick replaces the previous one, and picking
   * the token that is already there is a no-op rather than a duplicate. The
   * comparison is on the skill's key, so re-picking a row whose display name has
   * changed is still the same pick.
   */
  static applySkillSelection(currentSkillId: string, pickedSkillId: string): string {
    const picked = pickedSkillId.trim();
    if (picked.length === 0) {
      return currentSkillId;
    }
    if (picked === currentSkillId) {
      return currentSkillId;
    }
    return picked;
  }

  /**
   * The token as the composer draws it: the exact text the message will carry.
   *
   * The label is the skill's own name, which is what the desktop puts in the
   * token it inserts (`createSkillPromptReferenceToken(skillName)`), and the
   * picker's row hint renders this same string so the two cannot describe
   * different things.
   */
  static skillTokenLabel(skillLabel: string): string {
    const label = skillLabel.trim();
    return label.length === 0 ? '' : `[$${label}]`;
  }

  /** Whether the draft opens with a host command rather than free text. */
  static startsWithHostCommand(text: string): boolean {
    const trimmed = text.trim();
    return trimmed === GOAL_COMMAND || trimmed.indexOf(`${GOAL_COMMAND} `) === 0;
  }

  /**
   * The message a skill token sends.
   *
   * The token is a chip in the composer rather than text in the field, so the
   * send path is where it becomes content, built from the same label the chip
   * drew. It goes in front of free text, which is the position a reader expects
   * and the one the host's skill reference parser accepts anywhere.
   *
   * A draft that opens with a host command keeps the command first: `/goal` is
   * parsed by the desktop from the head of the message (`thread_goal.rs`:
   * `goal_objective_from_prompt` refuses anything that does not start with
   * `/goal `), so prefixing a token there would silently turn a goal into an
   * ordinary message. The token is appended for those drafts instead.
   *
   * The token is written exactly once: a draft that already carries it keeps it,
   * which is what stops a repeated pick from stacking `[$Plan] [$Plan]`.
   */
  static composeSubmissionText(draft: string, skillLabel: string): string {
    const token = CommandPalettePolicy.skillTokenLabel(skillLabel);
    const text = draft.trim();
    if (token.length === 0) {
      return draft;
    }
    if (text.indexOf(token) >= 0) {
      return text;
    }
    if (text.length === 0) {
      return token;
    }
    return CommandPalettePolicy.startsWithHostCommand(text) ? `${text} ${token}` : `${token} ${text}`;
  }

  /** Whether a notice is still worth showing after this long, in milliseconds. */
  static noticeDwellMs(kind: CommandPaletteNoticeKind): number {
    return kind === CommandPaletteNoticeKind.Done ? 4000 : 0;
  }
}
