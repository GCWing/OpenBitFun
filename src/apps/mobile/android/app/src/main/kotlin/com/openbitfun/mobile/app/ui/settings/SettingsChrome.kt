package com.openbitfun.mobile.app.ui.settings

import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignGeometry

/**
 * The pieces every section of the remote-control settings page is built from.
 *
 * `RemoteControlSettingsSheet.ets` draws one page out of four repeated shapes: a
 * muted section heading, a rounded CARD, a row that leads somewhere and says so
 * with a chevron, and a soft pill that carries the row's one action. They live
 * here rather than in each section's file so the page cannot drift apart by a
 * corner radius.
 */

/**
 * The 18sp Bold MUTED heading the source puts above every card.
 *
 * Indented 12dp, the same inset as every other section title on the settings
 * page, so the page's headings share one left edge.
 */
@Composable
internal fun SettingsSectionHeader(text: String, modifier: Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.padding(start = 12.dp),
    )
}

/**
 * The CARD-on-PAGE_BG container: surface fill, hairline LINE border, radius 24.
 *
 * [radius] because the source rounds the permission card at 28 rather than 24 —
 * it is the tallest card on the page, and the same corner on a taller block reads
 * as a sharper one.
 */
@Composable
internal fun SettingsCard(
    modifier: Modifier,
    radius: Dp = MobileDesignGeometry.SettingsCardRadius,
    bordered: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        shape = RoundedCornerShape(radius),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = if (bordered) {
            BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)
        } else {
            null
        },
        modifier = modifier.fillMaxWidth(),
        content = content,
    )
}

/** The soft round glyph slot the source draws in front of a row. */
@Composable
internal fun SettingsAvatar(@DrawableRes icon: Int, diameter: Int) {
    Box(
        modifier = Modifier
            .size(diameter.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painterResource(icon),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.size((diameter * 0.52f).dp),
        )
    }
}

/**
 * The SOFT pill an action or a badge sits in.
 *
 * [onClick] is null for the connection-source badge, which says where the link
 * came from and is not something to press.
 */
@Composable
internal fun SettingsChip(
    label: String,
    enabled: Boolean,
    onClick: (() -> Unit)?,
    modifier: Modifier,
) {
    val shape = RoundedCornerShape(14.dp)
    val content: @Composable RowScope.() -> Unit = {
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (enabled) 1f else 0.5f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
    val padded: @Composable () -> Unit = {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            content = content,
        )
    }
    if (onClick == null) {
        Surface(
            shape = shape,
            color = MaterialTheme.colorScheme.surfaceVariant,
            modifier = modifier,
        ) { padded() }
    } else {
        Surface(
            onClick = onClick,
            enabled = enabled,
            shape = shape,
            color = MaterialTheme.colorScheme.surfaceVariant,
            modifier = modifier,
        ) { padded() }
    }
}
