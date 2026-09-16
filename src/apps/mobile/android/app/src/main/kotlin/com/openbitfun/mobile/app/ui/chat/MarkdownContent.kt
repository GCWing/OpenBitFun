package com.openbitfun.mobile.app.ui.chat

import android.content.ClipData
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.core.feature.markdown.MarkdownBlock
import com.openbitfun.mobile.core.feature.markdown.MarkdownInline
import com.openbitfun.mobile.core.feature.markdown.MarkdownListItem
import com.openbitfun.mobile.core.feature.markdown.MarkdownParser
import kotlinx.coroutines.launch

internal const val MARKDOWN_TEST_TAG: String = "markdown"


/**
 * An agent turn as marked-up text, ported from `pages/components/MarkdownContent.ets`.
 *
 * The agent writes markdown whether or not the client renders it, so the choice
 * was never "markdown or plain text" — it was "rendered, or the asterisks and
 * backticks shown raw". HarmonyOS has rendered it from the start; this is the
 * Android half.
 *
 * Parsing is [MarkdownParser] in `core-feature`, already shared and already
 * tested — nothing about *what* a line means is decided here. What this file
 * owns is only how each block looks, and it keeps HarmonyOS's sizes so the two
 * clients scan the same. There is no [com.openbitfun.mobile.core.feature.markdown.MarkdownParseCache]
 * on this side: `remember(text)` is the cache Compose already has, and the ArkTS
 * class exists because its `build()` re-runs without one.
 */
@Composable
internal fun MarkdownContent(
    text: String,
    onOpenLink: (String, String) -> Unit,
    modifier: Modifier,
    streaming: Boolean = false,
) {
    val blocks = remember(text) { MarkdownParser.parse(text) }
    Column(
        modifier = modifier.fillMaxWidth().testTag(MARKDOWN_TEST_TAG),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        blocks.forEach { block ->
            MarkdownBlockView(
                block = block,
                onOpenLink = onOpenLink,
                copyFullText = if (streaming) text else null,
            )
        }
    }
}

@Composable
private fun MarkdownBlockView(
    block: MarkdownBlock,
    onOpenLink: (String, String) -> Unit,
    copyFullText: String?,
) {
    val colors = MaterialTheme.colorScheme
    when (block.type) {
        "code" -> CodeBlock(
            language = block.language,
            body = block.text,
            copyFullText = copyFullText,
        )

        "heading" -> InlineText(
            inlines = block.inlines,
            fontSize = headingFontSize(block.level),
            lineHeight = headingLineHeight(block.level),
            color = colors.onSurface,
            bold = true,
            onOpenLink = onOpenLink,
        )

        // A rule down the left rather than an indent: an indent alone is what a
        // nested list looks like, and the two blocks read differently.
        "quote" -> Row(modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
            Box(Modifier.width(2.dp).fillMaxHeight().background(colors.outlineVariant))
            Spacer(Modifier.width(9.dp))
            InlineText(
                inlines = block.inlines,
                fontSize = MaterialTheme.typography.bodyLarge.fontSize,
                lineHeight = MaterialTheme.typography.bodyLarge.lineHeight,
                color = colors.onSurfaceVariant,
                bold = false,
                onOpenLink = onOpenLink,
            )
        }

        "list" -> MarkdownList(items = block.items, onOpenLink = onOpenLink)

        "table" -> ScrollingMonospaceCard(body = block.text, header = null)

        "divider" -> Box(Modifier.fillMaxWidth().height(1.dp).background(colors.outlineVariant))

        else -> InlineText(
            inlines = block.inlines,
            fontSize = MaterialTheme.typography.bodyLarge.fontSize,
            lineHeight = MaterialTheme.typography.bodyLarge.lineHeight,
            color = colors.onSurface,
            bold = false,
            onOpenLink = onOpenLink,
        )
    }
}

/**
 * One run of text, with its emphasis and its links.
 *
 * [bold] is the heading case, and it is carried by the paragraph style rather
 * than stamped onto every span: an italic or a link inside a heading is still a
 * heading, so only the spans that add something set a weight of their own.
 */
