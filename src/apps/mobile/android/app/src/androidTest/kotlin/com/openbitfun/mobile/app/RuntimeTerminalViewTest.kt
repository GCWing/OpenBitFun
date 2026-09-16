package com.openbitfun.mobile.app

import android.view.KeyEvent
import android.webkit.WebView
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom
import androidx.test.platform.app.InstrumentationRegistry
import com.openbitfun.mobile.app.ui.remote.RuntimeTerminalDialog
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceIntent
import com.openbitfun.mobile.core.feature.workspace.RuntimeTerminalUiState
import java.util.concurrent.CopyOnWriteArrayList
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.json.JSONTokener
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class RuntimeTerminalViewTest {
    @get:Rule val compose = createComposeRule()

    @Test fun touchingTerminalRoutesNativeKeysToPtyInsteadOfDialogButtons() {
        val intents = CopyOnWriteArrayList<RemoteWorkspaceIntent>()
        var dismissed = false
        compose.setContent {
            OpenBitFunTheme(dark = false) {
                RuntimeTerminalDialog(
                    RuntimeTerminalUiState("test-pty", "ready\r\n", false, false),
                    { intents += it },
                    { dismissed = true },
                )
            }
        }
        compose.waitUntil(10_000) { intents.any { it is RemoteWorkspaceIntent.ResizeTerminal } }
        onView(isAssignableFrom(WebView::class.java)).perform(click()).check { view, error ->
            if (error != null) throw error
            assertTrue("The native WebView must own focus, not only its DOM textarea", view.hasFocus())
        }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.sendStringSync("pwd")
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
        compose.waitUntil(10_000) {
            intents.filterIsInstance<RemoteWorkspaceIntent.WriteTerminal>().joinToString("") { it.data } == "pwd\r"
        }
        compose.runOnIdle {
            assertFalse(dismissed)
            assertFalse(intents.any { it is RemoteWorkspaceIntent.CloseTerminal })
        }
    }

    @Test fun switchingThemeKeepsTheNativeTerminalAndItsOutput() {
        val dark = mutableStateOf(false)
        val intents = CopyOnWriteArrayList<RemoteWorkspaceIntent>()
        compose.setContent {
            OpenBitFunTheme(dark = dark.value) {
                RuntimeTerminalDialog(RuntimeTerminalUiState("theme-pty", "retained output\r\n", false, false), { intents += it }, {})
            }
        }
        compose.waitUntil(10_000) { intents.any { it is RemoteWorkspaceIntent.ResizeTerminal } }
        var terminal: WebView? = null
        onView(isAssignableFrom(WebView::class.java)).check { view, error ->
            if (error != null) throw error
            terminal = view as WebView
        }
        val webView = requireNotNull(terminal)
        fun snapshot(): String {
            val result = AtomicReference("")
            val completed = CountDownLatch(1)
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                webView.evaluateJavascript("JSON.stringify({background:getComputedStyle(document.querySelector('.xterm')).backgroundColor,text:document.querySelector('.xterm-rows').textContent})") {
                    result.set(JSONTokener(it).nextValue().toString())
                    completed.countDown()
                }
            }
            assertTrue("Renderer must answer while changing theme", completed.await(5, TimeUnit.SECONDS))
            return result.get()
        }
        compose.waitUntil(10_000) { snapshot().contains("retained output") }
        val light = snapshot()
        compose.runOnIdle { dark.value = true }
        compose.waitUntil(10_000) { snapshot() != light }
        assertTrue(snapshot().contains("retained output"))
        onView(isAssignableFrom(WebView::class.java)).check { view, error ->
            if (error != null) throw error
            assertSame("A theme update must not recreate the PTY renderer", webView, view)
        }
        compose.runOnIdle { dark.value = false }
        compose.waitUntil(10_000) { snapshot() == light }
        assertEquals(light, snapshot())
        assertFalse(intents.any { it is RemoteWorkspaceIntent.CloseTerminal || it is RemoteWorkspaceIntent.ReopenTerminal })
    }

    @Test fun terminalControlsFollowSharedCloseStateAndOfferScopedReopen() {
        val intents = CopyOnWriteArrayList<RemoteWorkspaceIntent>()
        val state = mutableStateOf(RuntimeTerminalUiState("pty", "", false, false))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        compose.setContent {
            OpenBitFunTheme(dark = false) { RuntimeTerminalDialog(state.value, { intents += it }, {}) }
        }
        compose.onNodeWithText(context.getString(R.string.message_stop)).performClick()
        compose.runOnIdle { assertTrue(intents.filterIsInstance<RemoteWorkspaceIntent.WriteTerminal>().single().data == "\u0003") }
        val close = context.getString(R.string.workspace_terminal_close)
        compose.onNodeWithText(close).performClick()
        compose.runOnIdle { state.value = state.value.copy(busy = true) }
        compose.onNodeWithText(close).assertIsNotEnabled()
        compose.runOnIdle { state.value = state.value.copy(busy = false, failed = true) }
        compose.onNodeWithText(close).assertIsEnabled()
        compose.onNodeWithText(context.getString(R.string.workspace_terminal_failed)).assertIsDisplayed()
        compose.runOnIdle { state.value = RuntimeTerminalUiState(null, "", false, false) }
        compose.onNodeWithText(close).assertDoesNotExist()
        compose.onNodeWithText(context.getString(R.string.workspace_open_terminal)).performClick()
        compose.runOnIdle { assertTrue(intents.any { it is RemoteWorkspaceIntent.ReopenTerminal }) }
    }
}
