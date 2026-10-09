package com.openbitfun.mobile.app.ui.shell.sidebar

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.theme.openBitFunColors

internal const val SIDEBAR_NEW_CHAT_TEST_TAG: String = "app-sidebar-new-chat"
internal const val SIDEBAR_SETTINGS_TEST_TAG: String = "app-sidebar-settings"

/** Shared tools/settings navigation for compact and wide sidebars. */
@Composable
internal fun SidebarAuthenticatedFooter(onOpenTools: () -> Unit, onOpenSettings: () -> Unit) {
    val toolsLabel = stringResource(R.string.device_tools)
    Row(
        modifier = Modifier.fillMaxWidth().height(56.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier
                .widthIn(min = 104.dp)
                .height(48.dp)
                .clip(RoundedCornerShape(24.dp))
                .background(openBitFunColors.sidebar.raised)
                .border(1.dp, openBitFunColors.sidebar.line, RoundedCornerShape(24.dp))
                .clickable(role = Role.Button, onClick = onOpenTools)
                .semantics(mergeDescendants = true) {
                    contentDescription = toolsLabel
                }
                .testTag(SIDEBAR_NEW_CHAT_TEST_TAG)
                .padding(horizontal = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                painterResource(R.drawable.ic_symbol_wrench_and_screwdriver),
                contentDescription = null,
                tint = openBitFunColors.sidebar.ink,
                modifier = Modifier.size(24.dp),
            )
            Text(
                toolsLabel,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                color = openBitFunColors.sidebar.ink,
            )
        }
        Box(Modifier.weight(1f))
        SidebarCircleButton(
            icon = R.drawable.ic_symbol_gearshape,
            contentDescription = stringResource(R.string.navigation_settings),
            diameter = 48,
            onClick = onOpenSettings,
            modifier = Modifier.testTag(SIDEBAR_SETTINGS_TEST_TAG),
        )
    }
}

/**
 * The signed-out footer: one full-width call to sign in, the way `SignedOutFooter`
 * draws it. Filled rather than carded because it is the only thing to press here.
 */
@Composable
internal fun SidebarSignedOutFooter(onOpenAccount: () -> Unit) {
    val label = stringResource(R.string.sidebar_sign_in)
    val shape = RoundedCornerShape(24.dp)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(48.dp)
            .clip(shape)
            .background(MaterialTheme.colorScheme.primary)
            .clickable(role = Role.Button, onClick = onOpenAccount)
            .semantics(mergeDescendants = true) {
                contentDescription = label
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onPrimary,
        )
    }
}
