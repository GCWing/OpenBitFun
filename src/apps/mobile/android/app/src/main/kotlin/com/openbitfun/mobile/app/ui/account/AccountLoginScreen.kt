package com.openbitfun.mobile.app.ui.account

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.openbitfun.mobile.app.ui.common.ConnectionSheetHeader
import com.openbitfun.mobile.app.ui.common.ConnectionSheetFooter
import com.openbitfun.mobile.app.ui.common.connectionSheetTextStyle
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.viewmodel.AccountViewModel
import com.openbitfun.mobile.core.feature.account.AccountFailureReason
import com.openbitfun.mobile.core.feature.account.AccountIntent
import com.openbitfun.mobile.core.feature.account.AccountUiState
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignGeometry

/**
 * The login step, and only that. A signed-in account is shown inside every
 * settings page (see [AccountSettingsIdentityCard]), so once login lands the
 * shell closes this sheet and puts the user on settings; the spinner covers the
 * moment between the callback and that hand-off.
 */
@Composable
internal fun AccountLoginScreen(
    modifier: Modifier,
    onBack: () -> Unit = {},
    viewModel: AccountViewModel = viewModel(factory = AccountViewModel.Factory),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    when (val current = state) {
        AccountUiState.Idle, AccountUiState.Restoring, is AccountUiState.Ready ->
            Box(modifier.fillMaxWidth().heightIn(min = MobileDesignGeometry.LoginSheetBodyMinHeight), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        AccountUiState.SigningIn, AccountUiState.SignedOut, is AccountUiState.Authorizing, is AccountUiState.Failed -> AccountLoginPage(
            state = current,
            onBack = onBack,
            onLogin = { viewModel.dispatch(AccountIntent.Login) },
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
