package com.openbitfun.mobile.app

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.openbitfun.mobile.app.ui.chat.CONVERSATION_LIST_TEST_TAG
import com.openbitfun.mobile.app.ui.chat.CONVERSATION_LOADING_TEST_TAG
import com.openbitfun.mobile.app.ui.chat.CHAT_STATUS_BAR_TEST_TAG
import com.openbitfun.mobile.app.ui.chat.ConversationEmptyState
import com.openbitfun.mobile.app.ui.chat.ConversationTimelineView
import com.openbitfun.mobile.app.ui.chat.COMPOSER_INPUT_TEST_TAG
import com.openbitfun.mobile.app.ui.chat.COMPOSER_SEND_TEST_TAG
import com.openbitfun.mobile.app.ui.chat.ConversationView
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.feature.layout.SettingsPlacement
import com.openbitfun.mobile.core.feature.layout.SettingsPlacementMode
import com.openbitfun.mobile.core.feature.session.ConversationRow
import com.openbitfun.mobile.core.feature.session.ConversationRowKind
import com.openbitfun.mobile.core.feature.session.RemoteSessionIntent
import com.openbitfun.mobile.core.feature.session.RemoteSessionUiState
import com.openbitfun.mobile.core.feature.session.SessionAgentFilter
import com.openbitfun.mobile.core.feature.workspace.RemoteFileDownloadUiState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ConversationViewTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun permissionDraftSurvivesSavedStateRestoration() {
        val restoration = androidx.compose.ui.test.junit4.StateRestorationTester(composeRule)
        val intents = mutableListOf<RemoteSessionIntent>()
        val mailbox = com.openbitfun.mobile.core.feature.session.PermissionMailboxUiState(listOf(
            com.openbitfun.mobile.core.feature.session.PermissionMailboxRequest(
                "request-1", "write", listOf("/workspace/readme.md"), null, "Write")
        ), false, false)
        restoration.setContent {
            OpenBitFunTheme(dark = false) {
                com.openbitfun.mobile.app.ui.chat.PermissionMailboxView(mailbox, "session", 600.dp, intents::add)
            }
        }
        val draft = """{"content":"retained edit"}"""
        composeRule.onNodeWithText(string(R.string.tool_edit_approval_input)).performClick()
        composeRule.onNodeWithText("{}").performTextReplacement(draft)
        restoration.emulateSavedInstanceStateRestore()
        composeRule.onNodeWithText(draft).assertIsDisplayed()
        composeRule.onNodeWithText(string(R.string.tool_approve)).performClick()
        val reply = intents.filterIsInstance<RemoteSessionIntent.RespondPermission>().single()
        assertEquals("request-1", reply.requestId)
        assertEquals(draft, reply.updatedInput)
    }

    @Test
    fun permissionDraftDoesNotBlockRejectionAndMailboxStaysOutsideComposer() {
        val intents = mutableListOf<RemoteSessionIntent>()
        val state = readyState(sessionId = "session").copy(permissionMailbox =
            com.openbitfun.mobile.core.feature.session.PermissionMailboxUiState(listOf(
                com.openbitfun.mobile.core.feature.session.PermissionMailboxRequest(
                    "request-1", "write", listOf("/workspace/readme.md"), null, "Write")
            ), false, false))
        val dark = androidx.test.platform.app.InstrumentationRegistry.getArguments().getString("mailboxDark") == "true"
        setConversationContent(state = { state }, onIntent = intents::add, dark = dark)
        composeRule.onNodeWithText("/workspace/readme.md").assertIsDisplayed()
        val capture = composeRule.onRoot().captureToImage().asAndroidBitmap()
        val context = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext
        val values = android.content.ContentValues().apply {
            put(android.provider.MediaStore.Downloads.DISPLAY_NAME, "openbitfun-permission-mailbox-${if (dark) "dark" else "light"}.png")
            put(android.provider.MediaStore.Downloads.MIME_TYPE, "image/png")
        }
        val uri = requireNotNull(context.contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values))
        requireNotNull(context.contentResolver.openOutputStream(uri)).use {
            capture.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
        val requestBounds = composeRule.onNodeWithText("/workspace/readme.md").getUnclippedBoundsInRoot()
        val composerBounds = composeRule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).getUnclippedBoundsInRoot()
        assertTrue(requestBounds.bottom < composerBounds.top)
        composeRule.onNodeWithText(string(R.string.tool_edit_approval_input)).performClick()
        composeRule.onNodeWithText("{}").performTextReplacement("{invalid")
        composeRule.onNodeWithText(string(R.string.tool_approve)).assertIsNotEnabled()
        composeRule.onNodeWithText(string(R.string.tool_reject)).performScrollTo().performClick()
        val reply = intents.filterIsInstance<RemoteSessionIntent.RespondPermission>().single()
        assertEquals("request-1", reply.requestId)
        assertEquals(false, reply.approve)
        assertEquals(null, reply.updatedInput)
    }

    @Test
    fun multiplePermissionsScrollIndependentlyWithoutHidingComposer() {
        val intents = mutableListOf<RemoteSessionIntent>()
        val requests = (1..10).map { index ->
            com.openbitfun.mobile.core.feature.session.PermissionMailboxRequest(
                "request-$index", "write", listOf("/workspace/file-$index.md"), null, "Write")
        }
        val state = readyState(sessionId = "session").copy(permissionMailbox =
            com.openbitfun.mobile.core.feature.session.PermissionMailboxUiState(requests, false, false))
        setConversationContent(state = { state }, onIntent = intents::add)
        composeRule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).assertIsDisplayed()
        val composerBefore = composeRule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).getUnclippedBoundsInRoot()
        composeRule.onAllNodesWithText(string(R.string.tool_reject))[9].performScrollTo().assertIsDisplayed().performClick()
        composeRule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).assertIsDisplayed()
        assertEquals(composerBefore, composeRule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).getUnclippedBoundsInRoot())
        val reply = intents.filterIsInstance<RemoteSessionIntent.RespondPermission>().single()
        assertEquals("request-10", reply.requestId)
        assertEquals(false, reply.approve)
    }

    @Test
    fun openingATallLastMessageStartsAtTheActualTail() {
        val answer = List(500) { "A long answer line." }.joinToString(" ") + " tail-marker"

        composeRule.setContent {
            OpenBitFunTheme(dark = false) {
                ConversationTimelineView(
                    rows = listOf(assistantRow(answer)),
                    hasMoreMessages = false,
                    onLoadOlder = {},
                    enabled = true,
                    onApproveTool = { _, _ -> },
                    onRejectTool = { _, _ -> },
                    onCancelTool = { _, _ -> },
                    onAnswerTool = { _, _ -> },
                    onAnswerToolStructured = { _, _ -> },
                    onRetry = {},
                    onOpenFile = { _, _ -> },
                    previewingRemotePath = "",
                    previewLoading = false,
                    download = RemoteFileDownloadUiState.None,
                    onDownloadFile = { _, _ -> },
                    downloadEnabled = true,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }

        composeRule.waitForIdle()

        val listBounds = composeRule.onNodeWithTag(CONVERSATION_LIST_TEST_TAG)
            .getUnclippedBoundsInRoot()
        val answerBounds = composeRule.onNodeWithText("tail-marker", substring = true)
            .getUnclippedBoundsInRoot()
        assertTrue(answerBounds.bottom <= listBounds.bottom + 1.dp)
        composeRule.onNodeWithContentDescription(string(R.string.chat_scroll_to_bottom))
            .assertDoesNotExist()
    }

    @Test
    fun streamingGrowthKeepsFollowingWhileTheReaderIsAtTheTail() {
        val row = mutableStateOf(assistantRow("stream-start", streaming = true))

        composeRule.setContent {
            OpenBitFunTheme(dark = false) {
                TimelineForTest(listOf(row.value))
            }
        }
        composeRule.runOnIdle {
            row.value = assistantRow(
                List(500) { "Streaming answer line." }.joinToString(" ") + " stream-tail-marker",
                streaming = true,
            )
        }
        composeRule.waitForIdle()

        val listBounds = composeRule.onNodeWithTag(CONVERSATION_LIST_TEST_TAG)
            .getUnclippedBoundsInRoot()
        val answerBounds = composeRule.onNodeWithText("stream-tail-marker", substring = true)
            .getUnclippedBoundsInRoot()
        assertTrue(answerBounds.bottom <= listBounds.bottom + 1.dp)
        composeRule.onNodeWithContentDescription(string(R.string.chat_scroll_to_bottom))
            .assertDoesNotExist()
    }

    @Test
    fun streamingGrowthDoesNotStealTheReaderAfterTheyLeaveTheTail() {
        val rows = mutableStateOf((1..40).map { index -> assistantRow("message-$index", id = "message-$index") })

        composeRule.setContent {
            OpenBitFunTheme(dark = false) {
                TimelineForTest(rows.value)
            }
        }
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(CONVERSATION_LIST_TEST_TAG).performTouchInput {
            swipeDown()
            swipeDown()
        }
        composeRule.waitForIdle()
        composeRule.onNodeWithContentDescription(string(R.string.chat_scroll_to_bottom)).assertIsDisplayed()

        composeRule.runOnIdle {
            rows.value = rows.value.dropLast(1) +
                assistantRow(
                    List(400) { "Growing final answer." }.joinToString(" ") + " reader-tail-marker",
                    id = "message-40",
                    streaming = true,
                )
        }
        composeRule.waitForIdle()

        composeRule.onNodeWithContentDescription(string(R.string.chat_scroll_to_bottom))
            .assertIsDisplayed()
            .performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("reader-tail-marker", substring = true).assertIsDisplayed()
        composeRule.onNodeWithContentDescription(string(R.string.chat_scroll_to_bottom))
            .assertDoesNotExist()
    }

    @Test
    fun withLoadOlderHeaderStreamingGrowthStaysOnTheRealTail() {
        val rows = mutableStateOf(
            (1..40).map { index -> assistantRow("message-$index", id = "message-$index") },
        )

        composeRule.setContent {
            OpenBitFunTheme(dark = false) {
                TimelineForTest(rows.value, hasMoreMessages = true)
            }
        }
        composeRule.waitForIdle()

        composeRule.runOnIdle {
            rows.value = rows.value.dropLast(1) +
                assistantRow(
                    List(500) { "Growing tail line." }.joinToString(" ") + " header-tail-marker",
                    id = "message-40",
                    streaming = true,
                )
        }
        composeRule.waitForIdle()

        val listBounds = composeRule.onNodeWithTag(CONVERSATION_LIST_TEST_TAG)
            .getUnclippedBoundsInRoot()
        val tailBounds = composeRule.onNodeWithText("header-tail-marker", substring = true)
            .getUnclippedBoundsInRoot()
        assertTrue(tailBounds.bottom <= listBounds.bottom + 1.dp)
        composeRule.onNodeWithContentDescription(string(R.string.chat_scroll_to_bottom))
            .assertDoesNotExist()
    }

    @Test
    fun conversationWithNoTimelineShowsLoadingStateInsteadOfBlankSurface() {
        setConversationContent(state = { readyState() })

        composeRule.mainClock.advanceTimeBy(200)
        composeRule.onNodeWithTag(CONVERSATION_LOADING_TEST_TAG).assertIsDisplayed()
    }

    @Test
    fun loadingDefersSkeletonAndNeverShowsAConnectionStrip() {
        composeRule.mainClock.autoAdvance = false
        setConversationContent(
            state = { readyState(sessionId = "pending").copy(busy = true) },
            phase = ConnectionPhase.RECONNECTING,
        )
        composeRule.mainClock.advanceTimeByFrame()
        composeRule.onNodeWithTag(CONVERSATION_LOADING_TEST_TAG).assertDoesNotExist()
        composeRule.onNodeWithTag(CHAT_STATUS_BAR_TEST_TAG).assertDoesNotExist()
        composeRule.mainClock.advanceTimeBy(200)
        composeRule.onNodeWithTag(CONVERSATION_LOADING_TEST_TAG).assertIsDisplayed()
        composeRule.onNodeWithTag(CHAT_STATUS_BAR_TEST_TAG).assertDoesNotExist()
    }

    /**
     * A placeholder that outlives its subject reads as a hang, so the skeleton
     * gives up on a transcript that never lands and lets the pane speak for
     * itself. Matches HarmonyOS's `DeferredLoadingGate` cap.
     */
    @Test
    fun loadingSkeletonStopsStandingForATranscriptThatNeverArrives() {
        composeRule.mainClock.autoAdvance = false
        setConversationContent(state = { readyState(sessionId = "pending") })
        composeRule.mainClock.advanceTimeBy(200)
        composeRule.onNodeWithTag(CONVERSATION_LOADING_TEST_TAG).assertIsDisplayed()
        composeRule.mainClock.advanceTimeBy(20_000)
        composeRule.onNodeWithTag(CONVERSATION_LOADING_TEST_TAG).assertDoesNotExist()
    }

    @Test
    fun composerShowsTheStoreDraftAndTypingDispatchesUpdateDraft() {
        val intents = mutableListOf<RemoteSessionIntent>()
        val state = mutableStateOf(readyState(sessionId = "s-code", draft = "existing draft"))

        setConversationContent(state = { state.value }, onIntent = { intents += it })

        composeRule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).assertTextEquals("existing draft")
        composeRule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).performTextReplacement("replaced draft")

        assertEquals(
            listOf<RemoteSessionIntent>(RemoteSessionIntent.UpdateDraft("replaced draft")),
            intents,
        )
    }

    @Test
    fun composerFollowsStoreDraftUpdatesWithinTheSameSession() {
        val state = mutableStateOf(readyState(sessionId = "s-code", draft = "first"))

        setConversationContent(state = { state.value })

        composeRule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).assertTextEquals("first")
        composeRule.runOnIdle { state.value = state.value.copy(draft = "second") }
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).assertTextEquals("second")
    }

    @Test
    fun switchingSessionsShowsTheRestoredDraft() {
        val state = mutableStateOf(readyState(sessionId = "s-a", draft = "draft-a"))

        setConversationContent(state = { state.value })

        composeRule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).assertTextEquals("draft-a")
        composeRule.runOnIdle {
            state.value = readyState(sessionId = "s-b", draft = "draft-b")
        }
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).assertTextEquals("draft-b")
    }

    @Test
    fun acceptedSendClearsImmediatelyAndFailureRestoresDraft() {
        val intents = mutableListOf<RemoteSessionIntent>()

        val state = mutableStateOf(readyState(sessionId = "s-code", draft = "send me"))
        setConversationContent(
            state = { state.value },
            onIntent = { intents += it; state.value = state.value.copy(busy = true) },
        )

        composeRule.onNodeWithTag(COMPOSER_SEND_TEST_TAG).performClick()

        assertEquals(
            listOf<RemoteSessionIntent>(RemoteSessionIntent.SendMessage("s-code", "send me", null)),
            intents,
        )
        composeRule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).assert(
            SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")),
        )
        composeRule.runOnIdle { state.value = state.value.copy(busy = false) }
        composeRule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).assertTextEquals("send me")
    }

    @Test
    fun emptyStateShowsInvitationCopy() {
        composeRule.setContent {
            OpenBitFunTheme(dark = false) {
                ConversationEmptyState(modifier = Modifier.fillMaxSize())
            }
        }
        composeRule.onNodeWithText(string(R.string.chat_empty_title)).assertIsDisplayed()
        composeRule.onNodeWithText(string(R.string.chat_empty_hint)).assertIsDisplayed()
    }

    @Test
    fun reconnectingKeepsConversationAndComposerWithoutHeaderBanner() {
        setConversationContent(
            state = { readyState() },
            phase = ConnectionPhase.RECONNECTING,
        )
        composeRule.onNodeWithTag(CHAT_STATUS_BAR_TEST_TAG).assertDoesNotExist()
        composeRule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).assertIsDisplayed()
        composeRule.onNodeWithTag(COMPOSER_SEND_TEST_TAG).assertIsNotEnabled()
    }

    /**
     * The composer and the header float over the transcript rather than sitting
     * above and below it in a column, so the list runs the full height of the
     * pane and these insets are the only thing keeping the first and last
     * message out from under them. The insets are measured from the live
     * overlays, so growing one — a composer going multiline, an image strip
     * appearing — has to push the transcript rather than cover it.
     */
    @Test
    fun insetsKeepTheEndsOfTheTranscriptClearOfTheFloatingOverlays() {
        val bottomInset = mutableStateOf(96.dp)
        composeRule.setContent {
            OpenBitFunTheme(dark = false) {
                TimelineForTest(
                    rows = listOf(assistantRow("inset-marker")),
                    topInset = 72.dp,
                    bottomInset = bottomInset.value,
                )
            }
        }
        composeRule.waitForIdle()

        val listBounds = composeRule.onNodeWithTag(CONVERSATION_LIST_TEST_TAG)
            .getUnclippedBoundsInRoot()
        val resting = composeRule.onNodeWithText("inset-marker", substring = true)
            .getUnclippedBoundsInRoot()
        assertTrue(resting.bottom <= listBounds.bottom - 96.dp + 1.dp)
        assertTrue(resting.top >= listBounds.top)

        composeRule.runOnIdle { bottomInset.value = 180.dp }
        composeRule.waitForIdle()

        val lifted = composeRule.onNodeWithText("inset-marker", substring = true)
            .getUnclippedBoundsInRoot()
        assertTrue(lifted.bottom <= listBounds.bottom - 180.dp + 1.dp)
        assertTrue(lifted.bottom < resting.bottom)
    }

    private fun setConversationContent(
        state: () -> RemoteSessionUiState.Ready,
        phase: ConnectionPhase = ConnectionPhase.CONNECTED,
        onIntent: (RemoteSessionIntent) -> Unit = {},
        dark: Boolean = false,
    ) {
        composeRule.setContent {
            OpenBitFunTheme(dark = dark) {
                androidx.compose.material3.Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = androidx.compose.material3.MaterialTheme.colorScheme.background,
                    contentColor = androidx.compose.material3.MaterialTheme.colorScheme.onBackground,
                ) {
                    ConversationView(
                        state = state(),
                        phase = phase,
                        settingsPlacement = SettingsPlacement(SettingsPlacementMode.BOTTOM, 0, 0, 0),
                        onBack = {},
                        onIntent = onIntent,
                        contextTitle = "Test desktop",
                        onOpenFile = { _, _ -> },
                        previewingRemotePath = "",
                        previewLoading = false,
                        download = RemoteFileDownloadUiState.None,
                        onDownloadFile = { _, _ -> },
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
        }
    }


    private fun readyState(
        sessionId: String = "",
        draft: String = "",
    ) = RemoteSessionUiState.Ready(
        sessions = emptyList(),
        selectedSessionId = sessionId,
        timeline = null,
        busy = false,
        permissionMode = null,
        permissionModeFailure = null,
        query = "",
        agentFilter = SessionAgentFilter.ALL,
        hasMore = false,
        hasMoreMessages = false,
        modelCatalog = null,
        modelCatalogFailure = null,
        draft = draft,
    )

    @Composable
    private fun TimelineForTest(
        rows: List<ConversationRow>,
        hasMoreMessages: Boolean = false,
        topInset: Dp = 0.dp,
        bottomInset: Dp = 0.dp,
    ) {
        ConversationTimelineView(
            rows = rows,
            hasMoreMessages = hasMoreMessages,
            topInset = topInset,
            bottomInset = bottomInset,
            onLoadOlder = {},
            enabled = true,
            onApproveTool = { _, _ -> },
            onRejectTool = { _, _ -> },
            onCancelTool = { _, _ -> },
            onAnswerTool = { _, _ -> },
            onAnswerToolStructured = { _, _ -> },
            onRetry = {},
            onOpenFile = { _, _ -> },
            previewingRemotePath = "",
            previewLoading = false,
            download = RemoteFileDownloadUiState.None,
            onDownloadFile = { _, _ -> },
            downloadEnabled = true,
            modifier = Modifier.fillMaxSize(),
        )
    }

    private fun assistantRow(
        answer: String,
        id: String = "message-1",
        streaming: Boolean = false,
    ): ConversationRow = ConversationRow(
        id = id,
        kind = ConversationRowKind.ASSISTANT,
        text = answer,
        thinking = null,
        images = emptyList(),
        tools = emptyList(),
        blocks = emptyList(),
        streaming = streaming,
        typing = false,
        pending = false,
        showRetry = false,
        error = null,
        live = false,
    )

    private fun string(resource: Int): String =
        InstrumentationRegistry.getInstrumentation().targetContext.getString(resource)
}
