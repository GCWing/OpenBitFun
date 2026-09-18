package com.openbitfun.mobile.core.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Drives [SessionItemResponse] from the shared contract fixtures so this client
 * and every other one decode the same bytes to the same values.
 */
class SessionItemContractTest {
    private val cases = run {
        val raw = assertNotNull(
            RelayContractFixtures["session-item"],
            "session-item fixture missing; check generateRelayContractFixtures",
        )
        RelayJson.parseToJsonElement(raw).jsonObject["cases"]!!.jsonArray.map { it.jsonObject }
    }

    @Test
    fun fixtureCoversMoreThanTheHappyPath() {
        // A fixture file that shrinks to one canonical case stops being a drift
        // guard, so the count is part of the contract.
        assertTrue(cases.size >= 7, "expected the alias and fallthrough cases, got ${cases.size}")
    }

    @Test
    fun everyCaseDecodesToItsExpectedForm() {
        for (case in cases) {
            val name = case["name"]!!.jsonPrimitive.content
            val wire = case["wire"]!!.jsonObject
            val expected = case["expected"]!!.jsonObject

            val decoded = RelayJson.decodeFromJsonElement(SessionItemResponse.serializer(), wire)

            assertEquals(expected.optionalString("id"), decoded.id, "$name: id")
            assertEquals(expected.optionalString("title"), decoded.title, "$name: title")
            assertEquals(expected.optionalString("agentType"), decoded.agentType, "$name: agentType")
            assertEquals(expected.optionalString("status"), decoded.status, "$name: status")
            assertEquals(expected.requiredString("updatedAt"), decoded.updatedAt, "$name: updatedAt")
            assertEquals(expected.requiredString("createdAt"), decoded.createdAt, "$name: createdAt")
            assertEquals(expected.optionalInt("messageCount"), decoded.messageCount, "$name: messageCount")
            assertEquals(
                expected.optionalString("workspacePath"),
                decoded.workspacePath,
                "$name: workspacePath",
            )
            assertEquals(
                expected.optionalString("workspaceName"),
                decoded.workspaceName,
                "$name: workspaceName",
            )
            assertEquals(
                expected.optionalString("parentSessionId"),
                decoded.parentSessionId,
                "$name: parentSessionId",
            )
            assertEquals(
                expected.optionalString("relationshipKind"),
                decoded.relationshipKind,
                "$name: relationshipKind",
            )
        }
    }

    @Test
    fun serializingEmitsCanonicalSpellings() {
        val aliased = RelayJson.decodeFromString(
            SessionItemResponse.serializer(),
            """{"session_id":"sess_alias","name":"Named","last_message_at":1754476800}""",
        )
        val encoded = RelayJson.encodeToString(SessionItemResponse.serializer(), aliased)
        assertEquals(
            """{"id":"sess_alias","title":"Named","updated_at":"1754476800"}""",
            encoded,
        )
    }

    @Test
    fun sessionListCarriesStatusAndPaging() {
        val decoded = RelayJson.decodeFromString(
            SessionListResponse.serializer(),
            """{"resp":"ok","sessions":[{"id":"a","updated_at":"t"}],"has_more":true}""",
        )
        assertEquals("ok", decoded.resp)
        assertEquals(1, decoded.sessions.size)
        assertEquals("a", decoded.sessions[0].id)
        assertTrue(decoded.hasMore)
    }

    @Test
    fun missingSessionsDecodesToEmptyListRatherThanFailing() {
        val decoded = RelayJson.decodeFromString(SessionListResponse.serializer(), """{"resp":"ok"}""")
        assertTrue(decoded.sessions.isEmpty())
        assertEquals(false, decoded.hasMore)
    }

    @Test
    fun errorRepliesAreRecognizable() {
        val decoded = RelayJson.decodeFromString(
            CommandStatusResponse.serializer(),
            """{"resp":"error","message":"no workspace"}""",
        )
        assertTrue(decoded.isError)
        assertEquals("no workspace", decoded.message)
    }

    @Test
    fun createSessionResolvesEitherIdentifierSpelling() {
        val viaSessionId = RelayJson.decodeFromString(
            CreateSessionResponse.serializer(),
            """{"resp":"ok","session_id":"s1"}""",
        )
        val viaId = RelayJson.decodeFromString(
            CreateSessionResponse.serializer(),
            """{"resp":"ok","id":"s2"}""",
        )
        assertEquals("s1", viaSessionId.resolvedSessionId)
        assertEquals("s2", viaId.resolvedSessionId)
    }
}

private fun JsonObject.optionalString(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonObject.requiredString(key: String): String =
    (this[key] as JsonPrimitive).content

private fun JsonObject.optionalInt(key: String): Int? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toIntOrNull()
