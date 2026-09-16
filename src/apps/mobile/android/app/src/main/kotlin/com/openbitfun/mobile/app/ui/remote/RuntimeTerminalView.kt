package com.openbitfun.mobile.app.ui.remote

import android.annotation.SuppressLint
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.openbitfun.mobile.core.feature.workspace.RuntimeTerminalUiState
import org.json.JSONObject

/** Trusted bundled renderer only; all terminal execution stays in the selected runtime store. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
internal fun RuntimeTerminalView(state: RuntimeTerminalUiState, onInput: (String) -> Unit, onResize: (Int, Int) -> Unit, modifier: Modifier) {
    val background = MaterialTheme.colorScheme.background.toArgb()
    val foreground = MaterialTheme.colorScheme.onBackground.toArgb()
    val latestInput by rememberUpdatedState(onInput)
    val latestResize by rememberUpdatedState(onResize)
    var bridge by remember { mutableStateOf<TerminalBridge?>(null) }
    AndroidView(modifier = modifier, factory = { context ->
        WebView(context).apply {
            if (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)
            // Without explicit match-parent params WebView can keep a zero CSS
            // viewport even after Compose measures the native view to full height.
            layoutParams = android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
            )
            settings.javaScriptEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = false
            isFocusableInTouchMode = true
            // DOM focus alone does not move focus out of the Compose dialog.
            // Give WebView native focus before xterm focuses its textarea so
            // Android establishes the input connection and routes keys here.
            setOnTouchListener { view, event ->
                if (event.actionMasked == android.view.MotionEvent.ACTION_DOWN) view.requestFocus()
                false
            }
            val adapter = TerminalBridge(this, { latestInput(it) }, { cols, rows -> latestResize(cols, rows) })
            bridge = adapter
            addJavascriptInterface(adapter, "OpenBitFunTerminalHost")
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = request?.url?.toString() != "file:///android_asset/index.html"
                override fun onPageFinished(view: WebView?, url: String?) { evaluateJavascript("window.OpenBitFunTerminal.connect()", null) }
            }
            loadUrl("file:///android_asset/index.html")
        }
    }, update = { bridge?.updateTheme(background, foreground); bridge?.update(state) })
    DisposableEffect(Unit) { onDispose { bridge?.dispose() } }
}

private class TerminalBridge(private val view: WebView, private val input: (String) -> Unit, private val resize: (Int, Int) -> Unit) {
    private var theme: String? = null
    fun updateTheme(background: Int, foreground: Int) {
        fun css(color: Int) = "#" + (color and 0xffffff).toString(16).padStart(6, '0')
        val next = JSONObject().put("background", css(background)).put("foreground", css(foreground)).put("cursor", css(foreground)).toString()
        view.setBackgroundColor(background)
        if (next == theme) return
        theme = next
        renderTheme()
    }
    private fun renderTheme() {
        if (ready && !disposed) theme?.let { view.evaluateJavascript("window.OpenBitFunTerminal.setTheme($it)", null) }
    }
    private var state: RuntimeTerminalUiState? = null
    private var ready = false
    private var disposed = false
    private var epoch: String? = null
    private var revision = -1L
    fun update(value: RuntimeTerminalUiState) { state = value; render(false) }
    private fun render(force: Boolean) {
        val value = state ?: return
        val id = value.sessionId ?: return
        if (!ready || disposed || (!force && id == epoch && revision == value.revision)) return
        val reset = force || id != epoch || value.reset || value.revision != revision + 1
        val frame = JSONObject().put("epoch", id).put("revision", value.revision).put("reset", reset).put("data", if (reset) value.output else value.chunk)
        view.evaluateJavascript("window.OpenBitFunTerminal.accept($frame)", null)
        epoch = id; revision = value.revision
    }
    @JavascriptInterface fun postMessage(message: String) {
        view.post {
            if (disposed) return@post
            val event = runCatching { JSONObject(message) }.getOrNull() ?: return@post
            when (event.optString("type")) {
                "ready" -> { ready = true; renderTheme(); render(true) }
                "resync" -> render(true)
                "input" -> input(event.optString("data"))
                "resize" -> { val cols = event.optInt("cols"); val rows = event.optInt("rows"); if (cols > 0 && rows > 0) resize(cols, rows) }
            }
        }
    }
    fun dispose() { disposed = true; view.removeJavascriptInterface("OpenBitFunTerminalHost"); view.destroy() }
}
