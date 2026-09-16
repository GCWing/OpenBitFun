package com.openbitfun.mobile.app.ui.remote

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.clickable
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.unit.sp
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.openbitfun.mobile.app.ui.chat.statusText
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.core.feature.workspace.*

@Composable
internal fun RuntimeFullScreen(title: String, onBack: () -> Unit, actions: @Composable RowScope.() -> Unit = {}, content: @Composable ColumnScope.() -> Unit) {
    Dialog(onDismissRequest = onBack, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), onClick = onBack) { Text(stringResource(R.string.common_back)) }
                    Text(title, Modifier.weight(1f).padding(vertical = 12.dp), style = MaterialTheme.typography.titleMedium, maxLines = 1)
                    actions()
                }
                HorizontalDivider()
                content()
            }
        }
    }
}

@Composable
internal fun RuntimeFileEditorDialog(files: RuntimeFilesUiState, onIntent: (RemoteWorkspaceIntent) -> Unit) {
    val file = files.file ?: return
    var content by rememberSaveable(file) { mutableStateOf(files.content) }
    var savedContent by rememberSaveable(file) { mutableStateOf(files.content) }
    var discard by rememberSaveable(file) { mutableStateOf(false) }
    var fileAction by remember { mutableStateOf("") }
    var renamePath by remember(file) { mutableStateOf(file) }
    var menu by remember { mutableStateOf(false) }
    LaunchedEffect(files.content) {
        // Recreation restores the draft; only a new host revision replaces it.
        if (files.content != savedContent) {
            content = files.content
            savedContent = files.content
        }
    }
    val dirty = content != files.content
    val back = { if (!files.busy) { if (dirty) discard = true else onIntent(RemoteWorkspaceIntent.CloseFileEditor) } }
    RuntimeFullScreen(file.substringAfterLast('/'), back, actions = {
        Box {
            TextButton(colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), enabled = !files.busy && !dirty, onClick = { menu = true }) { Text("⋯") }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text(stringResource(R.string.workspace_rename_file)) }, onClick = { menu = false; fileAction = "rename" })
                DropdownMenuItem(text = { Text(stringResource(R.string.workspace_delete_file)) }, onClick = { menu = false; fileAction = "delete" })
            }
        }
        TextButton(colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), enabled = !files.busy && dirty, onClick = { onIntent(RemoteWorkspaceIntent.SaveFile(content)) }) { Text(stringResource(R.string.workspace_save_file)) }
    }) {
        Text(file, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall)
        if (files.failed) Text(if (files.saveConflict) stringResource(R.string.workspace_file_conflict) else files.errorDetail ?: stringResource(R.string.workspace_files_failed), color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
        BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
            val viewportWidth = maxWidth - 60.dp
            val codeStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace, fontSize = 14.sp, lineHeight = 21.sp, platformStyle = PlatformTextStyle(includeFontPadding = false))
            Row(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                Text((1..(content.count { it == '\n' } + 1)).joinToString("\n"), Modifier.width(60.dp).padding(12.dp), style = codeStyle, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Box(Modifier.horizontalScroll(rememberScrollState())) {
                    BasicTextField(value = content, onValueChange = { content = it }, enabled = !files.busy,
                        textStyle = codeStyle.copy(color = MaterialTheme.colorScheme.onSurface),
                        modifier = Modifier.width(IntrinsicSize.Max).widthIn(min = viewportWidth).padding(12.dp))
                }
            }
        }
    }
    if (fileAction.isNotEmpty()) AlertDialog(onDismissRequest = { fileAction = "" },
        title = { Text(stringResource(if (fileAction == "rename") R.string.workspace_rename_file else R.string.workspace_delete_file)) },
        text = { if (fileAction == "rename") OutlinedTextField(value = renamePath, onValueChange = { renamePath = it }, singleLine = true) else Text(file) },
        confirmButton = { TextButton(colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), enabled = fileAction != "rename" || renamePath.isNotBlank(), onClick = {
            if (fileAction == "rename") onIntent(RemoteWorkspaceIntent.RenameFile(renamePath)) else onIntent(RemoteWorkspaceIntent.DeleteFile)
            fileAction = ""
        }) { Text(stringResource(if (fileAction == "rename") R.string.workspace_rename_file else R.string.workspace_delete_file)) } },
        dismissButton = { TextButton(colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), onClick = { fileAction = "" }) { Text(stringResource(R.string.common_cancel)) } })
    if (discard) AlertDialog(onDismissRequest = { discard = false }, title = { Text(stringResource(R.string.workspace_discard_changes)) },
        confirmButton = { TextButton(colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), onClick = { discard = false; onIntent(RemoteWorkspaceIntent.CloseFileEditor) }) { Text(stringResource(R.string.workspace_discard)) } },
        dismissButton = { TextButton(colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), onClick = { discard = false }) { Text(stringResource(R.string.common_cancel)) } })
}

