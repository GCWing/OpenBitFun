package com.openbitfun.mobile.app.ui.account

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.platform.loadAccountAvatar
import com.openbitfun.mobile.app.ui.settings.SettingsCard
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignGeometry
import com.openbitfun.mobile.app.ui.theme.openBitFunColors
import com.openbitfun.mobile.core.feature.account.AccountUiState

internal const val ACCOUNT_SETTINGS_SIGN_IN_TEST_TAG: String = "account-settings-sign-in"
internal const val ACCOUNT_SETTINGS_DEVICES_TEST_TAG: String = "account-settings-devices"
internal const val ACCOUNT_SETTINGS_REFRESH_TEST_TAG: String = "account-settings-refresh"
internal const val ACCOUNT_SETTINGS_SIGN_OUT_TEST_TAG: String = "account-settings-sign-out"

internal fun accountSettingsDeviceTestTag(deviceId: String): String = "account-settings-device-$deviceId"

/*
 * The account, embedded in every settings page the way `SettingsSheet.ets`
 * embeds `AccountProfilePanel` with `embeddedInSettings: true`: identity at the
 * top, the account's devices in the middle, sign out at the bottom. There is no
 * separate profile page to open any more; the only separate step left is the
 * login sheet, which a signed-out identity card leads to.
 */

