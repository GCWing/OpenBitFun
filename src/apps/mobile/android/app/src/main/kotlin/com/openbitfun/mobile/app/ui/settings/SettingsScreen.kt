package com.openbitfun.mobile.app.ui.settings

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.account.AccountSettingsDevicesSection
import com.openbitfun.mobile.app.ui.account.AccountSettingsIdentityCard
import com.openbitfun.mobile.app.ui.account.AccountSettingsSignOutRow
import com.openbitfun.mobile.core.feature.account.AccountUiState
import com.openbitfun.mobile.core.feature.connection.ConnectionPhase
import com.openbitfun.mobile.core.feature.connection.RemoteControlSummary
import com.openbitfun.mobile.core.feature.session.RemoteSessionIntent
import com.openbitfun.mobile.core.feature.session.RemoteSessionUiState
import com.openbitfun.mobile.app.platform.AppLocale
import com.openbitfun.mobile.app.platform.AppLocaleController
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignGeometry

internal const val SETTINGS_TEST_TAG: String = "settings"
internal const val SETTINGS_PROFILE_TEST_TAG: String = "settings-profile"
internal const val SETTINGS_MODEL_TEST_TAG: String = "settings-model"
internal const val SETTINGS_CLOSE_TEST_TAG: String = "settings-close"

/**
 * The app's one settings page: the account, what this phone is driving, what
 * that desktop may run unasked, then phone preferences, devices, and about.
 *
 * The sidebar gear and the remote home header both open it; there is no
 * separate remote-control page. The account is embedded rather than linked, as
 * `SettingsSheet.ets` embeds `AccountProfilePanel`: who is signed in, the
 * account's desktops, and sign out all sit here. [onSignIn] is the only way off
 * the page, to the login sheet. Model configuration belongs to the controlled
 * host.
 *
 * @param summary which desktop this phone is driving, decided by
 * `RemoteControlPresenter` rather than here.
 * @param remoteState the session store of whichever connection [summary] named,
 * read here only for the desktop-wide permission mode.
 */
@Composable
internal fun SettingsScreen(
    modifier: Modifier,
    account: AccountUiState.Ready?,
    summary: RemoteControlSummary,
    remoteState: RemoteSessionUiState,
    onSignIn: () -> Unit,
    onRefreshDevices: () -> Unit,
    onSelectDevice: (String) -> Unit,
    onSignOut: () -> Unit,
    onDisconnect: () -> Unit,
    onReconnect: () -> Unit,
    onSessionIntent: (RemoteSessionIntent) -> Unit,
    onClose: () -> Unit,
) {
    var showLanguagePicker by rememberSaveable { mutableStateOf(false) }
    val connected = summary.phase == ConnectionPhase.CONNECTED
    val readyRemote = remoteState as? RemoteSessionUiState.Ready

    // What `aboutToAppear` does in the source: the mode is the desktop's, so it
    // may have been changed from the desktop or from another phone since the
    // page was last open, and only asking again can say so. Keyed on readiness
    // too, so a session that becomes Ready while the page is open is asked then.
    LaunchedEffect(connected, readyRemote != null) {
        if (connected && readyRemote != null) {
            onSessionIntent(RemoteSessionIntent.RefreshPermissionMode)
        }
    }
    val context = LocalContext.current
    val selectedLocale = AppLocaleController.current(LocalConfiguration.current)

    BackHandler(enabled = showLanguagePicker) {
        showLanguagePicker = false
    }

    Box(modifier = modifier.fillMaxSize().testTag(SETTINGS_TEST_TAG)) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                // The title starts below the close button rather than beside it,
                // which is the source's `top: 64` over a floating `CloseButton()`:
                // a 28sp heading and a 44dp circle on one line read as a top bar,
                // and this page is not one — nothing here goes back anywhere.
                .padding(start = 16.dp, end = 16.dp, top = 64.dp, bottom = 34.dp),
        ) {
            Text(
                stringResource(R.string.settings_title),
                fontSize = 28.sp,
                lineHeight = 34.sp,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.fillMaxWidth().padding(bottom = 30.dp),
            )

            AccountSettingsIdentityCard(
                account = account,
                onSignIn = onSignIn,
                modifier = Modifier.testTag(SETTINGS_PROFILE_TEST_TAG),
            )

            GeneralSectionTitle(stringResource(R.string.remote_settings_current_control))
            CurrentControlCard(
                summary = summary,
                onDisconnect = onDisconnect,
                onReconnect = onReconnect,
                modifier = Modifier,
            )

            PermissionSection(
                state = readyRemote,
                connected = connected,
                onIntent = onSessionIntent,
                modifier = Modifier.padding(top = 24.dp),
            )

            GeneralSectionTitle(stringResource(R.string.settings_general_section))
            SettingsCard(
                modifier = Modifier,
                radius = MobileDesignGeometry.SettingsCompactCardRadius,
                bordered = false,
            ) {
                Column(modifier = Modifier.padding(vertical = 5.dp)) {
                    LanguageSettingsRow(
                        value = when (selectedLocale) {
                            AppLocale.ENGLISH -> stringResource(R.string.settings_language_english)
                            AppLocale.SIMPLIFIED_CHINESE -> stringResource(R.string.settings_language_chinese)
                        },
                        onClick = { showLanguagePicker = true },
                    )

                }
            }

            AccountSettingsDevicesSection(
                account = account,
                onRefresh = onRefreshDevices,
                onSelect = onSelectDevice,
                modifier = Modifier.padding(top = 24.dp),
            )

            GeneralSectionTitle(stringResource(R.string.settings_about_section))
            SettingsCard(
                modifier = Modifier,
                radius = MobileDesignGeometry.SettingsCompactCardRadius,
                bordered = false,
            ) {
                Column(modifier = Modifier.padding(vertical = 5.dp)) {
                    StaticSettingsRow(
                        title = stringResource(R.string.settings_about_product),
                        value = stringResource(R.string.settings_about_product_value),
                    )
                    // Short of the card's width and centred, as the source's
                    // 84%-wide rule is: a divider that reached the corners would
                    // read as two cards rather than as two rows of one.
                    HorizontalDivider(
                        modifier = Modifier.fillMaxWidth(0.84f).align(Alignment.CenterHorizontally),
                    )
                    StaticSettingsRow(
                        title = stringResource(R.string.settings_about_version),
                        value = appVersionName(),
                    )
                }
            }

            if (account != null) {
                AccountSettingsSignOutRow(onSignOut = onSignOut, modifier = Modifier.padding(top = 28.dp))
            }
        }

        // The source's `CloseButton()`, floating over the page's top-right corner.
        Surface(
            onClick = onClose,
            shape = androidx.compose.foundation.shape.CircleShape,
            color = MaterialTheme.colorScheme.surface,
            shadowElevation = 3.dp,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(top = 22.dp, end = 18.dp)
                .size(50.dp)
                .testTag(SETTINGS_CLOSE_TEST_TAG),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    painterResource(R.drawable.ic_symbol_xmark),
                    contentDescription = stringResource(R.string.common_close),
                    modifier = Modifier.size(21.dp),
                )
            }
        }

        if (showLanguagePicker) {
            LanguagePickerOverlay(
                selected = selectedLocale,
                onDismiss = { showLanguagePicker = false },
                onSelect = { locale ->
                    showLanguagePicker = false
                    AppLocaleController.set(context, locale)
                },
            )
        }


    }
}

