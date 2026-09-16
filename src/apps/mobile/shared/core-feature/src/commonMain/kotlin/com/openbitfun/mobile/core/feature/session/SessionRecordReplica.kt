package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.domain.ChatMessage
import com.openbitfun.mobile.core.protocol.*
import kotlinx.serialization.json.*

/** Revisioned canonical records retain the complete host DTO; rendering is a mobile adapter. */
internal class SessionRecordReplica(private val sessionId: String) {
    private data class Versioned(val revision: Long, val value: JsonObject)
    private val turns = linkedMapOf<String, Versioned>()
    private val rounds = linkedMapOf<String, Versioned>()
    private val items = linkedMapOf<String, Versioned>()
    private val controls = mutableMapOf<String, Pair<String, RemoteToolStatusResponse>>()
    fun applyControl(payload: JsonObject) {
        val turn = payload.string("turnId")
        val event = payload["toolEvent"] as? JsonObject ?: return
        val id = event.string("tool_id")
        if (turn.isEmpty() || id.isEmpty()) return
        when (event.string("event_type")) {
            "ConfirmationNeeded" -> controls[id] = turn to RemoteToolStatusResponse(id = id, name = event.string("tool_name"), status = "pending_confirmation", toolInput = event["params"])
            "Confirmed", "Completed", "Failed", "Cancelled", "Rejected" -> controls.remove(id)
        }
    }
    private val recordVersions = mutableMapOf<String, Long>()
    private val tombstones = mutableMapOf<String, Long>()
    private val itemRounds = mutableMapOf<String, String>()
    private fun put(map: MutableMap<String, Versioned>, id: String, revision: Long, value: JsonObject) {
        if (revision > (map[id]?.revision ?: -1)) map[id] = Versioned(revision, value)
    }
    fun apply(payload: JsonObject) {
        check(payload.string("sessionId") == sessionId) { "Session record binding mismatch" }
        val revision = payload.getValue("revision").jsonPrimitive.long
        check(revision in 1..9007199254740991L) { "Invalid session record revision" }
        val recordId = payload.string("id")
        check(recordId.substringBefore('/') in setOf("turn", "round", "item") && recordId.substringAfter('/', "").isNotEmpty()) { "Invalid session record identity" }
        if (revision <= (recordVersions[recordId] ?: -1)) return
        if (payload["deleted"]?.jsonPrimitive?.booleanOrNull == true) {
            recordVersions[recordId] = revision
            if (revision > (tombstones[recordId] ?: -1)) tombstones[recordId] = revision
            return
        }
        if (revision <= (tombstones[recordId] ?: -1)) return
        val turn = payload.getValue("turn").jsonObject
        check(turn.string("sessionId") == sessionId) { "Turn binding mismatch" }
        val turnId = turn.string("turnId")
        check(turnId.isNotEmpty()) { "Missing turn identity" }
        val recordRound = payload["round"] as? JsonObject
        val recordItem = payload["item"] as? JsonObject
        check(recordItem == null || recordRound != null) { "Item has no round" }
        val expectedId = if (recordItem != null) "item/" + recordItem.getValue("data").jsonObject.string("id") else if (recordRound != null) "round/" + recordRound.string("id") else "turn/$turnId"
        check(recordId == expectedId) { "Session record identity mismatch" }
        val roundId = recordRound?.string("id")
        if (recordRound != null) {
            check(recordRound.string("turnId") == turnId) { "Round binding mismatch" }
        }
        val itemId = recordItem?.getValue("data")?.jsonObject?.string("id")
        if (itemId != null) {
            check(itemRounds[itemId] == null || itemRounds[itemId] == roundId) { "Item parent changed" }
        }

        // Validate the complete ancestry before changing either data or replay fences.
        // A rejected record must leave a corrected delivery at the same revision usable.
        recordVersions[recordId] = revision
        put(turns, turnId, revision, turn)
        if (turns[turnId]?.value?.string("status") != "inprogress") controls.entries.removeAll { it.value.first == turnId }
        if (recordRound != null && roundId != null) {
            put(rounds, roundId, revision, recordRound)
            if (recordItem != null && itemId != null) {
                itemRounds[itemId] = roundId
                put(items, itemId, revision, recordItem)
            }
        }
    }

