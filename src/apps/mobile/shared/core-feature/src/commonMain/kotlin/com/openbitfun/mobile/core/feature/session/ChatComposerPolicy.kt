package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.feature.connection.ConnectionPhase

/**
 * When the composer's two primary actions are available.
 *
 * Ported from `services/ChatComposerPolicy.ets`. Both clients share it so a
 * message that Android would send is one HarmonyOS would send too — the desktop
 * rejects the rest, and a rejection after the fact reads as a lost message.
 */
public object ChatComposerPolicy {
    public fun canStop(streaming: Boolean, requiresRemoteConnection: Boolean, phase: ConnectionPhase): Boolean =
        streaming && (!requiresRemoteConnection || phase == ConnectionPhase.CONNECTED)

    /**
     * Send needs something to send, no command in flight, and — for a remote session —
     * a connected desktop. Navigation may retain an offline session, but that
     * does not authorize commands against its last-known execution state.
     */
    public fun canSend(
        text: String,
        attachmentCount: Int,
        busy: Boolean,
        requiresRemoteConnection: Boolean,
        phase: ConnectionPhase,
    ): Boolean {
        val hasContent = text.trim().isNotEmpty() || attachmentCount > 0
        val remoteAvailable =
            !requiresRemoteConnection || phase == ConnectionPhase.CONNECTED
        return hasContent && !busy && remoteAvailable
    }

    /**
     * Voice replaces send while there is nothing to send, so the same slot never
     * holds both. Connection state is deliberately not consulted: dictation is
     * local, and the text it produces can wait for the link to come back.
     */
    public fun canUseVoice(text: String, attachmentCount: Int, busy: Boolean): Boolean =
        text.trim().isEmpty() && attachmentCount == 0 && !busy

    /**
     * Which of the four things the one round button on the right is currently
     * offering.
     *
     * The composer has a single primary slot rather than a row of buttons, so
     * "which action" is a decision and not a layout detail — and it is the same
     * decision on both clients. A remote draft can steer or queue behind a running
     * turn; with no draft the same slot remains the stop control.
     */
    public fun primaryAction(
        text: String,
        attachmentCount: Int,
        busy: Boolean,
        streaming: Boolean,
        requiresRemoteConnection: Boolean,
        phase: ConnectionPhase,
        showVoiceInput: Boolean,
    ): ComposerPrimaryAction {
        if (streaming && (!requiresRemoteConnection || (text.isBlank() && attachmentCount == 0))) return ComposerPrimaryAction.STOP
        if (text.trim().isNotEmpty() || attachmentCount > 0) {
            val sendable = canSend(text, attachmentCount, busy, requiresRemoteConnection, phase)
            return if (sendable) ComposerPrimaryAction.SEND else ComposerPrimaryAction.SEND_BLOCKED
        }
        if (!showVoiceInput) return ComposerPrimaryAction.IDLE
        val usable = canUseVoice(text, attachmentCount, busy)
        return if (usable) ComposerPrimaryAction.VOICE else ComposerPrimaryAction.VOICE_BLOCKED
    }

    /**
     * Whether the bar is in its tall form, where the field gets its own row and
     * the side controls move to a second one.
     *
     * A newline counts even without focus: text the user cannot see is text they
     * cannot check before sending, and the collapsed field is one line tall.
     */
    public fun isExpanded(
        text: String,
        inputFocused: Boolean,
        quickActionsOpen: Boolean,
        modelSelectorOpen: Boolean,
    ): Boolean =
        inputFocused || quickActionsOpen || modelSelectorOpen || text.contains('\n')
}

/**
 * The states of the composer's single primary control.
 *
 * Each offered action comes in a live and a dimmed form, and the two are worth
 * separating from [IDLE]. [SEND_BLOCKED] means the user has written something
 * the link cannot carry *yet* — drawing that as idle would tell them their draft
 * does not exist. [VOICE_BLOCKED] keeps the microphone on screen through a busy
 * moment, so the control does not swap glyphs mid-turn and then swap back.
 *
 * [IDLE] is the one state with nothing to offer: a surface without dictation and
 * a composer without a draft.
 */
public enum class ComposerPrimaryAction {
    STOP,
    SEND,
    SEND_BLOCKED,
    VOICE,
    VOICE_BLOCKED,
    IDLE,
}