@Composable
private fun LanguageSettingsRow(value: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .defaultMinSize(minHeight = 52.dp)
            .padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            "Aa",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontSize = 20.sp,
            modifier = Modifier.widthIn(min = 23.dp),
        )
        Text(
            stringResource(R.string.settings_language_title),
            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium),
        )
        Spacer(Modifier.weight(1f))
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 130.dp),
        )
        SettingsChevron()
    }
}

@Composable
private fun LanguagePickerOverlay(
    selected: AppLocale,
    onDismiss: () -> Unit,
    onSelect: (AppLocale) -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(
            topStart = MobileDesignGeometry.SelectionTopRadius,
            topEnd = MobileDesignGeometry.SelectionTopRadius,
        ),
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(Modifier.fillMaxSize()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(MobileDesignGeometry.SheetHeaderHeight)
                    .padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(R.string.settings_language_choose),
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Spacer(Modifier.weight(1f))
                Surface(
                    onClick = onDismiss,
                    shape = androidx.compose.foundation.shape.CircleShape,
                    color = MaterialTheme.colorScheme.surface,
                    modifier = Modifier.size(MobileDesignGeometry.SelectionCloseSize),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(
                            painterResource(R.drawable.ic_symbol_xmark),
                            contentDescription = stringResource(R.string.common_close),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
            HorizontalDivider()
            Column(Modifier.padding(top = 8.dp, bottom = 28.dp)) {
                LanguageChoiceRow(
                    label = stringResource(R.string.settings_language_chinese),
                    selected = selected == AppLocale.SIMPLIFIED_CHINESE,
                    onClick = { onSelect(AppLocale.SIMPLIFIED_CHINESE) },
                )
                LanguageChoiceRow(
                    label = stringResource(R.string.settings_language_english),
                    selected = selected == AppLocale.ENGLISH,
                    onClick = { onSelect(AppLocale.ENGLISH) },
                )
            }
        }
    }
}

@Composable
private fun LanguageChoiceRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(MobileDesignGeometry.SelectionRowHeight)
            .clickable(onClick = onClick)
            .padding(horizontal = 22.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            fontSize = 16.sp,
            fontWeight = FontWeight.Medium,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )
        if (selected) {
            Icon(
                painterResource(R.drawable.ic_symbol_list_checkmark),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

/** The 18sp Bold MUTED heading, indented onto the card's own text column. */
@Composable
private fun GeneralSectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(start = 12.dp, top = 24.dp, bottom = 8.dp),
    )
}

/** A row that only reports: no chevron, nothing to tap. */
@Composable
private fun StaticSettingsRow(title: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 52.dp)
            .padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(title, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium))
        Spacer(Modifier.weight(1f))
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun SettingsChevron() {
    Icon(
        painterResource(R.drawable.ic_symbol_chevron_right),
        contentDescription = null,
        tint = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.size(16.dp),
    )
}

/**
 * The version the user is actually running, asked of the package rather than
 * written into a string: a hardcoded number is right exactly once.
 */
@Composable
private fun appVersionName(): String {
    val context = LocalContext.current
    val unknown = stringResource(R.string.common_unknown)
    return remember(context) {
        runCatching {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName
        }.getOrNull().orEmpty().ifBlank { unknown }
    }
}
