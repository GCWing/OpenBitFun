package com.openbitfun.mobile.app.ui.remote

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.account.messageRes
import com.openbitfun.mobile.app.ui.theme.openBitFunColors
import com.openbitfun.mobile.core.feature.account.AccountUiState

internal const val CONNECT_ACCOUNT_DEVICE_TEST_TAG: String = "connect-account-device"
internal const val CONNECT_ACCOUNT_DEVICE_REFRESH_TEST_TAG: String = "connect-account-device-refresh"
internal const val CONNECT_ACCOUNT_DEVICE_ROW_TEST_TAG_PREFIX: String = "connect-account-device-row:"

/**
 * Signed-in landing page for remote control, matching HarmonyOS'
 * `ConnectAccountDevicePage`.
 *
 * A signed-in phone should not fall through to anonymous pairing just because
 * no desktop happened to be online when its session was restored. The last
 * device snapshot remains useful and refresh is explicit; the account is the
 * only way to reach a desktop.
 */
@Composable
internal fun ConnectAccountDeviceScreen(
    state: AccountUiState.Ready,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onSelect: (String) -> Unit,
    modifier: Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .testTag(CONNECT_ACCOUNT_DEVICE_TEST_TAG),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().height(92.dp).padding(start = 28.dp, end = 28.dp, top = 18.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Surface(
                onClick = onBack,
                shape = CircleShape,
                color = MaterialTheme.colorScheme.surfaceVariant,
                modifier = Modifier.size(48.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        painterResource(R.drawable.ic_symbol_chevron_left),
                        contentDescription = stringResource(R.string.common_back),
                        tint = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.size(23.dp),
                    )
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.weight(1f)) {
                Text(
                    stringResource(R.string.connect_account_devices_title),
                    fontSize = 22.sp,
                    lineHeight = 28.sp,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    stringResource(R.string.connect_account_devices_subtitle),
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = 28.dp, end = 28.dp, top = 10.dp, bottom = 34.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text(
                stringResource(R.string.connect_account_devices_body),
                fontSize = 14.sp,
                lineHeight = 21.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            DeviceListCard(state = state, onRefresh = onRefresh, onSelect = onSelect)
        }
    }
}

@Composable
private fun DeviceListCard(
    state: AccountUiState.Ready,
    onRefresh: () -> Unit,
    onSelect: (String) -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            Row(modifier = Modifier.fillMaxWidth().height(38.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.connect_account_devices_available),
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.weight(1f))
                if (state.refreshing) {
                    CircularProgressIndicator(
                        strokeWidth = 2.dp,
                        modifier = Modifier.size(16.dp),
                    )
                } else {
                    Text(
                        stringResource(
                            if (state.refreshFailure == null) {
                                R.string.account_devices_refresh
                            } else {
                                R.string.account_devices_retry
                            },
                        ),
                        fontSize = 14.sp,
                        color = if (state.refreshFailure == null) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.error
                        },
                        modifier = Modifier
                            .clickable(onClick = onRefresh)
                            .padding(horizontal = 6.dp, vertical = 6.dp)
                            .testTag(CONNECT_ACCOUNT_DEVICE_REFRESH_TEST_TAG),
                    )
                }
            }
            state.refreshFailure?.let { failure ->
                Text(
                    stringResource(failure.messageRes()),
                    fontSize = 13.sp,
                    lineHeight = 19.sp,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(bottom = 6.dp),
                )
            }
            if (state.devices.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxWidth().height(120.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    Text(
                        stringResource(R.string.account_devices_empty),
                        fontSize = 14.sp,
                        lineHeight = 20.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                state.devices.forEach { device ->
                    val selected = device.id == state.selectedDeviceId
                    val reconnectable = selected && !device.online
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(60.dp)
                            .clickable(enabled = device.online || reconnectable, onClick = { onSelect(device.id) })
                            .alpha(if (device.online || selected) 1f else 0.64f)
                            .testTag(CONNECT_ACCOUNT_DEVICE_ROW_TEST_TAG_PREFIX + device.id),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            painterResource(R.drawable.ic_symbol_desktop),
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(26.dp).alpha(if (device.online || selected) 0.68f else 0.38f),
                        )
                        Column(verticalArrangement = Arrangement.spacedBy(3.dp), modifier = Modifier.weight(1f)) {
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
                        if (reconnectable) {
                            Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(14.dp)) {
                                Text(
                                    stringResource(R.string.remote_settings_reconnect),
                                    fontSize = 14.sp,
                                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                                )
                            }
                        } else if (device.online && !selected) {
                            Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(14.dp)) {
                                Text(
                                    stringResource(R.string.account_connect),
                                    fontSize = 14.sp,
                                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
