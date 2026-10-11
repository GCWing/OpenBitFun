package com.openbitfun.mobile.app

import android.graphics.Bitmap
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import com.openbitfun.mobile.app.ui.chat.COMPOSER_INPUT_TEST_TAG
import com.openbitfun.mobile.app.ui.chat.ComposerBar
import com.openbitfun.mobile.app.ui.chat.MODEL_CONTROL_TEST_TAG
import com.openbitfun.mobile.app.ui.chat.MODEL_SELECTOR_OPTION_TEST_TAG_PREFIX
import com.openbitfun.mobile.app.ui.chat.MODEL_SELECTOR_TEST_TAG
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.feature.session.ChatComposerCapabilities
import com.openbitfun.mobile.core.feature.session.ModelOption
import com.openbitfun.mobile.core.feature.session.ModelRole
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class ComposerModelSelectorTest {
    @get:Rule
    val composeRule = createComposeRule()

    private fun capture(name: String) {
        composeRule.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(instrumentation.targetContext.getExternalFilesDir(null), name).outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }

    @Test
    fun collapsedDraftHasNoSupplementalMicrophone() {
        composeRule.setContent {
            OpenBitFunTheme(dark = false) {
                ComposerBar(draft = "A long draft that must keep its room in the collapsed input".repeat(4),
                    images = emptyList(), busy = false, streaming = false, phase = ConnectionPhase.CONNECTED,
                    model = null, capabilities = ChatComposerCapabilities.RemoteChat, placeholder = "Message",
                    onDraftChange = {}, onRemoveImage = {}, onAttach = {}, onVoice = {}, onSend = {},
                    onStop = {}, onOpenModels = {}, modifier = androidx.compose.ui.Modifier)
            }
        }
        composeRule.onNodeWithTag("composer-voice").assertDoesNotExist()
        composeRule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).assertIsDisplayed()
        capture("parity-collapsed-draft.png")
        composeRule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).performClick()
        composeRule.onNodeWithTag("composer-voice").assertIsDisplayed()
    }

    @Test
    fun theExpandedComposerSelectsAConfiguredModel() {
        var selected = "account-primary"
        val models = listOf(
            ModelOption("primary", "Primary", "Account model", false, ModelRole.PRIMARY, emptyList(), false),
            ModelOption("fast", "Fast", "Account model", false, ModelRole.FAST, emptyList(), true),
            ModelOption("account-primary", "Primary", "Account model", true, null, listOf(ModelRole.PRIMARY), false),
            ModelOption("account-fast", "Fast", "Account model", false, null, listOf(ModelRole.FAST), false),
        )
        composeRule.setContent {
            OpenBitFunTheme(dark = false) {
                ComposerBar(
                    draft = "",
                    images = emptyList(),
                    busy = false,
                    streaming = false,
                    phase = ConnectionPhase.DISCONNECTED,
                    model = models.first(),
                    modelOptions = models,
                    capabilities = ChatComposerCapabilities.GeneralChat,
                    placeholder = "Message",
                    onDraftChange = {},
                    onRemoveImage = {},
                    onAttach = {},
                    onVoice = {},
                    onSend = {},
                    onStop = {},
                    onOpenModels = {},
                    onSelectModel = { selected = it },
                    modifier = androidx.compose.ui.Modifier,
                )
            }
        }

        composeRule.onNodeWithTag(COMPOSER_INPUT_TEST_TAG).performClick()
        composeRule.onNodeWithTag(MODEL_CONTROL_TEST_TAG).assertIsDisplayed().performClick()
        composeRule.onNodeWithTag(MODEL_SELECTOR_TEST_TAG).assertIsDisplayed()
        composeRule.onNodeWithTag(MODEL_SELECTOR_OPTION_TEST_TAG_PREFIX + "primary").assertIsDisplayed()
        composeRule.onNodeWithTag(MODEL_SELECTOR_OPTION_TEST_TAG_PREFIX + "fast").assertIsDisplayed()
        capture("parity-model-roles.png")
        composeRule.onNodeWithTag(MODEL_SELECTOR_OPTION_TEST_TAG_PREFIX + "fast").performClick()

        assertEquals("fast", selected)
    }
}
