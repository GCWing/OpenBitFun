package com.openbitfun.mobile.app.ui.remote

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.theme.CodeSyntaxColors
import com.openbitfun.mobile.app.ui.theme.openBitFunColors
import com.openbitfun.mobile.core.feature.workspace.CodeSyntaxHighlighter
import com.openbitfun.mobile.core.feature.workspace.CodeSyntaxTokenKind
import com.openbitfun.mobile.core.feature.workspace.FilePreviewFailureKind
import com.openbitfun.mobile.core.feature.workspace.FilePreviewFormat
import com.openbitfun.mobile.app.ui.chat.MarkdownContent
import com.openbitfun.mobile.app.ui.chat.forReference
import com.openbitfun.mobile.app.ui.chat.statusText
import com.openbitfun.mobile.core.feature.workspace.RemoteFileDownloadUiState
import com.openbitfun.mobile.core.feature.workspace.RemoteFilePreviewUiState
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceIntent
import com.openbitfun.mobile.core.feature.workspace.RemoteWorkspaceUiState

internal const val FILE_PREVIEW_TEST_TAG: String = "file-preview"
internal const val FILE_PREVIEW_HEADER_TEST_TAG: String = "file-preview-header"
internal const val FILE_PREVIEW_REFRESH_TEST_TAG: String = "file-preview-refresh"
internal const val FILE_PREVIEW_DOWNLOAD_TEST_TAG: String = "file-preview-download"
internal const val FILE_PREVIEW_TRUNCATION_TEST_TAG: String = "file-preview-truncation"

/**
 * A file the agent referenced, ported from `pages/components/FilePreviewSurface.ets`.
 *
 * This is a pane, not a card: HarmonyOS gives the preview its own surface with a
 * 68dp header carrying the file's name, its type and size, and the three things
 * that can be done to it. The card this used to be had none of that, so the same
 * file read as a different feature on the two platforms.
 *
 * The read is a peek, not an editor: text arrives already capped by the shared
 * `FilePreviewPolicy`, so the truncation banner is part of the content rather
 * than an error, and it says how much did arrive. Every failure names what went
 * wrong and offers Retry only when retrying could work — a file outside the
 * workspace will not appear on a second try, and a Retry button there is a lie.
 *
 * @param remoteAvailable whether the link could still answer. Refresh and
 * download are dimmed rather than hidden when it cannot, because the file on
 * screen is still readable and hiding the actions would suggest it is not.
 */
