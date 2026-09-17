package com.openbitfun.mobile.app.ui.miniapps

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow

import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.openbitfun.mobile.app.R
import org.json.JSONObject
import java.io.ByteArrayInputStream

/** Local, bundled tools remain available without an account or a connected host. */
@Composable
internal fun MiniAppsButton(
    sidebar: Boolean = false,
    contentColor: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.primary,
) {
    var open by rememberSaveable { mutableStateOf(false) }
    if (sidebar) {
        Row(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 8.dp).heightIn(min = 48.dp)
            .clip(RoundedCornerShape(12.dp)).clickable { open = true }
            .padding(start = 4.dp, end = 8.dp).testTag("sidebar-miniapps"),
            horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(painterResource(R.drawable.ic_symbol_square_grid_2x2), contentDescription = null, modifier = Modifier.size(24.dp))
            Text(stringResource(R.string.miniapps_title), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
        }
    } else TextButton(onClick = { open = true }, colors = ButtonDefaults.textButtonColors(contentColor = contentColor)) { Text(stringResource(R.string.miniapps_title)) }
    if (open) MiniAppsDialog { open = false }
}

@Composable
private fun MiniAppsDialog(onClose: () -> Unit) {
    val context = LocalContext.current
    val locale = if (LocalConfiguration.current.locales[0].language == "zh") "zh-CN" else "en-US"
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    val catalog = remember(retry) {
        runCatching {
            val array = org.json.JSONArray(context.assets.open("miniapps/catalog.json").bufferedReader().use { it.readText() })
            (0 until array.length()).map(array::getJSONObject)
        }
    }
    Dialog(onDismissRequest = { if (selected != null) selected = null else onClose() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        val lightBackground = MaterialTheme.colorScheme.surface.luminance() > 0.5f
        SideEffect {
            window?.let {
                WindowCompat.getInsetsController(it, it.decorView).apply {
                    isAppearanceLightStatusBars = lightBackground
                    isAppearanceLightNavigationBars = lightBackground
                }
            }
        }
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().systemBarsPadding()) {
                val selectedCopy = catalog.getOrNull()?.firstOrNull { it.getString("id") == selected }
                    ?.getJSONObject("locales")?.optJSONObject(locale)
                Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { if (selected != null) selected = null else onClose() }, modifier = Modifier.size(48.dp)) {
                        Icon(painterResource(R.drawable.ic_symbol_chevron_left), stringResource(R.string.miniapps_back))
                    }
                    Text(selectedCopy?.getString("name") ?: stringResource(R.string.miniapps_title),
                        modifier = Modifier.weight(1f), textAlign = TextAlign.Center,
                        style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.width(48.dp))
                }
                if (selected == null) {
                    BoxWithConstraints(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.TopCenter) {
                        val columns = if (maxWidth >= 600.dp) 3 else 2
                        Column(Modifier.widthIn(max = 1000.dp).fillMaxWidth().padding(horizontal = 16.dp)) {
                            Row(Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(stringResource(R.string.miniapps_all), modifier = Modifier
                                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(24.dp))
                                    .padding(horizontal = 16.dp, vertical = 10.dp), style = MaterialTheme.typography.titleSmall)
                                Spacer(Modifier.weight(1f))
                                Text(stringResource(R.string.miniapps_offline), style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            if (catalog.isFailure) {
                                Text(stringResource(R.string.miniapps_load_failed))
                                TextButton(onClick = { retry++ }) { Text(stringResource(R.string.account_devices_retry)) }
                            } else LazyVerticalGrid(columns = GridCells.Fixed(columns),
                                horizontalArrangement = Arrangement.spacedBy(14.dp), verticalArrangement = Arrangement.spacedBy(20.dp),
                                contentPadding = PaddingValues(bottom = 24.dp), modifier = Modifier.testTag("miniapps-gallery")) {
                                items(catalog.getOrDefault(emptyList()), key = { it.getString("id") }) { app ->
                                    val id = app.getString("id")
                                    val copy = app.getJSONObject("locales").optJSONObject(locale)
                                        ?: app.getJSONObject("locales").getJSONObject("en-US")
                                    Column(Modifier.fillMaxWidth().clickable { selected = id }.testTag("miniapp:$id"),
                                        verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                        val preview = when (id) {
                                            "builtin-gomoku" -> R.drawable.miniapp_gomoku_preview
                                            "builtin-regex-playground" -> R.drawable.miniapp_regex_preview
                                            else -> R.drawable.miniapp_divination_preview
                                        }
                                        Image(painterResource(preview), contentDescription = copy.getString("description"),
                                            contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().aspectRatio(1f)
                                                .clip(RoundedCornerShape(24.dp))
                                                .border(0.5.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(24.dp)))
                                        Text(copy.getString("name"), style = MaterialTheme.typography.titleSmall,
                                            maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 4.dp))
                                    }
                                }
                            }
                        }
                    }
                } else {
                    key(selected, locale) { MiniAppWebView(selected!!, locale, Modifier.weight(1f)) }
                }
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun MiniAppWebView(appId: String, locale: String, modifier: Modifier) {
    AndroidView(modifier = modifier.fillMaxWidth(), factory = { context ->
        WebView(context).apply {
            // A wrap-content WebView gives a percentage-height iframe a zero-height viewport.
            layoutParams = android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
            )
            settings.javaScriptEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.setSupportMultipleWindows(false)
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    return request.url.scheme !in setOf("blob", "about")
                }
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    // Blob frames contain only bundled bytes. No app can request a network resource.
                    if (request.url.scheme == "blob" || request.url.scheme == "data") return null
                    return WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
                }
            }
            addJavascriptInterface(BuiltinMiniAppBridge(context, appId) { reply ->
                post { evaluateJavascript("window.__miniappReply($reply)", null) }
            }, "miniappNative")
            val html = context.assets.open("miniapps/$appId.$locale.html").bufferedReader().use { it.readText() }
            loadDataWithBaseURL("https://miniapp.local/", html, "text/html", "UTF-8", null)
        }
    }, onRelease = { view ->
        view.removeJavascriptInterface("miniappNative")
        view.stopLoading()
        view.destroy()
    })
}