@Composable
internal fun RuntimeDirectoryPickerDialog(state: RuntimeFilesUiState, connectionId: String?, onIntent: (RemoteWorkspaceIntent) -> Unit, onChoose: (String) -> Unit, onBack: () -> Unit) {
    RuntimeFullScreen(stringResource(R.string.workspace_choose_folder), onBack, actions = {
        TextButton(colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), enabled = !state.busy && !state.failed && state.directory.isNotBlank(), onClick = { onChoose(state.directory) }) { Text(stringResource(R.string.workspace_choose)) }
    }) {
        Text(state.directory, Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall)
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (state.failed) Text(state.errorDetail ?: stringResource(R.string.workspace_files_failed), color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            TextButton(colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), enabled = !state.busy && state.directory != "/", onClick = { onIntent(RemoteWorkspaceIntent.BrowseWorkspaceDirectories(state.directory.trimEnd('/').substringBeforeLast('/', "").ifEmpty { "/" }, connectionId, false)) }) { Text(stringResource(R.string.workspace_parent_folder)) }
            state.entries.filter { it.directory }.forEach { entry ->
                TextButton(colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), onClick = { onIntent(RemoteWorkspaceIntent.BrowseWorkspaceDirectories(entry.path, connectionId, false)) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text(entry.name) }
            }
            if (state.hasMore) TextButton(colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), onClick = { onIntent(RemoteWorkspaceIntent.BrowseWorkspaceDirectories(state.directory, connectionId, true)) }, enabled = !state.busy) { Text(stringResource(R.string.workspace_more_files)) }
        }
    }
}

@Composable
internal fun RuntimeTerminalDialog(state: RuntimeTerminalUiState, onIntent: (RemoteWorkspaceIntent) -> Unit, onBack: () -> Unit) {
    RuntimeFullScreen(stringResource(R.string.workspace_terminal), onBack, actions = {
        if (state.sessionId != null) {
            TextButton(colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), enabled = !state.busy, onClick = { onIntent(RemoteWorkspaceIntent.WriteTerminal("\u0003")) }) { Text(stringResource(R.string.message_stop)) }
            TextButton(colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), enabled = !state.busy, onClick = { onIntent(RemoteWorkspaceIntent.CloseTerminal) }) { Text(stringResource(R.string.workspace_terminal_close)) }
        }
    }) {
        if (state.failed) Text(state.errorDetail ?: stringResource(R.string.workspace_terminal_failed), color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(12.dp))
        if (state.busy) CircularProgressIndicator(Modifier.padding(12.dp))
        if (state.sessionId != null) {
            RuntimeTerminalView(state, { onIntent(RemoteWorkspaceIntent.WriteTerminal(it)) }, { cols, rows -> onIntent(RemoteWorkspaceIntent.ResizeTerminal(cols, rows)) }, Modifier.fillMaxWidth().weight(1f))
        } else if (!state.busy) {
            Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = androidx.compose.ui.Alignment.Center) {
                OutlinedButton(
                    onClick = { onIntent(RemoteWorkspaceIntent.ReopenTerminal) },
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
                ) { Text(stringResource(R.string.workspace_open_terminal)) }
            }
        }
    }
}

@Composable
internal fun RuntimeFileSortMenu(sort: RuntimeFileSort, onIntent: (RemoteWorkspaceIntent) -> Unit, enabled: Boolean = true) {
    var open by remember { mutableStateOf(false) }
    val labels = listOf(R.string.workspace_sort_name_asc, R.string.workspace_sort_name_desc, R.string.workspace_sort_modified_desc, R.string.workspace_sort_modified_asc)
    Box {
        TextButton(enabled = enabled, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface), onClick = { open = true }) { Text(stringResource(labels[sort.ordinal]), maxLines = 1, overflow = TextOverflow.Ellipsis) }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            RuntimeFileSort.entries.forEachIndexed { index, value -> DropdownMenuItem(text = { Text(stringResource(labels[index])) }, onClick = { open = false; onIntent(RemoteWorkspaceIntent.SortFiles(value)) }) }
        }
    }
}

@Composable
internal fun RuntimeFilesDialog(state: RemoteWorkspaceUiState.Ready, onIntent: (RemoteWorkspaceIntent) -> Unit, onBack: () -> Unit) {
    RuntimeFullScreen(stringResource(R.string.workspace_browse_files), onBack) { RuntimeFilesContent(state, onIntent) }
}

