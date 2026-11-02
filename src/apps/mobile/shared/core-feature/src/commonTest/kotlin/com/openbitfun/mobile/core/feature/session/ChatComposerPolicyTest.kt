package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ChatComposerPolicyTest {
    @Test
    fun retainedTurnCannotBeCancelledWhileHostIsUnavailable() {
        for (phase in ConnectionPhase.entries) {
            assertEquals(phase == ConnectionPhase.CONNECTED, ChatComposerPolicy.canStop(true, true, phase))
        }
        assertFalse(ChatComposerPolicy.canStop(false, true, ConnectionPhase.CONNECTED))
        assertTrue(ChatComposerPolicy.canStop(true, false, ConnectionPhase.DISCONNECTED))
    }

    @Test
    fun whitespaceIsNotContent() {
        assertFalse(canSend(text = "   "))
        assertTrue(canSend(text = "ship it"))
    }

    @Test
    fun anImageAloneIsEnoughToSend() {
        assertTrue(canSend(text = "", attachmentCount = 1))
    }

    @Test
    fun aRunningTurnBlocksBothActions() {
        assertFalse(canSend(text = "ship it", busy = true))
        assertFalse(ChatComposerPolicy.canUseVoice(text = "", attachmentCount = 0, busy = true))
    }

    @Test
    fun reconnectingRetainsTheDraftUntilTheHostIsConnected() {
        // Keeping the conversation visible does not authorize an offline send.
        assertFalse(canSend(text = "ship it", phase = ConnectionPhase.RECONNECTING))
        assertFalse(canSend(text = "ship it", phase = ConnectionPhase.DISCONNECTED))
        assertFalse(canSend(text = "ship it", phase = ConnectionPhase.FAILED))
    }

    @Test
    fun aLocalSessionIgnoresTheDesktopLink() {
        assertTrue(
            canSend(
                text = "ship it",
                requiresRemoteConnection = false,
                phase = ConnectionPhase.DISCONNECTED,
            ),
        )
    }

    @Test
    fun voiceIsOfferedOnlyWhileThereIsNothingToSend() {
        assertTrue(ChatComposerPolicy.canUseVoice(text = "  ", attachmentCount = 0, busy = false))
        assertFalse(ChatComposerPolicy.canUseVoice(text = "draft", attachmentCount = 0, busy = false))
        assertFalse(ChatComposerPolicy.canUseVoice(text = "", attachmentCount = 1, busy = false))
    }

    @Test
    fun theTwoActionsNeverOverlap() {
        // Send and voice share one slot in both shells, so exactly one of them
        // may be available for any composer state that is not busy.
        listOf("" to 0, "" to 2, "draft" to 0, "draft" to 2).forEach { (text, attachments) ->
            val send = canSend(text = text, attachmentCount = attachments)
            val voice = ChatComposerPolicy.canUseVoice(text, attachments, busy = false)
            assertEquals(true, send != voice, "$text/$attachments")
        }
    }

    @Test
    fun remoteDraftCanSteerWhileAnEmptyComposerStillStops() {
        assertEquals(
            ComposerPrimaryAction.SEND,
            primaryAction(text = "ship it", streaming = true),
        )
        assertEquals(
            ComposerPrimaryAction.STOP,
            primaryAction(text = "", streaming = true),
        )
    }

    @Test
    fun localTurnsStillStopAndRemoteCommandsRespectBusyAndConnection() {
        assertEquals(ComposerPrimaryAction.STOP, primaryAction("draft", streaming = true, requiresRemoteConnection = false))
        assertEquals(ComposerPrimaryAction.SEND_BLOCKED, primaryAction("draft", streaming = true, busy = true))
        assertEquals(ComposerPrimaryAction.SEND_BLOCKED, primaryAction("draft", streaming = true, phase = ConnectionPhase.DISCONNECTED))
        assertEquals(ComposerPrimaryAction.SEND, primaryAction("", attachmentCount = 1, streaming = true))
    }

    @Test
    fun aDraftTheLinkCannotCarryIsBlockedRatherThanIdle() {
        assertEquals(
            ComposerPrimaryAction.SEND,
            primaryAction(text = "ship it"),
        )
        assertEquals(
            ComposerPrimaryAction.SEND_BLOCKED,
            primaryAction(text = "ship it", phase = ConnectionPhase.DISCONNECTED),
        )
        assertEquals(
            ComposerPrimaryAction.SEND_BLOCKED,
            primaryAction(text = "ship it", busy = true),
        )
        // An attachment is a draft too, even with the field empty.
        assertEquals(
            ComposerPrimaryAction.SEND,
            primaryAction(text = "", attachmentCount = 1),
        )
    }

    @Test
    fun anEmptyComposerOffersVoiceOnlyWhereVoiceExists() {
        assertEquals(ComposerPrimaryAction.VOICE, primaryAction(text = " "))
        // Only a surface without dictation is truly idle. A busy one keeps the
        // microphone on screen dimmed rather than swapping in an arrow for the
        // length of a turn and swapping it back out again.
        assertEquals(
            ComposerPrimaryAction.IDLE,
            primaryAction(text = " ", showVoiceInput = false),
        )
        assertEquals(ComposerPrimaryAction.VOICE_BLOCKED, primaryAction(text = "", busy = true))
    }

    @Test
    fun theSlotAgreesWithTheTwoAvailabilityRules() {
        // Whatever the state, the slot must never offer send when canSend is
        // false or voice when canUseVoice is false — one widget, one truth.
        val phases = listOf(ConnectionPhase.CONNECTED, ConnectionPhase.DISCONNECTED)
        listOf("" to 0, "draft" to 0, "" to 2).forEach { (text, attachments) ->
            listOf(false, true).forEach { busy ->
                phases.forEach { phase ->
                    val action = primaryAction(
                        text = text,
                        attachmentCount = attachments,
                        busy = busy,
                        phase = phase,
                    )
                    val send = canSend(
                        text = text,
                        attachmentCount = attachments,
                        busy = busy,
                        phase = phase,
                    )
                    val voice = ChatComposerPolicy.canUseVoice(text, attachments, busy)
                    val label = "$text/$attachments/busy=$busy/$phase"
                    assertEquals(send, action == ComposerPrimaryAction.SEND, label)
                    assertEquals(voice, action == ComposerPrimaryAction.VOICE, label)
                }
            }
        }
    }

    @Test
    fun aHiddenNewlineExpandsTheBarWithoutFocus() {
        // The collapsed field is one line tall, so a second line the user cannot
        // see is a second line they cannot check before sending.
        assertTrue(ChatComposerPolicy.isExpanded("one\ntwo", false, false, false))
        assertFalse(ChatComposerPolicy.isExpanded("one line", false, false, false))
        assertTrue(ChatComposerPolicy.isExpanded("", true, false, false))
        assertTrue(ChatComposerPolicy.isExpanded("", false, true, false))
        assertTrue(ChatComposerPolicy.isExpanded("", false, false, true))
    }

    private fun canSend(
        text: String,
        attachmentCount: Int = 0,
        busy: Boolean = false,
        requiresRemoteConnection: Boolean = true,
        phase: ConnectionPhase = ConnectionPhase.CONNECTED,
    ) = ChatComposerPolicy.canSend(text, attachmentCount, busy, requiresRemoteConnection, phase)

    private fun primaryAction(
        text: String,
        attachmentCount: Int = 0,
        busy: Boolean = false,
        streaming: Boolean = false,
        requiresRemoteConnection: Boolean = true,
        phase: ConnectionPhase = ConnectionPhase.CONNECTED,
        showVoiceInput: Boolean = true,
    ) = ChatComposerPolicy.primaryAction(
        text,
        attachmentCount,
        busy,
        streaming,
        requiresRemoteConnection,
        phase,
        showVoiceInput,
    )
}