    fun messages(): List<ChatMessage> = turns.filter { (id, record) -> record.revision > (tombstones["turn/$id"] ?: -1) }.values.sortedBy { it.value.number("turnIndex") }.flatMap { record ->
        val turn = record.value
        val turnId = turn.string("turnId")
        val user = turn.getValue("userMessage").jsonObject
        val turnFence = tombstones["turn/$turnId"] ?: -1
        val children = rounds.filter { (id, record) -> record.revision > maxOf(turnFence, tombstones["round/$id"] ?: -1) }.values.map { it.value }.filter { it.string("turnId") == turnId }
            .sortedBy { it.number("roundIndex") }.flatMap { round ->
                items.filter { (id, record) -> itemRounds[id] == round.string("id") && record.revision > maxOf(turnFence, tombstones["round/" + round.string("id")] ?: -1, tombstones["item/$id"] ?: -1) }.values.map { it.value }
                    .filter { it.getValue("data").jsonObject.string("status") !in setOf("superseded", "retry_superseded") }
                    .sortedWith(compareBy({ it.getValue("data").jsonObject.number("orderIndex") }, { it.getValue("data").jsonObject.number("timestamp") }))
            }
        val rendered = children.map { item ->
            val data = item.getValue("data").jsonObject
            val type = item.string("type")
            val result = data["toolResult"] as? JsonObject
            ChatMessageItemResponse(type = type, content = data.string("content"), isSubagent = data["isSubagentItem"]?.jsonPrimitive?.booleanOrNull == true || data.string("subagentSessionId").isNotEmpty(),
                tool = if (type != "tool") null else RemoteToolStatusResponse(
                    id = (data["toolCall"] as? JsonObject)?.string("id")?.takeIf { it.isNotEmpty() } ?: data.string("id"), name = data.string("toolName"),
                    status = data.string("status").takeIf { it.isNotEmpty() }
                        ?: if (result == null) "running" else if (result["success"]?.jsonPrimitive?.booleanOrNull == true) "completed" else "failed",
                    toolInput = (data["toolCall"] as? JsonObject)?.get("input"), toolOutput = result?.get("result"),
                    errorPreview = result?.string("error"),
                    startMs = data["startTime"]?.jsonPrimitive?.longOrNull,
                    durationMs = data["durationMs"]?.jsonPrimitive?.longOrNull
                        ?: result?.get("durationMs")?.jsonPrimitive?.longOrNull))
        }
        rendered.mapNotNull { it.tool }.filter { it.status in setOf("completed", "failed", "cancelled", "rejected", "skipped") }.forEach { controls.remove(it.id) }
        val controlTools = controls.values.filter { it.first == turnId }.map { it.second }
        val shownItems = rendered.map { item -> item.tool?.id?.let { id -> controlTools.firstOrNull { it.id == id } }?.let { item.copy(tool = it) } ?: item } +
            controlTools.filter { tool -> rendered.none { it.tool?.id == tool.id } }.map { ChatMessageItemResponse(type = "tool", tool = it) }
        listOf(RemoteResponseMapper.chatMessage(ChatMessageResponse(id = user.string("id"), role = "user", content = user.string("content"), turnId = turnId, metadata = user["metadata"], timestamp = user.string("timestamp"))),
            RemoteResponseMapper.chatMessage(ChatMessageResponse(id = "${turnId}_assistant", role = "assistant", turnId = turnId,
                content = rendered.filter { it.type == "text" && it.isSubagent != true }.joinToString("") { it.content.orEmpty() },
                thinking = rendered.filter { it.type == "thinking" && it.isSubagent != true }.joinToString("") { it.content.orEmpty() },
                items = shownItems, status = when (turn.string("status")) { "inprogress" -> "streaming"; "error" -> "failed"; else -> turn.string("status") }, error = turn.string("error"), metadata = turn)))
    }
    private fun JsonObject.string(key: String): String = (get(key) as? JsonPrimitive)?.contentOrNull.orEmpty()
    private fun JsonObject.number(key: String): Long = (get(key) as? JsonPrimitive)?.longOrNull ?: 0
}