/** Who is signed in, or, when nobody is, the door to signing in. */
@Composable
internal fun AccountSettingsIdentityCard(
    account: AccountUiState.Ready?,
    onSignIn: () -> Unit,
    modifier: Modifier,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        AccountSectionTitle(stringResource(R.string.settings_account), Modifier.padding(bottom = 8.dp))
        SettingsCard(
            modifier = Modifier,
            radius = MobileDesignGeometry.SettingsCompactCardRadius,
            bordered = false,
        ) {
            val signInLabel = stringResource(R.string.sidebar_sign_in)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .then(
                        if (account == null) {
                            Modifier
                                .clickable(role = Role.Button, onClick = onSignIn)
                                .semantics(mergeDescendants = true) { contentDescription = signInLabel }
                                .testTag(ACCOUNT_SETTINGS_SIGN_IN_TEST_TAG)
                        } else {
                            Modifier
                        },
                    )
                    .defaultMinSize(minHeight = 76.dp)
                    .padding(horizontal = 18.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                AccountAvatar(46, account?.avatarUrl)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        account?.username?.ifBlank { account.userId }
                            ?: stringResource(R.string.settings_account_signed_out),
                        style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        account?.userId ?: signInLabel,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (account != null) {
                    Text(
                        stringResource(R.string.remote_settings_account_signed_in),
                        style = MaterialTheme.typography.bodySmall,
                        color = openBitFunColors.statusSuccess,
                    )
                } else {
                    Icon(
                        painterResource(R.drawable.ic_symbol_chevron_right),
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        }
    }
}

/**
 * The account's desktops, picked in place. Selecting one is the same command the
 * sidebar and the connect sheet send; the caller decides where the user lands.
 */
@Composable
internal fun AccountSettingsDevicesSection(
    account: AccountUiState.Ready?,
    onRefresh: () -> Unit,
    onSelect: (String) -> Unit,
    modifier: Modifier,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AccountSectionTitle(stringResource(R.string.settings_devices_section), Modifier.weight(1f))
            if (account != null) {
                val refreshLabel = stringResource(R.string.account_devices_refresh)
                Surface(
                    onClick = onRefresh,
                    enabled = !account.refreshing,
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.surface,
                    modifier = Modifier
                        .size(36.dp)
                        .semantics { contentDescription = refreshLabel }
                        .testTag(ACCOUNT_SETTINGS_REFRESH_TEST_TAG),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        if (account.refreshing) {
                            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(16.dp))
                        } else {
                            Icon(
                                painterResource(R.drawable.ic_symbol_arrow_clockwise),
                                contentDescription = null,
                                modifier = Modifier.size(18.dp),
                            )
                        }
                    }
                }
            }
        }
        SettingsCard(
            modifier = Modifier.testTag(ACCOUNT_SETTINGS_DEVICES_TEST_TAG),
            radius = MobileDesignGeometry.SettingsCompactCardRadius,
            bordered = false,
        ) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                when {
                    account == null -> DevicesNote(stringResource(R.string.account_devices_sign_in_required))
                    account.devices.isEmpty() && account.refreshing ->
                        DevicesNote(stringResource(R.string.account_devices_loading))
                    else -> {
                        account.refreshFailure?.let { reason ->
                            Text(
                                stringResource(reason.messageRes()),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                        if (account.devices.isEmpty()) {
                            DevicesNote(stringResource(R.string.account_devices_empty))
                        }
                        account.devices.forEach { device ->
                            val selected = device.id == account.selectedDeviceId
                            val reconnectable = selected && !device.online
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .defaultMinSize(minHeight = 54.dp)
                                    .clip(RoundedCornerShape(10.dp))
                                    .clickable(
                                        enabled = device.online || reconnectable,
                                        role = Role.Button,
                                        onClick = { onSelect(device.id) },
                                    )
                                    .testTag(accountSettingsDeviceTestTag(device.id)),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                Icon(
                                    painterResource(R.drawable.ic_symbol_desktop),
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.size(24.dp),
                                )
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                    Text(
                                        device.name.ifBlank { device.id },
                                        fontSize = 15.sp,
                                        fontWeight = FontWeight.Medium,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Text(
                                        stringResource(
                                            when {
                                                selected && device.online -> R.string.account_device_current_control
                                                device.online -> R.string.account_online
                                                else -> R.string.account_offline
                                            },
                                        ),
                                        fontSize = 13.sp,
                                        color = if (device.online) {
                                            openBitFunColors.statusSuccess
                                        } else {
                                            MaterialTheme.colorScheme.onSurfaceVariant
                                        },
                                    )
                                }
                                when {
                                    reconnectable -> DeviceActionChip(stringResource(R.string.remote_settings_reconnect))
                                    device.online && !selected -> DeviceActionChip(stringResource(R.string.account_connect))
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Sign out, set apart and in the danger colour as `LogoutAction()` is. */
@Composable
internal fun AccountSettingsSignOutRow(onSignOut: () -> Unit, modifier: Modifier) {
    Column(modifier = modifier.fillMaxWidth()) {
        HorizontalDivider(Modifier.padding(bottom = 12.dp), color = MaterialTheme.colorScheme.outlineVariant)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(MobileDesignGeometry.SettingsCompactCardRadius))
                .clickable(role = Role.Button, onClick = onSignOut)
                .defaultMinSize(minHeight = 56.dp)
                .padding(horizontal = 18.dp)
                .testTag(ACCOUNT_SETTINGS_SIGN_OUT_TEST_TAG),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Icon(
                painterResource(R.drawable.ic_symbol_arrow_right_and_square),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(22.dp),
            )
            Text(
                stringResource(R.string.account_sign_out),
                fontSize = 17.sp,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

@Composable
private fun AccountSectionTitle(text: String, modifier: Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.padding(start = 12.dp),
    )
}

@Composable
private fun DevicesNote(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
    )
}

@Composable
private fun DeviceActionChip(label: String) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(14.dp)) {
        Text(label, fontSize = 14.sp, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
    }
}

@Composable
internal fun AccountAvatar(size: Int, url: String? = null) {
    val bitmap by produceState<android.graphics.Bitmap?>(null, url) {
        value = null
        value = loadAccountAvatar(url)
    }
    Box(
        Modifier.size(size.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        val loaded = bitmap
        if (loaded != null) {
            androidx.compose.foundation.Image(
                bitmap = loaded.asImageBitmap(),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(size.dp),
            )
        } else {
            Icon(
                painterResource(R.drawable.ic_symbol_person),
                contentDescription = null,
                modifier = Modifier.size((size * 0.52f).dp),
            )
        }
    }
}