/** Per-app key allowlist; unparseable persisted JSON is retained and reported, never reset. */
internal class BuiltinMiniAppBridge(private val context: Context, private val appId: String, private val reply: (String) -> Unit) {
    @JavascriptInterface
    @Synchronized
    fun request(raw: String) {
        val request = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val id = request.optString("id")
        if (id.isEmpty()) return
        val response = JSONObject().put("id", id)
        try {
            val params = request.getJSONObject("params")
            val method = request.getString("method")
            val key = params.optString("key")
            val allowedKey = when (appId) {
                "builtin-gomoku" -> "stats"
                "builtin-regex-playground" -> "regex-state"
                "builtin-daily-divination" -> "lastReading"
                else -> error("Unsupported MiniApp")
            }
            val result = when (method) {
                "clipboard.writeText" -> {
                    val text = params.getString("text")
                    android.os.Handler(context.mainLooper).post {
                        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("", text))
                    }
                    JSONObject.NULL
                }
                "storage.get", "storage.set" -> {
                    require(key == allowedKey) { "Unsupported storage key" }
                    val store = context.getSharedPreferences("miniapps-$appId", Context.MODE_PRIVATE)
                    if (method == "storage.get") {
                        store.getString(key, null)?.let { JSONObject(it).get("value") } ?: JSONObject.NULL
                    } else {
                        val encoded = JSONObject().put("value", params.opt("value") ?: JSONObject.NULL).toString()
                        // Store an envelope so scalar/null values retain valid JSON too.
                        check(store.edit().putString(key, encoded).commit()) { "Unable to save MiniApp data" }
                        JSONObject.NULL
                    }
                }
                else -> error("Unsupported capability")
            }
            response.put("result", result)
        } catch (error: Exception) {
            response.put("error", JSONObject().put("message", error.message ?: "MiniApp operation failed"))
        }
        reply(response.toString())
    }
}