@Composable
internal fun FilePreviewSurface(
    preview: RemoteFilePreviewUiState,
    download: RemoteFileDownloadUiState,
    remoteAvailable: Boolean,
    onIntent: (RemoteWorkspaceIntent) -> Unit,
    modifier: Modifier,
) {
    if (preview is RemoteFilePreviewUiState.None) return
    val remotePath = preview.remotePath()

    // Opening a different file starts it fitted again: 1:1 is a choice about
    // the image being looked at, not a mode the pane stays in.
    var actualSize by remember(remotePath) { mutableStateOf(false) }

    Column(
        modifier = modifier
            .background(MaterialTheme.colorScheme.background)
            .testTag(FILE_PREVIEW_TEST_TAG),
    ) {
        FilePreviewHeader(
            preview = preview,
            remoteAvailable = remoteAvailable,
            canRefresh = remoteAvailable && preview.canBeAskedAgain(),
            canDownload = remoteAvailable && !download.isFetching(preview.reference(), remotePath),
            actualSize = actualSize,
            onToggleActualSize = { actualSize = !actualSize },
            onIntent = onIntent,
        )
        DownloadStatusBand(download.forReference(preview.reference(), remotePath))
        when (preview) {
            RemoteFilePreviewUiState.None -> Unit

            is RemoteFilePreviewUiState.Loading -> if (remoteAvailable) {
                CenteredState(spacing = 12, gutter = 0) {
                    CircularProgressIndicator(
                        Modifier.size(28.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        stringResource(R.string.file_preview_loading),
                        fontSize = 14.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                // A spinner over a dropped link is a promise nothing will keep.
                CenteredState(spacing = 10, gutter = 32) {
                    Text(
                        stringResource(R.string.file_preview_failed),
                        fontSize = 17.sp,
                        fontWeight = FontWeight.Medium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        stringResource(R.string.file_preview_offline),
                        fontSize = 13.sp,
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            is RemoteFilePreviewUiState.Text -> {
                if (preview.truncated) {
                    // The banner sits above the text, not under it: it changes
                    // how the rows below are read, so it has to be read first.
                    Text(
                        stringResource(
                            R.string.file_preview_truncated,
                            FilePreviewFormat.bytes(preview.loadedBytes),
                        ),
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(MaterialTheme.colorScheme.surfaceVariant)
                            .bottomHairline(MaterialTheme.colorScheme.outlineVariant)
                            .padding(start = 14.dp, end = 14.dp, top = 7.dp, bottom = 7.dp)
                            .testTag(FILE_PREVIEW_TRUNCATION_TEST_TAG),
                    )
                }
                if (preview.markdown) {
                    // Markdown is the one text file the reader wants rendered
                    // rather than read as source, so it reflows and the line
                    // gutter is meaningless. HarmonyOS pads it 20/16/20/28.
                    MarkdownContent(
                        text = preview.content,
                        onOpenLink = { reference, label ->
                            onIntent(RemoteWorkspaceIntent.OpenFile(reference, label, preview.sessionId()))
                        },
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxWidth()
                            .verticalScroll(rememberScrollState())
                            .padding(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 28.dp),
                    )
                } else {
                    val code = openBitFunColors.code
                    // Lexing is linear over the whole file, so it is not something
                    // to redo on every recomposition — scrolling is exactly when
                    // that would happen.
                    val source = remember(preview, code) {
                        highlightedSource(
                            content = preview.content,
                            fileName = preview.name.ifEmpty { preview.target.path },
                            lineStart = preview.target.lineStart,
                            lineEnd = preview.target.lineEnd,
                            colors = code,
                        )
                    }
                    // Source lines are not reflowed: a wrapped line number or a
                    // broken indent makes a diff unreadable, so it scrolls.
                    // The pane sits on the soft surface the whole way down, as
                    // HarmonyOS' TextPreview does — source is read against a
                    // tint, rendered Markdown against the page.
                    SelectionContainer {
                        Text(
                            source,
                            fontSize = 12.sp,
                            lineHeight = 19.sp,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurface,
                            softWrap = false,
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth()
                                .background(MaterialTheme.colorScheme.surfaceVariant)
                                .verticalScroll(rememberScrollState())
                                .horizontalScroll(rememberScrollState())
                                .padding(start = 14.dp, end = 20.dp, top = 14.dp, bottom = 24.dp),
                        )
                    }
                }
            }

            is RemoteFilePreviewUiState.Image -> {
                val decoded by androidx.compose.runtime.produceState<Pair<Boolean, android.graphics.Bitmap?>>(
                    initialValue = false to null, key1 = preview.bytes,
                ) {
                    value = false to null
                    value = true to kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
                        BitmapFactory.decodeByteArray(preview.bytes, 0, preview.bytes.size)
                    }
                }
                val bitmap = decoded.second
                if (!decoded.first) {
                    CenteredState(spacing = 12, gutter = 32) { CircularProgressIndicator() }
                } else if (bitmap != null) {
                    Image(
                        bitmap = bitmap.asImageBitmap(),
                        contentDescription = preview.name,
                        contentScale = if (actualSize) ContentScale.None else ContentScale.Fit,
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxWidth()
                            .background(MaterialTheme.colorScheme.surfaceVariant)
                            .padding(18.dp)
                            .then(
                                if (actualSize) {
                                    Modifier
                                        .verticalScroll(rememberScrollState())
                                        .horizontalScroll(rememberScrollState())
                                } else {
                                    Modifier
                                }
                            ),
                    )
                } else {
                    // The bytes arrived but this device cannot decode them;
                    // that is a decode failure, not a transfer failure.
                    CenteredState(spacing = 12, gutter = 32) {
                        Text(
                            stringResource(R.string.file_preview_image_decode_failed),
                            fontSize = 13.sp,
                            textAlign = TextAlign.Center,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            }

            is RemoteFilePreviewUiState.Unsupported -> CenteredState(spacing = 10, gutter = 32) {
                Icon(
                    painterResource(R.drawable.ic_symbol_doc),
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(38.dp),
                )
                Text(
                    stringResource(R.string.file_preview_unsupported),
                    fontSize = 17.sp,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    metadataDetail(preview.mimeType, preview.sizeBytes, remotePath),
                    fontSize = 13.sp,
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                InkPill(
                    label = stringResource(R.string.file_download),
                    enabled = remoteAvailable,
                    onClick = { onIntent(preview.downloadIntent()) },
                )
            }

            is RemoteFilePreviewUiState.Failed -> CenteredState(spacing = 12, gutter = 32) {
                Text(
                    stringResource(R.string.file_preview_failed),
                    fontSize = 17.sp,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    stringResource(preview.kind.messageRes()),
                    fontSize = 13.sp,
                    lineHeight = 19.sp,
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 4,
                    overflow = TextOverflow.Ellipsis,
                )
                if (preview.retryable) {
                    InkPill(
                        label = stringResource(R.string.chat_retry),
                        enabled = remoteAvailable,
                        onClick = { onIntent(preview.openIntent()) },
                    )
                }
            }
        }
    }
}

/**
 * The name, what the file is, and the three things that can be done to it.
 *
 * Fixed at 68dp with its own hairline: the pane below it scrolls, and a header
 * that grew with a long file name would move the actions out from under the
 * thumb that was already reaching for them.
 */
@Composable
private fun FilePreviewHeader(
    preview: RemoteFilePreviewUiState,
    remoteAvailable: Boolean,
    canRefresh: Boolean,
    canDownload: Boolean,
    actualSize: Boolean,
    onToggleActualSize: () -> Unit,
    onIntent: (RemoteWorkspaceIntent) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(68.dp)
            .background(MaterialTheme.colorScheme.background)
            .bottomHairline(MaterialTheme.colorScheme.outlineVariant)
            .padding(8.dp)
            .testTag(FILE_PREVIEW_HEADER_TEST_TAG),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HeaderControl(
            icon = R.drawable.ic_symbol_chevron_left,
            glyphSize = 22,
            contentDescription = stringResource(R.string.common_close),
            enabled = true,
            onClick = { onIntent(RemoteWorkspaceIntent.DismissPreview) },
        )
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                preview.displayName().ifEmpty { stringResource(R.string.file_preview_title) },
                fontSize = 16.sp,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                headerDetail(preview, remoteAvailable),
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (preview is RemoteFilePreviewUiState.Image) {
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .clickable(onClick = onToggleActualSize),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "1:1",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = if (actualSize) {
                        openBitFunColors.code.function
                    } else {
                        MaterialTheme.colorScheme.onSurface
                    },
                )
            }
        }
        HeaderControl(
            icon = R.drawable.ic_symbol_arrow_clockwise,
            glyphSize = 20,
            contentDescription = stringResource(R.string.common_refresh),
            enabled = canRefresh,
            onClick = { onIntent(preview.openIntent()) },
            modifier = Modifier.testTag(FILE_PREVIEW_REFRESH_TEST_TAG),
        )
        HeaderControl(
            icon = R.drawable.ic_symbol_arrow_down_to_line,
            glyphSize = 20,
            contentDescription = stringResource(R.string.file_download),
            enabled = canDownload,
            onClick = { onIntent(preview.downloadIntent()) },
            modifier = Modifier.testTag(FILE_PREVIEW_DOWNLOAD_TEST_TAG),
        )
    }
}

/** A 44dp header slot. Dimmed rather than removed when the link cannot answer. */
@Composable
private fun HeaderControl(
    icon: Int,
    glyphSize: Int,
    contentDescription: String,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .size(44.dp)
            .alpha(if (enabled) 1f else 0.45f)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painterResource(icon),
            contentDescription = contentDescription,
            tint = if (enabled) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
            modifier = Modifier.size(glyphSize.dp),
        )
    }
}

/** The 42dp filled action HarmonyOS puts under an empty state. */
@Composable
private fun InkPill(label: String, enabled: Boolean, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(21.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.onSurface,
            contentColor = MaterialTheme.colorScheme.surface,
            disabledContainerColor = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f),
            disabledContentColor = MaterialTheme.colorScheme.surface,
        ),
        modifier = Modifier.height(42.dp),
    ) { Text(label, fontSize = 14.sp) }
}

/**
 * Every empty and failure state centres the same way.
 *
 * The spacing and gutter are per state rather than shared: HarmonyOS gives the
 * loading state no gutter at all, and a wider gap to the states that carry a
 * sentence someone has to read.
 */
@Composable
private fun ColumnScope.CenteredState(
    spacing: Int,
    gutter: Int,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = Modifier
            .weight(1f)
            .fillMaxWidth()
            .padding(horizontal = gutter.dp),
        verticalArrangement = Arrangement.spacedBy(spacing.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
        content = content,
    )
}

/**
 * How a download of the open file is going, in the band under the header.
 *
 * Only this file's download: a transfer started from some other card belongs on
 * that card, not over the thing being read.
 */
@Composable
private fun DownloadStatusBand(download: RemoteFileDownloadUiState) {
    if (download is RemoteFileDownloadUiState.None) return
    Text(
        download.statusText(),
        fontSize = 12.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .bottomHairline(MaterialTheme.colorScheme.outlineVariant)
            .padding(start = 14.dp, end = 14.dp, top = 8.dp, bottom = 8.dp),
    )
}

/**
 * A 1dp rule on the bottom edge, drawn inside the box.
 *
 * A `HorizontalDivider` underneath would add its own dp to the 68dp header;
 * HarmonyOS' border is part of that height, so this one has to be too.
 */
private fun Modifier.bottomHairline(color: Color): Modifier = drawBehind {
    val stroke = 1.dp.toPx()
    drawRect(color = color, topLeft = Offset(0f, size.height - stroke), size = Size(size.width, stroke))
}

/**
 * What the file is, under its name.
 *
 * Offline outranks everything: it explains why the actions are dimmed and why
 * the content may be older than the file on the desktop.
 */
@Composable
private fun headerDetail(preview: RemoteFilePreviewUiState, remoteAvailable: Boolean): String = when {
    !remoteAvailable -> stringResource(R.string.file_preview_offline)
    preview is RemoteFilePreviewUiState.Loading -> stringResource(R.string.file_preview_loading)
    else -> metadataDetail(preview.mimeType(), preview.sizeBytes(), preview.remotePath())
}

/** `text/plain · 12 KB`, falling back to whichever half is known. */
private fun metadataDetail(mimeType: String, sizeBytes: Long, remotePath: String): String {
    val size = if (sizeBytes > 0) FilePreviewFormat.bytes(sizeBytes) else ""
    if (mimeType.isNotEmpty() && size.isNotEmpty()) return "$mimeType · $size"
    return mimeType.ifEmpty { size.ifEmpty { remotePath } }
}

private fun RemoteFilePreviewUiState.mimeType(): String = when (this) {
    RemoteFilePreviewUiState.None, is RemoteFilePreviewUiState.Loading -> ""
    is RemoteFilePreviewUiState.Text -> mimeType
    is RemoteFilePreviewUiState.Image -> mimeType
    is RemoteFilePreviewUiState.Unsupported -> mimeType
    is RemoteFilePreviewUiState.Failed -> mimeType
}

private fun RemoteFilePreviewUiState.sizeBytes(): Long = when (this) {
    RemoteFilePreviewUiState.None, is RemoteFilePreviewUiState.Loading -> 0
    is RemoteFilePreviewUiState.Text -> sizeBytes
    is RemoteFilePreviewUiState.Image -> sizeBytes
    is RemoteFilePreviewUiState.Unsupported -> sizeBytes
    is RemoteFilePreviewUiState.Failed -> sizeBytes
}

/** Refresh re-opens the same reference, which is what HarmonyOS' refresh does. */
private fun RemoteFilePreviewUiState.openIntent(): RemoteWorkspaceIntent =
    RemoteWorkspaceIntent.OpenFile(reference(), label(), sessionId())

private fun RemoteFilePreviewUiState.downloadIntent(): RemoteWorkspaceIntent =
    RemoteWorkspaceIntent.DownloadFile(reference(), label(), sessionId())

/**
 * Whether asking the desktop for this file again is a question worth putting
 * under the reader's thumb. Mirrors HarmonyOS' `canUseRemoteAction`: a read
 * already in flight, a refusal that will not change, or a target that never
 * resolved all leave the control visible but dimmed.
 */
private fun RemoteFilePreviewUiState.canBeAskedAgain(): Boolean = when (this) {
    RemoteFilePreviewUiState.None -> false
    is RemoteFilePreviewUiState.Loading -> false
    is RemoteFilePreviewUiState.Failed -> retryable && remotePath().isNotEmpty()
    else -> remotePath().isNotEmpty()
}

/** True while this exact file is the one being fetched. */
private fun RemoteFileDownloadUiState.isFetching(reference: String, remotePath: String): Boolean {
    val target = when (this) {
        is RemoteFileDownloadUiState.Loading -> this.target
        else -> return false
    }
    val asked = target.path.ifEmpty { target.remotePath }
    return asked.isNotEmpty() && (asked == reference || target.remotePath == remotePath)
}

private fun RemoteFilePreviewUiState.reference(): String = when (this) {
    RemoteFilePreviewUiState.None -> ""
    is RemoteFilePreviewUiState.Loading -> target.path.ifEmpty { target.remotePath }
    is RemoteFilePreviewUiState.Text -> target.path.ifEmpty { target.remotePath }
    is RemoteFilePreviewUiState.Image -> target.path.ifEmpty { target.remotePath }
    is RemoteFilePreviewUiState.Unsupported -> target.path.ifEmpty { target.remotePath }
    is RemoteFilePreviewUiState.Failed -> target.path.ifEmpty { target.remotePath }
}

private fun RemoteFilePreviewUiState.remotePath(): String = when (this) {
    RemoteFilePreviewUiState.None -> ""
    is RemoteFilePreviewUiState.Loading -> target.remotePath
    is RemoteFilePreviewUiState.Text -> target.remotePath
    is RemoteFilePreviewUiState.Image -> target.remotePath
    is RemoteFilePreviewUiState.Unsupported -> target.remotePath
    is RemoteFilePreviewUiState.Failed -> target.remotePath
}

private fun RemoteFilePreviewUiState.sessionId(): String = when (this) {
    RemoteFilePreviewUiState.None -> ""
    is RemoteFilePreviewUiState.Loading -> target.sessionId
    is RemoteFilePreviewUiState.Text -> target.sessionId
    is RemoteFilePreviewUiState.Image -> target.sessionId
    is RemoteFilePreviewUiState.Unsupported -> target.sessionId
    is RemoteFilePreviewUiState.Failed -> target.sessionId
}

private fun RemoteFilePreviewUiState.label(): String = when (this) {
    RemoteFilePreviewUiState.None -> ""
    is RemoteFilePreviewUiState.Loading -> target.displayName
    is RemoteFilePreviewUiState.Text -> target.displayName
    is RemoteFilePreviewUiState.Image -> target.displayName
    is RemoteFilePreviewUiState.Unsupported -> target.displayName
    is RemoteFilePreviewUiState.Failed -> target.displayName
}

/**
 * Colours the preview and marks the lines the agent's reference named.
 *
 * The shared [CodeSyntaxHighlighter] decides *what* each run is; this decides
 * what that looks like. Plain runs are left unspecified so they inherit the
 * card's own text colour rather than pinning a second definition of "ink".
 */
private fun highlightedSource(
    content: String,
    fileName: String,
    lineStart: Int,
    lineEnd: Int,
    colors: CodeSyntaxColors,
): AnnotatedString = buildAnnotatedString {
    for (token in CodeSyntaxHighlighter.tokenize(content, fileName)) {
        val style = SpanStyle(
            color = token.kind.color(colors),
            background = if (isTargetLine(token.lineNumber, lineStart, lineEnd)) {
                colors.targetBackground
            } else {
                Color.Unspecified
            },
        )
        withStyle(style) { append(token.text) }
    }
}

private fun CodeSyntaxTokenKind.color(colors: CodeSyntaxColors): Color = when (this) {
    CodeSyntaxTokenKind.PLAIN -> Color.Unspecified
    CodeSyntaxTokenKind.LINE_NUMBER -> colors.lineNumber
    CodeSyntaxTokenKind.KEYWORD -> colors.keyword
    CodeSyntaxTokenKind.STRING -> colors.string
    CodeSyntaxTokenKind.NUMBER -> colors.number
    CodeSyntaxTokenKind.COMMENT -> colors.comment
    CodeSyntaxTokenKind.FUNCTION -> colors.function
    CodeSyntaxTokenKind.TYPE -> colors.type
    CodeSyntaxTokenKind.CONSTANT -> colors.constant
    CodeSyntaxTokenKind.PROPERTY -> colors.property
}

/**
 * Line `0` means the file was too big to lex and came back as one block, so
 * there is nothing to line the highlight up with — better none than the wrong rows.
 */
private fun isTargetLine(lineNumber: Int, lineStart: Int, lineEnd: Int): Boolean {
    if (lineNumber <= 0 || lineStart <= 0) return false
    return lineNumber in lineStart..maxOf(lineEnd, lineStart)
}

/** The desktop's own sentence never reaches here; each reason has our wording. */
private fun FilePreviewFailureKind.messageRes(): Int = when (this) {
    FilePreviewFailureKind.NOT_FOUND -> R.string.file_preview_not_found
    FilePreviewFailureKind.UNAVAILABLE -> R.string.file_preview_unavailable
    FilePreviewFailureKind.ACCESS_DENIED -> R.string.file_preview_access_denied
    FilePreviewFailureKind.TOO_LARGE -> R.string.file_preview_too_large
    FilePreviewFailureKind.CONNECTION -> R.string.file_preview_connection
    FilePreviewFailureKind.LOAD_FAILED -> R.string.file_preview_failed
}

private fun RemoteFilePreviewUiState.displayName(): String = when (this) {
    RemoteFilePreviewUiState.None -> ""
    is RemoteFilePreviewUiState.Loading -> target.displayName
    is RemoteFilePreviewUiState.Text -> name
    is RemoteFilePreviewUiState.Image -> name
    is RemoteFilePreviewUiState.Unsupported -> target.displayName
    is RemoteFilePreviewUiState.Failed -> target.displayName
}

/**
 * The file this surface is currently holding, as the remote path the projector
 * also produces, so a file card under a turn can mark itself as the open one.
 *
 * Empty when nothing is open — an empty path matches no card, which is the same
 * answer as "none of them" without a nullable travelling down to every bubble.
 */
internal fun RemoteWorkspaceUiState.previewingRemotePath(): String {
    val preview = (this as? RemoteWorkspaceUiState.Ready)?.preview ?: return ""
    return when (preview) {
        RemoteFilePreviewUiState.None -> ""
        is RemoteFilePreviewUiState.Loading -> preview.target.remotePath
        is RemoteFilePreviewUiState.Text -> preview.target.remotePath
        is RemoteFilePreviewUiState.Image -> preview.target.remotePath
        is RemoteFilePreviewUiState.Unsupported -> preview.target.remotePath
        // A failure still names its file: the card that asked for it should keep
        // showing as the selected one while the reason sits above it.
        is RemoteFilePreviewUiState.Failed -> preview.target.remotePath
    }
}

/** Whether the open file is still on its way, for the card's spinner. */
internal fun RemoteWorkspaceUiState.previewLoading(): Boolean =
    (this as? RemoteWorkspaceUiState.Ready)?.preview is RemoteFilePreviewUiState.Loading
