package com.openbitfun.mobile.app.ui.account

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.ui.graphics.asImageBitmap
import com.openbitfun.mobile.app.ui.common.ConnectionSheetHeader
import com.openbitfun.mobile.app.ui.common.ConnectionSheetFooter
import com.openbitfun.mobile.app.ui.common.connectionSheetTextStyle
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.platform.deviceIdentity
import com.openbitfun.mobile.app.viewmodel.AccountViewModel
import com.openbitfun.mobile.core.feature.account.AccountFailureReason
import com.openbitfun.mobile.core.feature.account.AccountIntent
import com.openbitfun.mobile.core.feature.account.AccountUiState
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignGeometry
import com.openbitfun.mobile.app.ui.theme.openBitFunColors

private val AccountCardShape = RoundedCornerShape(24.dp)

@Composable
internal fun AccountScreen(
    modifier: Modifier,
    onBack: () -> Unit = {},
    onDeviceSelected: (String) -> Unit = {},
    viewModel: AccountViewModel = viewModel(factory = AccountViewModel.Factory),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    when (val current = state) {
        AccountUiState.Idle, AccountUiState.Restoring -> Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        AccountUiState.SigningIn, AccountUiState.SignedOut, is AccountUiState.Authorizing, is AccountUiState.Failed -> AccountLoginPage(
            state = current,
            onBack = onBack,
            onLogin = { viewModel.dispatch(AccountIntent.Login) },
            modifier = modifier,
        )
        is AccountUiState.Ready -> AccountProfilePage(
            state = current,
            onBack = onBack,
            onRefresh = { viewModel.dispatch(AccountIntent.RefreshDevices) },
            onSelect = { deviceId -> viewModel.selectDevice(deviceId); onDeviceSelected(deviceId) },
            onLogout = { viewModel.dispatch(AccountIntent.Logout) },
            modifier = modifier,
        )
    }
}

@Composable
internal fun AccountLoginPage(
    state: AccountUiState,
    onBack: () -> Unit,
    onLogin: () -> Unit,
    modifier: Modifier,
    openAuthorization: ((String) -> Unit)? = null,
) {
    val busy = state is AccountUiState.SigningIn || state is AccountUiState.Authorizing
    val locale = androidx.compose.ui.platform.LocalConfiguration.current.locales[0].toLanguageTag()
    val authorizationUrl = (state as? AccountUiState.Authorizing)?.authorizationUrl?.let { value ->
        val uri = android.net.Uri.parse(value)
        if (uri.scheme == "https" && uri.host == "auth.openbitfun.com") {
            uri.buildUpon()
                .appendQueryParameter("locale", locale)
                .appendQueryParameter("returnTo", "openbitfun://auth/callback")
                .build().toString()
        } else value
    }
    val uriHandler = androidx.compose.ui.platform.LocalUriHandler.current
    var launchedAuthorizationUrl by rememberSaveable { mutableStateOf<String?>(null) }
    var launchFailed by rememberSaveable(authorizationUrl) { mutableStateOf(false) }
    val launchAuthorization = {
        authorizationUrl?.let { url ->
            launchedAuthorizationUrl = url
            launchFailed = runCatching {
                if (openAuthorization != null) openAuthorization(url) else uriHandler.openUri(url)
            }.isFailure
        }
        Unit
    }
    LaunchedEffect(authorizationUrl) {
        if (authorizationUrl == null) launchedAuthorizationUrl = null
        else if (launchedAuthorizationUrl != authorizationUrl) launchAuthorization()
    }
    val canSubmit = !busy || launchFailed
    Column(modifier.fillMaxWidth()) {
        ConnectionSheetHeader(onBack, uniformGlyph = true)
        Box(Modifier.weight(1f, fill = false).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
            Column(
                modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp).heightIn(min = MobileDesignGeometry.LoginSheetBodyMinHeight),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(stringResource(R.string.account_login_title),
                    style = MaterialTheme.typography.displayMedium.connectionSheetTextStyle(), textAlign = TextAlign.Center)
                Text(stringResource(R.string.account_login_body),
                    style = MaterialTheme.typography.bodyMedium.connectionSheetTextStyle(),
                    color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 8.dp))
                if (launchFailed) {
                    Text(stringResource(R.string.account_authorization_open_failed), color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall.connectionSheetTextStyle(), modifier = Modifier.padding(top = 12.dp))
                }
                (state as? AccountUiState.Failed)?.let { failure ->
                    Text(stringResource(failure.reason.messageRes()), color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall.connectionSheetTextStyle(), modifier = Modifier.padding(top = 12.dp))
                }
            }
        }
        ConnectionSheetFooter(
            label = stringResource(when {
                launchFailed -> R.string.sessions_retry
                busy -> R.string.account_signing_in
                else -> R.string.account_login_title
            }),
            primary = true, elevated = false, enabled = canSubmit,
            onClick = { if (launchFailed) launchAuthorization() else onLogin() },
        )
    }
}