private enum class FileListAction { FILE, DIRECTORY, RENAME, DELETE, UPLOAD }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ColumnScope.RuntimeFilesContent(state: RemoteWorkspaceUiState.Ready, onIntent: (RemoteWorkspaceIntent) -> Unit) {
    // A new location/order starts at the top; pagination and refresh retain position.
    val listState = remember(state.files.directory, state.files.sort) { LazyListState() }
    var attached by remember { mutableStateOf(true) }
    DisposableEffect(Unit) { onDispose { attached = false } }
    val uploadContext = androidx.compose.ui.platform.LocalContext.current
    var uploadFailed by rememberSaveable { mutableStateOf(false) }
    var action by remember { mutableStateOf<FileListAction?>(null) }
    var target by remember { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var submitted by remember { mutableStateOf(false) }
    var submittedRevision by remember { mutableStateOf(0L) }
    var toolbarMenu by remember { mutableStateOf(false) }
    val neutral = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)
    fun begin(value: FileListAction, path: String = "", initial: String = "") {
        action = value; target = path; name = initial; submitted = false; uploadFailed = false
    }
    LaunchedEffect(state.files.completedOperation, submitted) {
        if (submitted && state.files.completedOperation > submittedRevision) {
            if (!state.files.failed) action = null
            submitted = false
        }
    }
    val uploadPicker = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null && attached) {
            try {
                val source = com.openbitfun.mobile.app.platform.AndroidRuntimeUploadSource(uploadContext.contentResolver, uri)
                submittedRevision = state.files.completedOperation; submitted = true
                onIntent(RemoteWorkspaceIntent.UploadFileEntry(name, source)); uploadFailed = false
            } catch (_: Exception) { submitted = false; uploadFailed = true }
        }
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        Text(state.files.directory, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(vertical = 12.dp), maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(enabled = !state.files.busy && state.files.directory != "/", onClick = {
                onIntent(RemoteWorkspaceIntent.BrowseFiles(state.files.directory.trimEnd('/').substringBeforeLast('/', "").ifEmpty { "/" }, false))
            }) { Icon(painterResource(R.drawable.ic_symbol_arrow_up), stringResource(R.string.workspace_parent_folder), Modifier.size(20.dp)) }
            IconButton(enabled = !state.files.busy, onClick = { onIntent(RemoteWorkspaceIntent.BrowseFiles(state.files.directory, false)) }) {
                Icon(painterResource(R.drawable.ic_symbol_arrow_clockwise), stringResource(R.string.common_refresh), Modifier.size(20.dp))
            }
            Box(Modifier.weight(1f)) { RuntimeFileSortMenu(state.files.sort, onIntent, enabled = !state.files.busy) }
            Box {
                IconButton(enabled = !state.files.busy && state.files.directory.isNotEmpty(), onClick = { toolbarMenu = true }) {
                    Icon(painterResource(R.drawable.ic_symbol_plus), stringResource(R.string.workspace_create_file), Modifier.size(20.dp))
                }
                DropdownMenu(toolbarMenu, { toolbarMenu = false }) {
                    listOf(FileListAction.FILE to R.string.workspace_create_file, FileListAction.DIRECTORY to R.string.workspace_create_directory,
                        FileListAction.UPLOAD to R.string.workspace_upload_file).forEach { (value, label) ->
                        DropdownMenuItem(text = { Text(stringResource(label)) }, onClick = { toolbarMenu = false; begin(value) })
                    }
                }
            }
        }
        if (state.files.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (state.files.failed && action == null) Text(state.files.errorDetail ?: stringResource(R.string.workspace_files_failed), color = MaterialTheme.colorScheme.error)
    }
    LazyColumn(Modifier.fillMaxWidth().weight(1f), state = listState, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)) {
        items(state.files.entries, key = { it.path }) { entry ->
            var menu by remember { mutableStateOf(false) }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f).heightIn(min = 52.dp).clickable(enabled = !state.files.busy) {
                    if (entry.directory) onIntent(RemoteWorkspaceIntent.BrowseFiles(entry.path, false)) else onIntent(RemoteWorkspaceIntent.ReadFile(entry.path))
                }, verticalAlignment = Alignment.CenterVertically) {
                    Icon(painterResource(if (entry.directory) R.drawable.ic_symbol_folder else R.drawable.ic_symbol_doc), null,
                        Modifier.padding(end = 12.dp).size(22.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(entry.name, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                Box {
                    IconButton(enabled = !state.files.busy, onClick = { menu = true }) {
                        Icon(painterResource(R.drawable.ic_symbol_ellipsis), stringResource(R.string.workspace_file_actions), Modifier.size(20.dp))
                    }
                    DropdownMenu(menu, { menu = false }) {
                        if (!entry.directory) DropdownMenuItem(text = { Text(stringResource(R.string.file_download)) },
                            enabled = state.download !is RemoteFileDownloadUiState.Loading,
                            onClick = { menu = false; onIntent(RemoteWorkspaceIntent.DownloadFile(entry.path, entry.name, "")) })
                        DropdownMenuItem(text = { Text(stringResource(R.string.session_rename)) }, onClick = { menu = false; begin(FileListAction.RENAME, entry.path, entry.name) })
                        DropdownMenuItem(text = { Text(stringResource(R.string.session_delete), color = MaterialTheme.colorScheme.error) }, onClick = { menu = false; begin(FileListAction.DELETE, entry.path, entry.name) })
                    }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        }
        if (state.files.hasMore) item {
            TextButton(colors = neutral, onClick = { onIntent(RemoteWorkspaceIntent.BrowseFiles(state.files.directory, true)) }, enabled = !state.files.busy) {
                Text(stringResource(R.string.workspace_more_files))
            }
        }
    }
    RuntimeDownloadStatus(state.download, onIntent)
    action?.let { current ->
        val label = when (current) {
            FileListAction.FILE -> R.string.workspace_create_file
            FileListAction.DIRECTORY -> R.string.workspace_create_directory
            FileListAction.RENAME -> R.string.session_rename
            FileListAction.DELETE -> R.string.session_delete
            FileListAction.UPLOAD -> R.string.workspace_upload_file
        }
        ModalBottomSheet(onDismissRequest = { if (!state.files.busy) action = null },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { !state.files.busy }),
            containerColor = MaterialTheme.colorScheme.surface) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(colors = neutral, enabled = !state.files.busy, onClick = { action = null }) { Text(stringResource(R.string.common_cancel)) }
                    Text(stringResource(label), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    Button(
                        colors = ButtonDefaults.buttonColors(containerColor = if (current == FileListAction.DELETE) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                            contentColor = if (current == FileListAction.DELETE) MaterialTheme.colorScheme.onError else MaterialTheme.colorScheme.surface),
                        enabled = !state.files.busy && !submitted && (current == FileListAction.DELETE || name.isNotBlank()), onClick = {
                            if (current == FileListAction.UPLOAD) uploadPicker.launch(arrayOf("*/*"))
                            else {
                                submittedRevision = state.files.completedOperation; submitted = true
                                onIntent(when (current) {
                                    FileListAction.FILE -> RemoteWorkspaceIntent.CreateFileEntry(name, false)
                                    FileListAction.DIRECTORY -> RemoteWorkspaceIntent.CreateFileEntry(name, true)
                                    FileListAction.RENAME -> RemoteWorkspaceIntent.RenameFileEntry(target, name)
                                    else -> RemoteWorkspaceIntent.DeleteFileEntry(target)
                                })
                            }
                        }) { Text(stringResource(label)) }
                }
                if (current == FileListAction.DELETE) Text(target, color = MaterialTheme.colorScheme.onSurfaceVariant)
                else OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text(stringResource(R.string.workspace_file_name)) },
                    modifier = Modifier.fillMaxWidth(), enabled = !state.files.busy, singleLine = true)
                if (state.files.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (state.files.failed || uploadFailed) Text((if (uploadFailed) null else state.files.errorDetail) ?: stringResource(R.string.workspace_files_failed), color = MaterialTheme.colorScheme.error)
            }
        }
    }

    RuntimeFileEditorDialog(state.files, onIntent)
}

/** Projects transfer state; KMP retains the immutable host/path used by retry. */
@Composable
internal fun RuntimeDownloadStatus(download: RemoteFileDownloadUiState, onIntent: (RemoteWorkspaceIntent) -> Unit) {
    val target = when (download) {
        RemoteFileDownloadUiState.None -> return
        is RemoteFileDownloadUiState.Loading -> download.target
        is RemoteFileDownloadUiState.AwaitingSave -> download.target
        is RemoteFileDownloadUiState.Saved -> download.target
        is RemoteFileDownloadUiState.Failed -> download.target
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(target.displayName.ifBlank { target.path.substringAfterLast('/') }, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
            Text(download.statusText(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (download is RemoteFileDownloadUiState.Loading || download is RemoteFileDownloadUiState.AwaitingSave) {
            CircularProgressIndicator(Modifier.size(20.dp), color = MaterialTheme.colorScheme.onSurface, strokeWidth = 2.dp)
        }
        if (download is RemoteFileDownloadUiState.Failed && download.retryable) {
            TextButton(onClick = { onIntent(RemoteWorkspaceIntent.RetryDownload) }, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) {
                Text(stringResource(R.string.chat_retry))
            }
        }
    }
}
