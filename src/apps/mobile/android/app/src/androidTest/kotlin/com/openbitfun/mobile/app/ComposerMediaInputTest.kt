package com.openbitfun.mobile.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.speech.RecognizerIntent
import android.util.Base64
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.core.app.ActivityOptionsCompat
import androidx.test.platform.app.InstrumentationRegistry
import com.openbitfun.mobile.app.platform.launchComposerActivity
import com.openbitfun.mobile.app.platform.prepareComposerImage
import com.openbitfun.mobile.app.ui.chat.COMPOSER_INPUT_TEST_TAG
import com.openbitfun.mobile.app.ui.chat.ConversationView
import com.openbitfun.mobile.app.ui.chat.decodeInlineImage
import com.openbitfun.mobile.app.ui.chat.rememberComposerVoiceInput
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.feature.layout.SettingsPlacement
import com.openbitfun.mobile.core.feature.layout.SettingsPlacementMode
import com.openbitfun.mobile.core.feature.session.RemoteSessionIntent
import com.openbitfun.mobile.core.feature.session.RemoteSessionUiState
import com.openbitfun.mobile.core.feature.session.SessionAgentFilter
import com.openbitfun.mobile.core.feature.workspace.RemoteFileDownloadUiState
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ComposerMediaInputTest {
    @get:Rule val rule = createComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun unavailableSystemActivitiesKeepRemoteDraftEditable() {
        val registry = MediaRegistry { throw ActivityNotFoundException("No system handler") }
        val intents = mutableListOf<RemoteSessionIntent>()
        val sessionId = "media-${UUID.randomUUID()}"
        rule.setContent { RemoteComposer(registry, sessionId, intents::add) }
        rule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).assertIsEnabled()
        rule.onNodeWithContentDescription(context.getString(R.string.message_attach_image)).performClick()
        rule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).performClick()
        rule.onNodeWithTag("composer-voice").performClick()
        rule.onNodeWithText("Keep this draft").assertIsDisplayed()
        rule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).assertIsEnabled()
        rule.runOnIdle {
            assertEquals(2, registry.launches)
            assertTrue(intents.isEmpty())
        }
    }

    @Test fun deniedSystemActivityIsRecoverable() {
        rule.runOnIdle {
            assertFalse(launchComposerActivity(context, R.string.chat_photo_picker_unavailable) {
                throw SecurityException("Handler is not exported")
            })
        }
    }

    @Test fun dictationUsesCurrentDraftCallbackAndSurvivesRecreation() {
        val registry = MediaRegistry()
        val owner = mutableStateOf("device-a/session")
        val draft = mutableStateOf("old draft")
        val received = mutableListOf<String>()
        val restoration = StateRestorationTester(rule)
        restoration.setContent {
            CompositionLocalProvider(LocalActivityResultRegistryOwner provides registry) {
                val before = draft.value
                val launch = rememberComposerVoiceInput(owner.value) { received += "$before/$it" }
                Button(onClick = launch) { Text("Dictate") }
            }
        }
        rule.onNodeWithText("Dictate").performClick()
        restoration.emulateSavedInstanceStateRestore()
        rule.runOnIdle { draft.value = "new draft" }
        rule.waitForIdle()
        rule.runOnIdle { registry.replySpeech("recognized") }
        rule.runOnIdle { assertEquals(listOf("new draft/recognized"), received) }
    }

    @Test fun dictationDoesNotCrossDeviceOrSessionBoundaries() {
        val registry = MediaRegistry()
        val owner = mutableStateOf("device-a/session")
        val received = mutableListOf<String>()
        rule.setContent {
            CompositionLocalProvider(LocalActivityResultRegistryOwner provides registry) {
                val launch = rememberComposerVoiceInput(owner.value, received::add)
                Button(onClick = launch) { Text("Dictate") }
            }
        }
        rule.onNodeWithText("Dictate").performClick()
        rule.runOnIdle { owner.value = "device-b/session" }
        rule.waitForIdle()
        rule.runOnIdle { registry.replySpeech("another device's text") }
        rule.runOnIdle { assertTrue(received.isEmpty()) }
        rule.onNodeWithText("Dictate").performClick()
        rule.runOnIdle { registry.dispatchResult(registry.requestCode, Activity.RESULT_CANCELED, null) }
        rule.runOnIdle { assertTrue(received.isEmpty()) }
        rule.onNodeWithText("Dictate").performClick()
        rule.runOnIdle { registry.replySpeech("current device") }
        rule.runOnIdle { assertEquals(listOf("current device"), received) }
    }

    @Test fun cameraPhotoIsResizedForUploadAndInlinePreview() = runBlocking {
        val file = File(context.cacheDir, "media-${UUID.randomUUID()}.jpg")
        val bitmap = Bitmap.createBitmap(4000, 3000, Bitmap.Config.ARGB_8888)
        try {
            file.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it)) }
        } finally { bitmap.recycle() }
        try {
            val image = prepareComposerImage(context.contentResolver, Uri.fromFile(file))
            assertEquals("image/jpeg", image.mimeType)
            val bytes = Base64.decode(image.dataUrl.substringAfter(','), Base64.DEFAULT)
            assertTrue(bytes.size <= 1024 * 1024)
            val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
            android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            assertEquals(1920, maxOf(bounds.outWidth, bounds.outHeight))
            val preview = requireNotNull(decodeInlineImage(image.dataUrl))
            try { assertTrue(maxOf(preview.width, preview.height) <= 512) }
            finally { preview.recycle() }
            // History from older clients can still carry the original full-size photo.
            val original = "data:image/jpeg;base64," + Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
            val legacyPreview = requireNotNull(decodeInlineImage(original))
            try { assertTrue(maxOf(legacyPreview.width, legacyPreview.height) <= 512) }
            finally { legacyPreview.recycle() }
        } finally { file.delete() }
    }

    @Test fun invalidInlineImagesRemainCaptionOnly() {
        assertNull(decodeInlineImage("https://example.com/image.jpg"))
        assertNull(decodeInlineImage("data:image/png;base64,not-base64"))
        assertNull(decodeInlineImage("data:image/png;base64," + Base64.encodeToString(byteArrayOf(1, 2, 3), Base64.NO_WRAP)))
    }

    @Test fun selectedPhotoCanBeSentAndRetainedWithoutAcknowledgement() {
        val registry = MediaRegistry()
        val intents = mutableListOf<RemoteSessionIntent>()
        val sessionId = "media-${UUID.randomUUID()}"
        val file = File(context.cacheDir, "$sessionId.png")
        val bitmap = Bitmap.createBitmap(32, 24, Bitmap.Config.ARGB_8888)
        try { file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) } }
        finally { bitmap.recycle() }
        try {
            rule.setContent { RemoteComposer(registry, sessionId, intents::add) }
            rule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).assertIsEnabled()
            rule.onNodeWithContentDescription(context.getString(R.string.message_attach_image)).performClick()
            rule.runOnIdle {
                registry.dispatchResult(registry.requestCode, Activity.RESULT_OK, Intent().setData(Uri.fromFile(file)))
            }
            rule.waitUntil(5_000) {
                rule.onAllNodesWithContentDescription(context.getString(R.string.message_remove_image))
                    .fetchSemanticsNodes().size == 1
            }
            rule.onNodeWithContentDescription(context.getString(R.string.message_remove_image)).assertIsEnabled()
            rule.onNodeWithTag(com.openbitfun.mobile.app.ui.chat.COMPOSER_SEND_TEST_TAG).performClick()
            rule.runOnIdle {
                val image = intents.filterIsInstance<RemoteSessionIntent.SendMessage>().single().images!!.single()
                assertEquals("image/jpeg", image.mimeType)
                assertTrue(image.dataUrl.startsWith("data:image/jpeg;base64,"))
            }
            // The controlled host has not acknowledged this send. Keep its attachment.
            rule.onNodeWithContentDescription(context.getString(R.string.message_remove_image)).assertIsDisplayed()
        } finally { file.delete() }
    }

    @Test fun unreadableSelectedPhotoDoesNotCrashOrEraseDraft() {
        val registry = MediaRegistry()
        val sessionId = "media-${UUID.randomUUID()}"
        rule.setContent { RemoteComposer(registry, sessionId) {} }
        rule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).assertIsEnabled()
        rule.onNodeWithContentDescription(context.getString(R.string.message_attach_image)).performClick()
        rule.runOnIdle {
            registry.dispatchResult(registry.requestCode, Activity.RESULT_OK,
                Intent().setData(Uri.parse("content://com.openbitfun.missing-provider/photo")))
        }
        rule.waitForIdle()
        rule.onNodeWithText("Keep this draft").assertIsDisplayed()
        rule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).assertIsEnabled()
    }

    @Composable
    private fun RemoteComposer(registry: MediaRegistry, sessionId: String, onIntent: (RemoteSessionIntent) -> Unit) {
        CompositionLocalProvider(LocalActivityResultRegistryOwner provides registry) {
            OpenBitFunTheme(dark = false) {
                ConversationView(
                    state = RemoteSessionUiState.Ready(
                        sessions = emptyList(), selectedSessionId = sessionId,
                        timeline = null, busy = false, permissionMode = null, permissionModeFailure = null,
                        query = "", agentFilter = SessionAgentFilter.ALL, hasMore = false,
                        hasMoreMessages = false, modelCatalog = null, modelCatalogFailure = null,
                        draft = "Keep this draft",
                    ),
                    phase = ConnectionPhase.CONNECTED,
                    settingsPlacement = SettingsPlacement(SettingsPlacementMode.BOTTOM, 0, 0, 0),
                    onBack = {}, onIntent = onIntent, contextTitle = "Test desktop",
                    onOpenFile = { _, _ -> }, previewingRemotePath = "", previewLoading = false,
                    download = RemoteFileDownloadUiState.None, onDownloadFile = { _, _ -> },
                    modifier = Modifier,
                )
            }
        }
    }

    private class MediaRegistry(private val fail: (() -> Unit)? = null) : ActivityResultRegistry(), ActivityResultRegistryOwner {
        override val activityResultRegistry: ActivityResultRegistry get() = this
        var launches = 0
        var requestCode = 0
        override fun <I, O> onLaunch(requestCode: Int, contract: ActivityResultContract<I, O>, input: I, options: ActivityOptionsCompat?) {
            launches++
            this.requestCode = requestCode
            fail?.invoke()
        }
        fun replySpeech(text: String) {
            dispatchResult(requestCode, Activity.RESULT_OK,
                Intent().putStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS, arrayListOf(text)))
        }
    }
}
