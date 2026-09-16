package com.openbitfun.mobile.core.feature.session

import kotlinx.serialization.json.*
import kotlin.test.*

class SessionRecordReplicaTest {
    private fun record(revision: Long, status: String, text: String): JsonObject = buildJsonObject {
        put("sessionId", "s"); put("id", "item/i"); put("revision", revision)
        put("turn", buildJsonObject {
            put("sessionId", "s"); put("turnId", "t"); put("turnIndex", 0); put("status", status)
            put("userMessage", buildJsonObject { put("id", "u"); put("content", "question"); put("timestamp", 1) })
        })
        put("round", buildJsonObject { put("id", "r"); put("turnId", "t"); put("roundIndex", 0) })
        put("item", buildJsonObject { put("type", "text"); put("data", buildJsonObject { put("id", "i"); put("content", text); put("orderIndex", 0) }) })
    }
    @Test fun newerRecordsReplaceByStableIdentityAndOlderDeliveryCannotRegress() {
        val replica = SessionRecordReplica("s")
        replica.apply(record(1, "running", "hello"))
        replica.apply(record(3, "completed", "hello world"))
        replica.apply(record(2, "running", "hello wor"))
        val messages = replica.messages()
        assertEquals(2, messages.size)
        assertEquals("u", messages[0].id)
        assertEquals("hello world", messages[1].text)
        assertEquals("completed", messages[1].status)
    }
    @Test fun tombstonesPreventOldReplayResurrection() {
        val replica = SessionRecordReplica("s")
        replica.apply(record(3, "completed", "final"))
        replica.apply(buildJsonObject { put("sessionId", "s"); put("id", "item/i"); put("revision", 4); put("deleted", true) })
        replica.apply(record(3, "completed", "final"))
        assertEquals("", replica.messages()[1].text)
        replica.apply(record(5, "completed", "restored"))
        assertEquals("restored", replica.messages()[1].text)
    }
    @Test fun restoringParentHeaderDoesNotResurrectChildrenBeforeDeletion() {
        for (parent in listOf("turn/t", "round/r")) {
            val replica = SessionRecordReplica("s")
            replica.apply(record(1, "inprogress", "deleted content"))
            replica.apply(buildJsonObject {
                put("sessionId", "s"); put("id", parent); put("revision", 10); put("deleted", true)
            })
            val source = record(11, "inprogress", "")
            replica.apply(JsonObject((source - "item" - "round") + ("id" to JsonPrimitive("turn/t"))))
            assertEquals("", replica.messages()[1].text)
            val child = record(12, "inprogress", "new child")
            val item = child.getValue("item").jsonObject
            val data = item.getValue("data").jsonObject
            replica.apply(JsonObject(child + mapOf(
                "id" to JsonPrimitive("item/new"),
                "item" to JsonObject(item + ("data" to JsonObject(data + ("id" to JsonPrimitive("new")))))
            )))
            assertEquals("new child", replica.messages()[1].text)
        }
    }

    @Test fun retrySupersededItemsAreNotPresented() {
        for (kind in listOf("text", "thinking", "tool")) {
            for (status in listOf("superseded", "retry_superseded")) {
                val replica = SessionRecordReplica("s")
                val source = record(1, "inprogress", "obsolete")
                val item = source.getValue("item").jsonObject
                val data = item.getValue("data").jsonObject
                replica.apply(JsonObject(source + ("item" to JsonObject(item + mapOf(
                    "type" to JsonPrimitive(kind),
                    "data" to JsonObject(data + ("status" to JsonPrimitive(status)))
                )))))
                val assistant = replica.messages()[1]
                assertTrue(assistant.items.orEmpty().isEmpty(), "$kind/$status must not reach presentation")
                assertEquals("", assistant.text)
                assertTrue(assistant.tools.orEmpty().isEmpty())
            }
        }
    }