@Composable
private fun AccountProfilePage(
    state: AccountUiState.Ready,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onSelect: (String) -> Unit,
    onLogout: () -> Unit,
    modifier: Modifier,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val installId = remember(context) { context.deviceIdentity().installId }
    Column(
        modifier = modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 18.dp, end = 18.dp, top = 20.dp, bottom = 42.dp),
    ) {
        Row(Modifier.fillMaxWidth().height(56.dp), verticalAlignment = Alignment.CenterVertically) {
            AccountBackButton(onBack, Modifier)
            Text(stringResource(R.string.account_profile_title), fontSize = 20.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
            Spacer(Modifier.size(44.dp))
        }
        Spacer(Modifier.height(30.dp))
        Surface(color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(28.dp), modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            Column(Modifier.fillMaxWidth().padding(top = 24.dp, bottom = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                AccountAvatar(70, state.avatarUrl)
                Text(state.username, fontSize = 22.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(state.userId, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.fillMaxWidth(0.88f), textAlign = TextAlign.Center)
            }
        }
        Surface(color = MaterialTheme.colorScheme.surface, shape = AccountCardShape, modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            Column(Modifier.padding(horizontal = 18.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.account_openbitfun_account), fontSize = 17.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.weight(1f))
                    Text(stringResource(R.string.remote_settings_account_signed_in), fontSize = 14.sp, color = com.openbitfun.mobile.app.ui.theme.openBitFunColors.statusSuccess)
                }
                Text(stringResource(R.string.account_signed_in_body, state.username), fontSize = 14.sp, lineHeight = 20.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Surface(color = MaterialTheme.colorScheme.surface, shape = AccountCardShape, modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            Column(Modifier.padding(horizontal = 18.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.account_devices_title), fontSize = 17.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.weight(1f))
                    Text(stringResource(if (state.refreshing) R.string.account_devices_loading else R.string.account_devices_refresh), fontSize = 13.sp, color = if (state.refreshing) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface, modifier = Modifier.clickable(enabled = !state.refreshing, onClick = onRefresh))
                }
                state.refreshFailure?.let { reason -> Text(stringResource(reason.messageRes()), fontSize = 13.sp, color = MaterialTheme.colorScheme.error) }
                if (state.devices.isEmpty()) {
                    Text(stringResource(R.string.account_devices_empty), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    state.devices.forEach { device ->
                        val selected = device.id == state.selectedDeviceId
                        val reconnectable = selected && !device.online
                        Row(Modifier.fillMaxWidth().height(54.dp).clickable(enabled = device.online || reconnectable, onClick = { onSelect(device.id) }), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Icon(painterResource(R.drawable.ic_symbol_desktop), contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(24.dp))
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(device.name.ifBlank { device.id }, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(
                                    stringResource(
                                        when {
                                            selected && device.online -> R.string.account_device_current_control
                                            device.online -> R.string.account_online
                                            else -> R.string.account_offline
                                        },
                                    ),
                                    fontSize = 13.sp,
                                    color = if (device.online) com.openbitfun.mobile.app.ui.theme.openBitFunColors.statusSuccess else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            if (reconnectable) Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(14.dp)) {
                                Text(stringResource(R.string.remote_settings_reconnect), fontSize = 14.sp, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                            } else if (device.online && !selected) Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(14.dp)) {
                                Text(stringResource(R.string.account_connect), fontSize = 14.sp, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                            }
                        }
                    }
                }
            }
        }
        Text(stringResource(R.string.account_profile_details), fontSize = 18.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 18.dp, bottom = 8.dp))
        Surface(color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(28.dp), modifier = Modifier.fillMaxWidth()) {
            Column {
                AccountDetailRow(stringResource(R.string.remote_settings_user_id), state.userId)
                androidx.compose.material3.HorizontalDivider(Modifier.padding(horizontal = 18.dp), color = MaterialTheme.colorScheme.outlineVariant)
                AccountDetailRow(stringResource(R.string.remote_settings_device_id), installId)
            }
        }
        Spacer(Modifier.height(30.dp))
        Surface(onClick = onLogout, color = MaterialTheme.colorScheme.surface, shape = AccountCardShape, modifier = Modifier.fillMaxWidth().height(62.dp)) {
            Row(Modifier.padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Icon(painterResource(R.drawable.ic_symbol_arrow_right_and_square), contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(22.dp))
                Text(stringResource(R.string.account_sign_out), fontSize = 17.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.error)
            }
        }
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
private fun AccountDetailRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, fontSize = 16.sp)
        Text(value, fontSize = 16.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.End, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun AccountAvatar(size: Int, url: String? = null) {
    val bitmap by androidx.compose.runtime.produceState<android.graphics.Bitmap?>(null, url) {
        value = null
        value = com.openbitfun.mobile.app.platform.loadAccountAvatar(url)
    }
    Box(Modifier.size(size.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
        val loaded = bitmap
        if (loaded != null) androidx.compose.foundation.Image(
            bitmap = loaded.asImageBitmap(), contentDescription = null,
            contentScale = androidx.compose.ui.layout.ContentScale.Crop, modifier = Modifier.size(size.dp),
        ) else Icon(painterResource(R.drawable.ic_symbol_person), contentDescription = null, modifier = Modifier.size((size * 0.52f).dp))
    }
}

@Composable
private fun AccountBackButton(onClick: () -> Unit, modifier: Modifier) {
    Surface(onClick = onClick, color = MaterialTheme.colorScheme.surface, shape = CircleShape, shadowElevation = 1.dp, modifier = modifier.size(44.dp)) {
        Box(contentAlignment = Alignment.Center) {
            Icon(painterResource(R.drawable.ic_symbol_chevron_left), contentDescription = stringResource(R.string.common_back), modifier = Modifier.size(23.dp))
        }
    }
}

internal fun AccountFailureReason.messageRes(): Int = when (this) {
    AccountFailureReason.INVALID_CREDENTIALS -> R.string.account_invalid_credentials
    AccountFailureReason.AUTHENTICATION -> R.string.account_authentication
    AccountFailureReason.RATE_LIMITED -> R.string.account_rate_limited
    AccountFailureReason.RELAY_UNAVAILABLE -> R.string.account_relay_unavailable
    AccountFailureReason.NETWORK -> R.string.account_network
    AccountFailureReason.TIMEOUT -> R.string.account_timeout
    AccountFailureReason.MALFORMED_RESPONSE -> R.string.account_malformed_response
    AccountFailureReason.SECURE_STORAGE -> R.string.account_secure_storage
}