@Composable
private fun InlineText(
    inlines: List<MarkdownInline>,
    fontSize: TextUnit,
    lineHeight: TextUnit,
    color: Color,
    bold: Boolean,
    onOpenLink: (String, String) -> Unit,
) {
    val linkColor = MaterialTheme.colorScheme.tertiary
    Text(
        text = annotatedInlines(inlines = inlines, linkColor = linkColor, onOpenLink = onOpenLink),
        fontSize = fontSize,
        lineHeight = lineHeight,
        color = color,
        fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun annotatedInlines(
    inlines: List<MarkdownInline>,
    linkColor: Color,
    onOpenLink: (String, String) -> Unit,
): AnnotatedString = buildAnnotatedString {
    inlines.forEach { inline ->
        when (inline.type) {
            "strong" -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(inline.text) }

            "emphasis" -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(inline.text) }

            "code" -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(inline.text) }

            // A link in an agent turn is nearly always a file it just touched,
            // so the tap goes to the same preview a file card would open — not
            // out to a browser.
            "link" -> withLink(
                LinkAnnotation.Clickable(
                    tag = inline.url,
                    styles = TextLinkStyles(
                        style = SpanStyle(
                            color = linkColor,
                            textDecoration = TextDecoration.Underline,
                        ),
                    ),
                ) { onOpenLink(inline.url, inline.text) },
            ) { append(inline.text) }

            else -> append(inline.text)
        }
    }
}

/**
 * The markers share a measured column so wrapped lines line up under the
 * text rather than under the bullet.
 */
@Composable
private fun MarkdownList(items: List<MarkdownListItem>, onOpenLink: (String, String) -> Unit) {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val style = MaterialTheme.typography.bodyLarge
    val markerWidth = remember(items, style, density, measurer) {
        with(density) {
            items.maxOfOrNull { measurer.measure(it.marker, style, softWrap = false).size.width }
                ?.toDp()?.coerceAtLeast(20.dp) ?: 20.dp
        }
    }
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        items.forEach { item ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(7.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Text(
                    item.marker,
                    fontSize = MaterialTheme.typography.bodyLarge.fontSize,
                    lineHeight = MaterialTheme.typography.bodyLarge.lineHeight,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.End,
                    modifier = Modifier.width(markerWidth),
                    softWrap = false,
                    maxLines = 1,
                )
                Box(Modifier.weight(1f)) {
                    InlineText(
                        inlines = item.inlines,
                        fontSize = MaterialTheme.typography.bodyLarge.fontSize,
                        lineHeight = MaterialTheme.typography.bodyLarge.lineHeight,
                        color = MaterialTheme.colorScheme.onSurface,
                        bold = false,
                        onOpenLink = onOpenLink,
                    )
                }
            }
        }
    }
}

/**
 * A fenced block, with the language it declared and a way to take it.
 *
 * Copy matters more here than anywhere else on the screen: a command the agent
 * wrote is meant to be run, and retyping it is how a typo gets into a shell.
 */
@Composable
private fun CodeBlock(language: String, body: String, copyFullText: String?) {
    val copyBody = copyFullText ?: body
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val copyLabel = stringResource(R.string.chat_copy)
    ScrollingMonospaceCard(
        body = body,
        header = {
            Row(modifier = Modifier.fillMaxWidth()) {
                Text(
                    language.ifBlank { "code" },
                    fontSize = MaterialTheme.typography.labelSmall.fontSize,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    copyLabel,
                    fontSize = MaterialTheme.typography.labelSmall.fontSize,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.clickableText {
                        scope.launch {
                            clipboard.setClipEntry(
                                ClipEntry(ClipData.newPlainText(copyLabel, copyBody)),
                            )
                        }
                    },
                )
            }
        },
    )
}

/**
 * Code and tables are the two blocks that must not be re-wrapped: a broken line
 * of code is a different line of code, and a wrapped table stops being a table.
 * Both scroll sideways inside their own card instead.
 */
@Composable
private fun ScrollingMonospaceCard(body: String, header: (@Composable () -> Unit)?) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            header?.invoke()
            val scroll = rememberScrollState()
            Box(Modifier.fillMaxWidth().horizontalScroll(scroll)) {
                Text(
                    body,
                    fontSize = MaterialTheme.typography.labelSmall.fontSize,
                    lineHeight = MaterialTheme.typography.labelSmall.lineHeight,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurface,
                    softWrap = false,
                    // Fills the card when the content is narrower than it, so a
                    // one-word block is still a full-width card.
                    modifier = Modifier.widthIn(min = 1.dp),
                )
            }
        }
    }
}

/** A tap target on a label, without a button's padding or ripple bounds. */
private fun Modifier.clickableText(onClick: () -> Unit): Modifier =
    clickable(onClick = onClick).padding(start = 8.dp)

@Composable
private fun headingFontSize(level: Int): TextUnit = when {
    level <= 1 -> MaterialTheme.typography.headlineSmall.fontSize
    level == 2 -> MaterialTheme.typography.titleMedium.fontSize
    else -> MaterialTheme.typography.bodyLarge.fontSize
}

@Composable
private fun headingLineHeight(level: Int): TextUnit = when {
    level <= 1 -> MaterialTheme.typography.headlineSmall.lineHeight
    level == 2 -> MaterialTheme.typography.titleMedium.lineHeight
    else -> MaterialTheme.typography.bodyLarge.lineHeight
}
