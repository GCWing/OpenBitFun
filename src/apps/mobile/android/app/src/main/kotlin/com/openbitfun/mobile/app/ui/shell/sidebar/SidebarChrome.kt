package com.openbitfun.mobile.app.ui.shell.sidebar

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.openbitfun.mobile.app.ui.theme.openBitFunColors
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.feature.connection.ConnectionStatusPresenter
import com.openbitfun.mobile.core.feature.connection.ConnectionTone

/**
 * The round carded button the sidebar's header and footer are built from,
 * ported from the 38x38 and 46x46 stacks in `AppSidebar.ets`.
 *
 * Carded rather than a bare `IconButton`: the drawer's own background is the
 * page colour, so an icon drawn straight onto it has no edge and reads as
 * decoration instead of as something to press.
 */
@Composable
internal fun SidebarCircleButton(
    @DrawableRes icon: Int,
    contentDescription: String,
    diameter: Int,
    onClick: () -> Unit,
    modifier: Modifier,
) {
    Box(
        modifier = modifier
            .size(diameter.dp)
            .shadow(2.dp, CircleShape)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, CircleShape)
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painterResource(icon),
            contentDescription = contentDescription,
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.size((diameter * 0.46f).dp),
        )
    }
}

/** The connection state as a dot, the way `SidebarGlyph({ kind: 'remote' })` renders it. */
@Composable
internal fun ConnectionDot(phase: ConnectionPhase) {
    val tone = ConnectionStatusPresenter.tone(phase)
    // Keep recovery neutral across native sidebars; the status label and
    // accessibility state distinguish checking from a disconnected link.
    val color: Color = when (tone) {
        ConnectionTone.OK -> openBitFunColors.statusSuccess
        ConnectionTone.BUSY -> MaterialTheme.colorScheme.onSurfaceVariant
        ConnectionTone.ERROR -> MaterialTheme.colorScheme.error
        ConnectionTone.MUTED -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Box(
        Modifier
            .size(10.dp)
            .clip(CircleShape)
            .background(color),
    )
}
