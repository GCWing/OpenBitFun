package com.openbitfun.mobile.app.ui.shell.sidebar

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
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

internal const val SIDEBAR_SEARCH_TEST_TAG: String = "app-sidebar-search"

/**
 * The signed-in header, ported from `AuthenticatedHeader` in `AppSidebar.ets`:
 * the product name, and the controls that act on the list below it.
 */
@Composable
internal fun SidebarAuthenticatedHeader(
    searchOpen: Boolean,
    query: String,
    onQueryChange: (String) -> Unit,
    onToggleSearch: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().height(com.openbitfun.mobile.app.ui.theme.generated.MobileDesignGeometry.ConversationHeaderHeight),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            stringResource(R.string.app_name),
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onBackground,
            modifier = Modifier.weight(1f),
        )
        SidebarCircleButton(
            icon = R.drawable.ic_symbol_magnifyingglass,
            contentDescription = stringResource(R.string.sidebar_search),
            diameter = 38,
            onClick = onToggleSearch,
            modifier = Modifier,
        )
    }
    if (searchOpen) SidebarSearchField(query, onQueryChange)
}

/**
 * The search field, drawn as the soft-filled 42dp box the source uses rather
 * than a Material outlined field: it sits directly under the title with no label
 * of its own, and an outlined box there reads as a second header.
 */
@Composable
private fun SidebarSearchField(query: String, onQueryChange: (String) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            // The header column adds no spacing of its own, so the field keeps
            // its own gap under the title, matching the source's 12dp.
            .padding(top = 12.dp)
            .height(42.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painterResource(R.drawable.ic_symbol_magnifyingglass),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(18.dp),
        )
        BasicTextField(
            value = query,
            onValueChange = onQueryChange,
            singleLine = true,
            textStyle = LocalTextStyle.current.copy(
                fontSize = 15.sp,
                color = MaterialTheme.colorScheme.onSurface,
            ),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.onSurface),
            decorationBox = { field ->
                if (query.isEmpty()) {
                    Text(
                        stringResource(R.string.sidebar_search_placeholder),
                        fontSize = 15.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                field()
            },
            modifier = Modifier.fillMaxWidth().testTag(SIDEBAR_SEARCH_TEST_TAG),
        )
    }
}

/**
 * The signed-out header, ported from `SignedOutHeader`.
 *
 * Where the signed-in header names the product, this one is the one thing a
 * signed-out user can still do — start a conversation — so it is a row that acts
 * rather than a title.
 */
@Composable
internal fun SidebarSignedOutHeader(onNewChat: () -> Unit) {
    val newChatLabel = stringResource(R.string.sidebar_signed_out_new_chat)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(50.dp)
            .clip(RoundedCornerShape(12.dp))
            .clickable(role = Role.Button, onClick = onNewChat)
            .semantics(mergeDescendants = true) {
                contentDescription = newChatLabel
            }
            .padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painterResource(R.drawable.ic_symbol_square_and_pencil),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.size(22.dp),
        )
        Text(
            newChatLabel,
            fontSize = 16.sp,
            fontWeight = FontWeight.Medium,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}
