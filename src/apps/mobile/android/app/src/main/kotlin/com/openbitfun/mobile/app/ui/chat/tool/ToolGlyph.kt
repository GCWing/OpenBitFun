package com.openbitfun.mobile.app.ui.chat.tool

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.core.feature.session.ToolCard
import com.openbitfun.mobile.core.feature.session.ToolKind
import com.openbitfun.mobile.core.feature.session.ToolPhase

/**
 * The badge a tool row leads with, ported from `ToolStatusIcon` in
 * `pages/components/ToolStatusList.ets` and the glyph set in `ToolGlyphs.ets`.
 *
 * Two marks in one: what the tool does, which is constant, and how it is going,
 * which is not. The second is drawn only while it is worth a glance — a tool
 * that finished the way tools usually do says so by having nothing pinned to it.
 */
@Composable
internal fun ToolStatusIcon(tool: ToolCard, modifier: Modifier) {
    Box(modifier = modifier.size(20.dp), contentAlignment = Alignment.TopStart) {
        Box(
            modifier = Modifier
                .size(18.dp)
                .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(5.dp))
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(5.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                painter = painterResource(kindIcon(tool.kind)),
                contentDescription = null,
                tint = kindTint(tool.kind),
                modifier = Modifier.size(12.dp),
            )
        }
        statusMark(tool.phase)?.let { mark ->
            Box(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .size(10.dp)
                    .background(MaterialTheme.colorScheme.onSurfaceVariant, CircleShape)
                    .border(1.dp, MaterialTheme.colorScheme.surface, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                // A character rather than an icon, as in the source: at ten
                // pixels across, a drawn glyph turns to mud and a bold `!` or
                // `?` still reads.
                Text(
                    text = mark,
                    fontSize = 7.sp,
                    lineHeight = 8.sp,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.surface,
                )
            }
        }
    }
}

/**
 * The badge for a folded group, which stands for several tools at once: the one
 * thing they all were when they agree, and a stack when they do not.
 */
@Composable
internal fun ToolSummaryIcon(readCount: Int, searchCount: Int, modifier: Modifier) {
    val icon = when {
        searchCount > 0 && readCount == 0 -> R.drawable.ic_symbol_magnifyingglass
        readCount > 0 && searchCount == 0 -> R.drawable.ic_symbol_doc_text
        else -> R.drawable.ic_symbol_rectangle_stack
    }
    Box(
        modifier = modifier
            .size(18.dp)
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(5.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painter = painterResource(icon),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(12.dp),
        )
    }
}

@DrawableRes
private fun kindIcon(kind: ToolKind): Int = when (kind) {
    ToolKind.QUESTION -> R.drawable.ic_symbol_questionmark_circle
    ToolKind.TODO -> R.drawable.ic_symbol_list_checkmark
    ToolKind.TASK -> R.drawable.ic_symbol_person
    ToolKind.GIT -> R.drawable.ic_symbol_arrow_triangle_merge
    ToolKind.DELETE -> R.drawable.ic_symbol_trash
    ToolKind.DIFF -> R.drawable.ic_symbol_doc_text_badge_magnifyingglass
    // Patch and command share a glyph in the source: both of them are, in the
    // end, something the desktop ran.
    ToolKind.PATCH, ToolKind.COMMAND -> R.drawable.ic_symbol_code_square
    ToolKind.CREATE -> R.drawable.ic_symbol_doc_text_badge_arrow_up
    ToolKind.MUTATE -> R.drawable.ic_symbol_square_and_pencil
    ToolKind.FOLDER -> R.drawable.ic_symbol_folder
    ToolKind.DOCUMENT -> R.drawable.ic_symbol_doc_text
    ToolKind.SEARCH -> R.drawable.ic_symbol_magnifyingglass
    ToolKind.WEB -> R.drawable.ic_symbol_link
    ToolKind.GENERIC -> R.drawable.ic_symbol_wrench_and_screwdriver
}

/**
 * Two families are tinted away from the default: what removes something, and
 * what adds it. The rest are one weight, because a column where every icon is a
 * colour is a column where none of them is a signal.
 */
@Composable
private fun kindTint(kind: ToolKind): Color = when (kind) {
    ToolKind.DELETE -> MaterialTheme.colorScheme.error
    ToolKind.TODO, ToolKind.CREATE -> MaterialTheme.colorScheme.tertiary
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

private fun statusMark(phase: ToolPhase): String? = when (phase) {
    ToolPhase.PENDING_CONFIRMATION -> "?"
    ToolPhase.RUNNING -> "•"
    ToolPhase.CANCELLED -> "×"
    ToolPhase.COMPLETED, ToolPhase.FAILED, ToolPhase.WAITING -> null
}
