package com.openbitfun.mobile.app.ui.remote

import android.app.Activity
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import com.openbitfun.mobile.core.feature.workspace.RemoteFileDownloadUiState
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceIntent
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceUiState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Hands bytes fetched by KMP to Android's user-selected document destination. */
@Composable
internal fun RemoteDownloadSaver(
    state: RemoteWorkspaceUiState,
    onIntent: (RemoteWorkspaceIntent) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val current by rememberUpdatedState((state as? RemoteWorkspaceUiState.Ready)?.download as? RemoteFileDownloadUiState.AwaitingSave)
    var pending by remember { mutableStateOf<RemoteFileDownloadUiState.AwaitingSave?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val download = pending ?: return@rememberLauncherForActivityResult
        pending = null
        if (current?.localReference != download.localReference) return@rememberLauncherForActivityResult
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            onIntent(RemoteWorkspaceIntent.DownloadSaveFailed(download.target.path))
            return@rememberLauncherForActivityResult
        }
        scope.launch {
            val saved = runCatching {
                withContext(Dispatchers.IO) {
                    context.contentResolver.openOutputStream(uri, "wt")?.use { output ->
                        java.io.File(download.localReference).inputStream().use { input ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                check(current?.localReference == download.localReference) { "Download target changed" }
                                val count = input.read(buffer); if (count < 0) break
                                output.write(buffer, 0, count)
                            }
                        }
                    } ?: error("document destination is unavailable")
                }
            }.isSuccess
            onIntent(
                if (saved) RemoteWorkspaceIntent.DownloadSaved(download.target.path)
                else RemoteWorkspaceIntent.DownloadSaveFailed(download.target.path),
            )
        }
    }
    val awaiting = (state as? RemoteWorkspaceUiState.Ready)?.download
        as? RemoteFileDownloadUiState.AwaitingSave
    LaunchedEffect(awaiting?.localReference) {
        if (awaiting == null || pending != null) return@LaunchedEffect
        pending = awaiting
        launcher.launch(
            Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                // DocumentsUI appends its MIME extension when it disagrees with
                // the supplied filename (for example source.ts -> source.ts.txt).
                val extension = awaiting.name.substringAfterLast('.', "").lowercase()
                type = documentExportMimeType(
                    awaiting.mimeType,
                    android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension),
                )
                putExtra(Intent.EXTRA_TITLE, awaiting.name)
            },
        )
    }
}
