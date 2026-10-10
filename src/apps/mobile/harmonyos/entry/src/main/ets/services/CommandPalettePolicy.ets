/**
 * The composer command palette's rules, kept pure so they can be exercised
 * without ArkUI.
 *
 * Everything here answers one of three questions: which chip may be tapped
 * right now, what a tapped chip does to the draft, and what the draft becomes
 * when it is sent. The palette never guesses a session, never runs a verb before
 * the host has answered the probe, and never rewrites a draft the user owns.
 */

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
 * There is no capability to consult: a failed probe is the only reason the whole
 * row degrades, and a busy session is the only reason a single chip does.
 */
export enum CommandPaletteDegradeReason {
  /** The host did not answer the skill catalog read. */
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
  /** The host answered the skill catalog read, so its verbs are reachable. */
  readonly probeReady: boolean;
  readonly hasSession: boolean;
  readonly isBusy: boolean;
  /** Wire id of the palette verb currently in flight, or '' when idle. */
  readonly runningCommand: string;
  /** The goal chip is prefilled and waiting for its argument. */
  readonly goalPending: boolean;

  constructor(
    probeReady: boolean,
    hasSession: boolean,
    isBusy: boolean,
    runningCommand: string = '',
    goalPending: boolean = false
  ) {
    this.probeReady = probeReady;
    this.hasSession = hasSession;
    this.isBusy = isBusy;
    this.runningCommand = runningCommand;
    this.goalPending = goalPending;
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
    if (!availability.probeReady) {
      // The skills chip keeps opening, because the sheet is where the reason and
      // the 「重新检查」 live; the verbs have nothing to run, so their taps only
      // reveal the explanation the chip already carries.
      return new CommandPaletteChip(
        kind,
        CommandPaletteChipState.Dimmed,
        labelKey,
        CommandPalettePolicy.upgradeBadgeKey,
        chevron,
        CommandPalettePolicy.degradedReasonKey,
        kind === CommandPaletteChipKind.Skills);
    }
    // Picking a skill only edits the draft, so the sheet opens even while a turn
    // or another palette verb is running.
    if (kind === CommandPaletteChipKind.Skills) {
      return new CommandPaletteChip(
        kind, CommandPaletteChipState.Ready, labelKey, '', true, '', true);
    }
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

  /** A degraded row always carries its explanation under the chips. */
  static rowReasonKey(availability: CommandPaletteAvailability): string {
    if (!availability.hasSession) return CommandPalettePolicy.sessionReasonKey();
    if (!availability.probeReady) return CommandPalettePolicy.degradedReasonKey;
    return '';
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
   * the token that is already there is a no-op rather than a duplicate.
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

  /** The token as the composer draws it: the exact text the message will carry. */
  static skillTokenLabel(skillId: string): string {
    const id = skillId.trim();
    return id.length === 0 ? '' : `[$${id}]`;
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
   * send path is where it becomes content. It goes in front of free text, which
   * is the position a reader expects and the one the host's skill reference
   * parser accepts anywhere.
   *
   * A draft that opens with a host command keeps the command first: `/goal` is
   * parsed by the desktop from the head of the message (`thread_goal.rs`:
   * `goal_objective_from_prompt` refuses anything that does not start with
   * `/goal `), so prefixing a token there would silently turn a goal into an
   * ordinary message. The token is appended for those drafts instead.
   *
   * The token is written exactly once: a draft that already carries it keeps it,
   * which is what stops a repeated pick from stacking `[$plan] [$plan]`.
   */
  static composeSubmissionText(draft: string, skillId: string): string {
    const token = CommandPalettePolicy.skillTokenLabel(skillId);
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
