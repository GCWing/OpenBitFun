package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.domain.ChatSessionCursor
import com.openbitfun.mobile.core.domain.ChatSyncPhase
import com.openbitfun.mobile.core.domain.ChatTimelineState
import com.openbitfun.mobile.core.domain.ChatTranscriptOrigin
import com.openbitfun.mobile.core.protocol.RemoteDefaultModels
import com.openbitfun.mobile.core.protocol.RemoteModelCatalog
import com.openbitfun.mobile.core.protocol.RemoteModelConfig
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ConversationModelPresentationTest {
    @Test
    fun rolesResolveWithoutSelectingTheirConcreteRows() {
        val options = timeline(models = listOf(model("a"), model("b")), primary = "a", fast = "b",
            selectedModelId = " fast ").modelOptions(FALLBACK)
        assertEquals(listOf("primary", "fast", "a", "b"), options.map { it.id })
        assertEquals(listOf("fast"), options.filter { it.selected }.map { it.id })
        assertEquals(ModelRole.FAST, options[1].role)
        assertEquals(listOf(ModelRole.PRIMARY), options[2].roles)
        assertEquals(listOf(ModelRole.FAST), options[3].roles)
    }

    @Test
    fun missingOrDisabledFastFallsBackToPrimary() {
        val options = timeline(models = listOf(model("a"), model("b", enabled = false)), primary = "a", fast = "b",
            selectedModelId = "fast").modelOptions(FALLBACK)
        val fast = options.single { it.id == "fast" }
        assertEquals(true, fast.fallsBackToPrimary)
        assertEquals(true, fast.selected)
        assertEquals("a · Anthropic", fast.secondaryLabel)
        assertNull(timeline(models = listOf(model("a", enabled = false)), primary = "a",
            selectedModelId = "fast").selectedModelOption(FALLBACK))
    }

    @Test
    fun onlyEnabledModelsAreOffered() {
        val options = timeline(
            models = listOf(model("a", enabled = true), model("b", enabled = false)),
        ).modelOptions(FALLBACK)

        assertEquals(listOf("a"), options.map { it.id })
    }

    @Test
    fun theExplicitSelectionWinsOverBothDefaults() {
        val state = timeline(
            models = listOf(model("a"), model("b"), model("c")),
            sessionModelId = "b",
            primary = "c",
            selectedModelId = "a",
        )

        assertEquals("a", state.selectedModelOption(FALLBACK)?.id)
    }

    @Test
    fun aSelectionTheCatalogNoLongerOffersFallsThrough() {
        // The desktop can disable a model between two polls; the chip must then
        // name what the desktop would really use, not what we last asked for.
        val state = timeline(
            models = listOf(model("a", enabled = false), model("b")),
            sessionModelId = "b",
            selectedModelId = "a",
        )

        assertEquals("b", state.selectedModelOption(FALLBACK)?.id)
    }

    @Test
    fun theAccountDefaultIsTheLastCandidate() {
        val state = timeline(models = listOf(model("a"), model("b")), primary = "b")

        assertEquals("b", state.selectedModelOption(FALLBACK)?.id)
    }

    @Test
    fun nothingUsableMeansNoChipRatherThanAWrongOne() {
        assertNull(timeline(models = listOf(model("a", enabled = false))).selectedModelOption(FALLBACK))
        assertNull(timeline().selectedModelOption(FALLBACK))
    }

    @Test
    fun eachRowCarriesTwoLinesThatDiffer() {
        val option = timeline(
            models = listOf(
                RemoteModelConfig(
                    id = "m-1",
                    name = "Opus",
                    provider = "Anthropic",
                    baseUrl = "",
                    modelName = "anthropic/claude-opus-4",
                    enabled = true,
                ),
            ),
            selectedModelId = "m-1",
        ).modelOptions(FALLBACK).single()

        assertEquals("claude-opus-4", option.primaryLabel)
        assertEquals("Anthropic · Opus", option.secondaryLabel)
        assertEquals(true, option.selected)
    }
}

private const val FALLBACK = "Model"

private fun model(id: String, enabled: Boolean = true) = RemoteModelConfig(
    id = id,
    name = id,
    provider = "Anthropic",
    baseUrl = "",
    modelName = id,
    enabled = enabled,
)

private fun timeline(
    models: List<RemoteModelConfig> = emptyList(),
    sessionModelId: String? = null,
    primary: String? = null,
    fast: String? = null,
    selectedModelId: String = "",
) = ChatTimelineState(
    sessionId = "s-1",
    persistedMessages = emptyList(),
    optimisticMessages = emptyList(),
    activeTurn = null,
    syncPhase = ChatSyncPhase.IDLE,
    cursor = ChatSessionCursor(0, 0, 0),
    modelCatalog = RemoteModelCatalog(
        version = 1,
        models = models,
        defaultModels = RemoteDefaultModels(primary = primary, fast = fast),
        sessionModelId = sessionModelId,
    ),
    selectedModelId = selectedModelId,
    activeTurnAnchorId = "",
    origin = ChatTranscriptOrigin.HOST,
)
