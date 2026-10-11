// Each offered action has a live and a dimmed form, and both are worth keeping
// apart from Idle. SendBlocked means the user has written something the link
// cannot carry yet — drawing that as idle would tell them their draft does not
// exist. VoiceBlocked keeps the microphone on screen through a busy moment, so
// the control does not swap glyphs mid-turn and then swap back. Idle is the one
// state with nothing to offer: no dictation on this surface, and no draft.
export enum ComposerPrimaryAction {
  Stop = 'stop',
  Send = 'send',
  SendBlocked = 'send_blocked',
  Voice = 'voice',
  VoiceBlocked = 'voice_blocked',
  Idle = 'idle'
}

export class ChatComposerPolicy {
  static canStop(isTurnRunning: boolean, requiresRemoteConnection: boolean, connectionState: string): boolean {
    return isTurnRunning && (!requiresRemoteConnection || connectionState === 'connected');
  }

  static canSend(
    text: string,
    attachmentCount: number,
    isBusy: boolean,
    requiresRemoteConnection: boolean,
    connectionState: string
  ): boolean {
    const hasContent = text.trim().length > 0 || attachmentCount > 0;
    const remoteAvailable = !requiresRemoteConnection ||
      connectionState === 'connected';
    return hasContent && !isBusy && remoteAvailable;
  }

  static canUseVoice(text: string, attachmentCount: number, isBusy: boolean): boolean {
    return text.trim().length === 0 && attachmentCount === 0 && !isBusy;
  }

  /**
   * Whether the draft earns the supplemental voice slot beside the primary one.
   *
   * The primary slot belongs to Send as soon as the draft carries anything, but
   * dictation is still an input method at that point, so a draft keeps a second
   * way into it. That slot is asked for by the expanded action row alone: the
   * collapsed field is one line tall and the draft being composed has the
   * stronger claim on that room, so `ComposerBar` does not mount it inside the
   * field in any state, and a collapsed draft shows the primary action only.
   * Keeping the expanded affordance mounted while busy avoids layout movement;
   * the component dims it until recording can start again.
   */
  static shouldShowSupplementalVoice(
    text: string,
    attachmentCount: number,
    isVoiceListening: boolean,
    showVoiceInput: boolean
  ): boolean {
    return showVoiceInput && !isVoiceListening &&
      (text.trim().length > 0 || attachmentCount > 0);
  }

  static canUseSupplementalVoice(isBusy: boolean): boolean {
    return !isBusy;
  }

  // Which of the things the one round button on the right is offering. The
  // composer has a single primary slot rather than a row of buttons, so "which
  // action" is a decision, not a layout detail — and it is the same decision on
  // both clients. Dictation and a running turn used to arrive here folded into
  // one flag, but they sit on opposite sides of the draft: dictation outranks
  // it because the draft is still being spoken, whereas a running turn only
  // outranks it where the draft has nowhere to go — on a surface that can hand
  // the message over mid-run, keeping the button on Stop traps what was typed.
  static primaryAction(
    text: string,
    attachmentCount: number,
    isBusy: boolean,
    isVoiceListening: boolean,
    isTurnRunning: boolean,
    supportsMidRunSend: boolean,
    requiresRemoteConnection: boolean,
    connectionState: string,
    showVoiceInput: boolean
  ): ComposerPrimaryAction {
    if (isVoiceListening) {
      return ComposerPrimaryAction.Stop;
    }
    if (isTurnRunning && !supportsMidRunSend) {
      return ComposerPrimaryAction.Stop;
    }
    if (text.trim().length > 0 || attachmentCount > 0) {
      const sendable = ChatComposerPolicy.canSend(
        text, attachmentCount, isBusy, requiresRemoteConnection, connectionState);
      return sendable ? ComposerPrimaryAction.Send : ComposerPrimaryAction.SendBlocked;
    }
    if (isTurnRunning) {
      return ComposerPrimaryAction.Stop;
    }
    if (!showVoiceInput) {
      return ComposerPrimaryAction.Idle;
    }
    const usable = ChatComposerPolicy.canUseVoice(text, attachmentCount, isBusy);
    return usable ? ComposerPrimaryAction.Voice : ComposerPrimaryAction.VoiceBlocked;
  }

  // Whether the bar is in its tall form, where the field gets its own row and
  // the side controls move to a second one. A newline counts even without
  // focus: the collapsed field is one line tall, and text the user cannot see
  // is text they cannot check before sending.
  static isExpanded(
    text: string,
    inputFocused: boolean,
    modelSelectorOpen: boolean,
    continuingEditAfterModelSelection: boolean = false
  ): boolean {
    return inputFocused || modelSelectorOpen || continuingEditAfterModelSelection || text.indexOf('\n') >= 0;
  }

  static shouldShowAddButton(showAddButton: boolean, supportsAttachments: boolean): boolean {
    return showAddButton && supportsAttachments;
  }

  static primaryActionAccessibilityKey(
    action: ComposerPrimaryAction,
    isVoiceListening: boolean
  ): string {
    if (action === ComposerPrimaryAction.Stop) {
      return isVoiceListening ? 'chat.stopListening' : 'chat.stop';
    }
    if (action === ComposerPrimaryAction.Voice || action === ComposerPrimaryAction.VoiceBlocked) {
      return 'chat.voiceInput';
    }
    if (action === ComposerPrimaryAction.Send || action === ComposerPrimaryAction.SendBlocked) {
      return 'chat.send';
    }
    return '';
  }
}