    @Test fun subagentSessionIdentityMarksItemsWithoutLegacyBoolean() {
        val replica = SessionRecordReplica("s")
        val source = record(1, "inprogress", "child output")
        val item = source.getValue("item").jsonObject
        val data = item.getValue("data").jsonObject
        replica.apply(JsonObject(source + ("item" to JsonObject(item +
            ("data" to JsonObject(data + ("subagentSessionId" to JsonPrimitive("child-session"))))))))
        assertEquals(true, replica.messages()[1].items.orEmpty().single().isSubagent)
        assertEquals("", replica.messages()[1].text, "Child output must not leak through the aggregate text fallback")
    }

    @Test fun toolRecordUsesCallIdentityAndResultStatusWhenLegacyStatusIsMissing() {
        for ((success, expected) in listOf(true to "completed", false to "failed")) {
            val replica = SessionRecordReplica("s")
            val source = record(1, "inprogress", "")
            val data = buildJsonObject {
                put("id", "i"); put("toolName", "Read"); put("startTime", 123)
                put("toolCall", buildJsonObject { put("id", "call-id"); put("input", buildJsonObject { put("path", "/test") }) })
                put("toolResult", buildJsonObject { put("success", success); put("result", "output"); put("durationMs", 9) })
            }
            replica.apply(JsonObject(source + ("item" to buildJsonObject { put("type", "tool"); put("data", data) })))
            val tool = replica.messages()[1].tools.orEmpty().single()
            assertEquals("call-id", tool.id)
            assertEquals(expected, tool.status)
            assertEquals(123L, tool.startMs)
            assertEquals(9L, tool.durationMs)
            val zero = JsonObject(source + mapOf("revision" to JsonPrimitive(2),
                "item" to buildJsonObject { put("type", "tool"); put("data", JsonObject(data + ("durationMs" to JsonPrimitive(0)))) }))
            replica.apply(zero)
            assertEquals(0L, replica.messages()[1].tools.orEmpty().single().durationMs)
        }
    }

    @Test fun pendingApprovalIsASeparateControlOverlayAndCompletionClearsIt() {
        val replica = SessionRecordReplica("s")
        replica.apply(record(1, "inprogress", "working"))
        replica.applyControl(buildJsonObject { put("turnId", "t"); put("toolEvent", buildJsonObject { put("event_type", "ConfirmationNeeded"); put("tool_id", "call"); put("tool_name", "Bash"); put("params", buildJsonObject { put("command", "pwd") }) }) })
        val tool = replica.messages()[1].tools.orEmpty().single()
        assertEquals("pending_confirmation", tool.status)
        assertEquals("call", tool.id)
        replica.apply(record(2, "completed", "done"))
        assertTrue(replica.messages()[1].tools.orEmpty().isEmpty())
    }
    @Test fun rejectedRoundBindingDoesNotMutateOrConsumeRevision() {
        val replica = SessionRecordReplica("s")
        replica.apply(record(1, "inprogress", "working"))
        val before = replica.messages()
        val valid = record(2, "completed", "done")
        val invalid = JsonObject(valid + ("round" to JsonObject(valid.getValue("round").jsonObject +
            ("turnId" to JsonPrimitive("foreign-turn")))))
        assertFails { replica.apply(invalid) }
        assertEquals(before, replica.messages(), "Rejected records must not partially update the turn")
        replica.apply(valid)
        assertEquals("done", replica.messages()[1].text)
        assertEquals("completed", replica.messages()[1].status)
    }

    @Test fun rejectedItemParentDoesNotMutateOrConsumeRevision() {
        val replica = SessionRecordReplica("s")
        replica.apply(record(1, "inprogress", "working"))
        val before = replica.messages()
        val valid = record(2, "completed", "done")
        val invalid = JsonObject(valid + ("round" to JsonObject(valid.getValue("round").jsonObject +
            ("id" to JsonPrimitive("other-round")))))
        assertFails { replica.apply(invalid) }
        assertEquals(before, replica.messages())
        replica.apply(valid)
        assertEquals("done", replica.messages()[1].text)
    }

    @Test fun rejectsForeignSessionBinding() {
        val replica = SessionRecordReplica("other")
        assertFails { replica.apply(record(1, "running", "private")) }
        assertTrue(replica.messages().isEmpty())
    }
}
