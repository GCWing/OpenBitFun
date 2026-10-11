package com.openbitfun.mobile.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.core.feature.session.ModelCatalogFailure
import com.openbitfun.mobile.core.feature.session.ModelOption
import com.openbitfun.mobile.core.feature.session.RemoteSessionIntent
import com.openbitfun.mobile.core.feature.session.RemoteSessionUiState
import com.openbitfun.mobile.core.feature.session.modelOptions

internal const val REMOTE_SETTINGS_TEST_TAG: String = "remote-settings"
internal const val MODEL_CATALOG_FAILURE_TEST_TAG: String = "model-catalog-failure"
internal const val MODEL_CATALOG_RETRY_TEST_TAG: String = "model-catalog-retry"

/**
 * The settings that belong to one open session.
 *
 * Everything a desktop carries as a whole — which desktop, how it was reached,
 * who is signed in, and what it is allowed to run without asking — lives on
 * the one [SettingsScreen]. What stays here is
 * addressed to a session id on the wire and so has nowhere else to live.
 */
@Composable
internal fun RemoteSettingsSheet(
    state: RemoteSessionUiState.Ready,
    sessionId: String,
    onIntent: (RemoteSessionIntent) -> Unit,
    modifier: Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .testTag(REMOTE_SETTINGS_TEST_TAG),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ModelSection(state = state, sessionId = sessionId, onIntent = onIntent)
    }
}

@Composable
private fun ModelSection(
    state: RemoteSessionUiState.Ready,
    sessionId: String,
    onIntent: (RemoteSessionIntent) -> Unit,
) {
    val fallback = stringResource(R.string.models_unnamed)
    val options: List<ModelOption> = state.timeline?.modelOptions(fallback).orEmpty()
    val failure = state.modelCatalogFailure

    Text(stringResource(R.string.models_title), style = MaterialTheme.typography.titleMedium)

    when {
        failure == ModelCatalogFailure.LOAD_FAILED && options.isEmpty() -> {
            ModelCatalogNotice(
                text = stringResource(R.string.model_catalog_load_failed),
                isError = true,
                showRetry = true,
                retryEnabled = !state.busy,
                onRetry = { onIntent(RemoteSessionIntent.RefreshModelCatalog) },
            )
        }

        failure == ModelCatalogFailure.UNSUPPORTED_BY_PEER && options.isEmpty() -> {
            ModelCatalogNotice(
                text = stringResource(R.string.model_catalog_unsupported),
                isError = true,
                showRetry = false,
                retryEnabled = false,
                onRetry = {},
            )
        }

        options.isEmpty() -> {
            Text(
                stringResource(R.string.model_selector_empty),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        else -> {
            if (failure != null) {
                ModelCatalogNotice(
                    text = when (failure) {
                        ModelCatalogFailure.LOAD_FAILED ->
                            stringResource(R.string.model_catalog_stale_warning)

                        ModelCatalogFailure.UNSUPPORTED_BY_PEER ->
                            stringResource(R.string.model_catalog_unsupported)
                    },
                    isError = false,
                    showRetry = failure == ModelCatalogFailure.LOAD_FAILED,
                    retryEnabled = !state.busy,
                    onRetry = { onIntent(RemoteSessionIntent.RefreshModelCatalog) },
                )
            }
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(vertical = 4.dp)) {
                    options.forEachIndexed { index, option ->
                        if (index > 0) HorizontalDivider()
                        SelectableRow(
                            label = com.openbitfun.mobile.app.ui.chat.modelOptionTitle(option),
                            description = com.openbitfun.mobile.app.ui.chat.modelOptionSubtitle(option),
                            selected = option.selected,
                            enabled = !state.busy && sessionId.isNotEmpty(),
                            onSelect = {
                                onIntent(RemoteSessionIntent.SelectModel(sessionId, option.id))
                            },
                        )
                    }
                }
            }
        }
    }
}

/**
 * The model catalog section's non-happy-path copy: a blocking error when there
 * are no options to show, or a non-fatal warning when a previously loaded list
 * is retained. [isError] keeps the blocking case red while the warning stays a
 * muted note above the list it qualifies.
 */
@Composable
private fun ModelCatalogNotice(
    text: String,
    isError: Boolean,
    showRetry: Boolean,
    retryEnabled: Boolean,
    onRetry: () -> Unit,
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(4.dp),
        modifier = Modifier
            .fillMaxWidth()
            .testTag(MODEL_CATALOG_FAILURE_TEST_TAG),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            color = if (isError) {
                MaterialTheme.colorScheme.error
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
        if (showRetry) {
            TextButton(
                onClick = onRetry,
                enabled = retryEnabled,
                modifier = Modifier.testTag(MODEL_CATALOG_RETRY_TEST_TAG),
            ) {
                Text(stringResource(R.string.model_catalog_retry))
            }
        }
    }
}

@Composable
private fun SelectableRow(
    label: String,
    description: String,
    selected: Boolean,
    enabled: Boolean,
    onSelect: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(selected = selected, enabled = enabled, onClick = onSelect)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        RadioButton(selected = selected, onClick = onSelect, enabled = enabled)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            Text(
                description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
