package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.domain.ChatTimelineState
import com.openbitfun.mobile.core.domain.ModelLabelPolicy
import com.openbitfun.mobile.core.domain.ModelSelectionPolicy
import com.openbitfun.mobile.core.protocol.RemoteModelCatalog

/** Stable role facts; localized names belong to each app. */
public enum class ModelRole(public val selector: String) {
    PRIMARY("primary"),
    FAST("fast"),
}

/** Role selectors remain distinct from the concrete models they resolve to. */
public data class ModelOption public constructor(
    public val id: String,
    public val primaryLabel: String,
    public val secondaryLabel: String,
    public val selected: Boolean,
    public val role: ModelRole?,
    public val roles: List<ModelRole>,
    public val fallsBackToPrimary: Boolean,
) {
    /** Keep existing native callers source compatible. */
    public constructor(id: String, primaryLabel: String, secondaryLabel: String, selected: Boolean) :
        this(id, primaryLabel, secondaryLabel, selected, null, emptyList(), false)
}

/** Enabled models plus resolvable roles, with explicit selection taking priority. */
public fun ChatTimelineState.modelOptions(fallbackLabel: String): List<ModelOption> =
    modelCatalog.presentationOptions(
        fallbackLabel,
        listOf(selectedModelId, modelCatalog.sessionModelId, modelCatalog.defaultModels.primary),
    )

public fun ChatTimelineState.selectedModelOption(fallbackLabel: String): ModelOption? =
    modelOptions(fallbackLabel).firstOrNull { it.selected }

/** Models available while creating a session, before a transcript exists. */
public fun RemoteSessionUiState.Ready.createModelOptions(fallbackLabel: String): List<ModelOption> {
    val catalog = modelCatalog ?: timeline?.modelCatalog ?: return emptyList()
    return catalog.presentationOptions(
        fallbackLabel,
        listOf(timeline?.selectedModelId, catalog.sessionModelId, catalog.defaultModels.primary),
    )
}

private fun RemoteModelCatalog.presentationOptions(
    fallbackLabel: String,
    candidates: List<String?>,
): List<ModelOption> {
    val selectedId = candidates.firstNotNullOfOrNull { candidate ->
        candidate?.trim()?.takeIf { ModelSelectionPolicy.resolve(this, it) != null }
    }
    fun name(id: String, name: String, modelName: String): String =
        ModelLabelPolicy.primaryLabel(id, name, modelName, fallbackLabel)

    val defaults = ModelRole.entries.mapNotNull { role ->
        val model = ModelSelectionPolicy.resolve(this, role.selector) ?: return@mapNotNull null
        val modelName = name(model.id, model.name, model.modelName)
        val metadata = listOfNotNull(
            model.provider.trim().takeIf { it.isNotEmpty() },
            model.contextWindow?.takeIf { it > 0 }?.let {
                "${kotlin.math.round(it / 1000.0).toInt()}k"
            },
        )
        ModelOption(
            id = role.selector,
            primaryLabel = modelName,
            secondaryLabel = (listOf(modelName) + metadata).joinToString(" · "),
            selected = selectedId == role.selector,
            role = role,
            roles = emptyList(),
            fallsBackToPrimary = role == ModelRole.FAST && models.none {
                it.enabled && it.id == defaultModels.fast.orEmpty().trim()
            },
        )
    }
    val concrete = models.filter { it.enabled }.map { model ->
        val roles = ModelRole.entries.filter { role ->
            val configured = if (role == ModelRole.PRIMARY) defaultModels.primary else defaultModels.fast
            model.id == configured.orEmpty().trim()
        }
        ModelOption(
            id = model.id,
            primaryLabel = name(model.id, model.name, model.modelName),
            secondaryLabel = ModelLabelPolicy.secondaryLabel(
                model.id, model.name, model.modelName, model.provider, fallbackLabel,
            ),
            selected = selectedId == model.id,
            role = null,
            roles = roles,
            fallsBackToPrimary = false,
        )
    }
    return defaults + concrete
}
