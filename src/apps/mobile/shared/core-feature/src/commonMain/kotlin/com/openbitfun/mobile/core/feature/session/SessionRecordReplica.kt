package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.domain.ChatMessage
import com.openbitfun.mobile.core.protocol.*
import kotlinx.serialization.json.*

/** Revisioned canonical records retain the complete host DTO; rendering is a mobile adapter. */
internal class SessionRecordReplica(private val sessionId: String) {
    private data class Versioned(val revision: Long, val value: JsonObject, val authoritative: Boolean = false)
    private val turns = linkedMapOf<String, Versioned>()
    private val rounds = linkedMapOf<String, Versioned>()
    private val items = linkedMapOf<String, Versioned>()
    private val controls = mutableMapOf<String, Pair<String, RemoteToolStatusResponse>>()

    /**
     * True until the stream has delivered a record of its own.
     *
     * An empty replica has nothing to say about the transcript, and rendering it
     * would erase a timeline the cache or the history fetch already filled.
     */
    val isEmpty: Boolean get() = turns.isEmpty()
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
    /** A round or item record repeats its parent turn so a partial page still reads,
     * but that copy is a header, not the turn's own state: the turn record is what the
     * user message and its attachment pixels come from, so a header fills a turn it has
     * never seen and never overwrites one. */
    private fun putTurn(id: String, revision: Long, value: JsonObject, authoritative: Boolean) {
        val stored = turns[id]
        if (stored != null && (revision <= stored.revision || (!authoritative && stored.authoritative))) return
        turns[id] = Versioned(revision, value, authoritative)
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
        putTurn(turnId, revision, turn, recordRound == null)
        if (turns[turnId]?.value?.string("status") != "inprogress") controls.entries.removeAll { it.value.first == turnId }
        if (recordRound != null && roundId != null) {
            put(rounds, roundId, revision, recordRound)
            if (recordItem != null && itemId != null) {
                itemRounds[itemId] = roundId
                put(items, itemId, revision, recordItem)
            }
        }
    }

    /**
     * Groups every round and item under its parent once per rebuild.
     *
     * Reading the transcript used to filter the whole round map for each turn
     * and the whole item map for each round, so a session paid for its own
     * length twice over on every record that arrived. Long sessions spend that
     * cost on the thread that draws them, which is where the scrolling went.
     */
    private data class Children(
        val roundsByTurn: Map<String, List<Pair<String, Versioned>>>,
        val itemsByRound: Map<String, List<Pair<String, Versioned>>>,
    )

    private fun children(): Children {
        val roundsByTurn = mutableMapOf<String, MutableList<Pair<String, Versioned>>>()
        rounds.forEach { (id, record) ->
            roundsByTurn.getOrPut(record.value.string("turnId")) { mutableListOf() }.add(id to record)
        }
        val itemsByRound = mutableMapOf<String, MutableList<Pair<String, Versioned>>>()
        items.forEach { (id, record) ->
            val roundId = itemRounds[id] ?: return@forEach
            itemsByRound.getOrPut(roundId) { mutableListOf() }.add(id to record)
        }
        return Children(roundsByTurn, itemsByRound)
    }

    fun messages(): List<ChatMessage> {
        val index = children()
        return turns.filter { (id, record) -> record.revision > (tombstones["turn/$id"] ?: -1) }.values.sortedBy { it.value.number("turnIndex") }.flatMap { record ->
            val turn = record.value
            val turnId = turn.string("turnId")
            val user = turn.getValue("userMessage").jsonObject
            val turnFence = tombstones["turn/$turnId"] ?: -1
            val children = index.roundsByTurn[turnId].orEmpty().filter { (id, record) -> record.revision > maxOf(turnFence, tombstones["round/$id"] ?: -1) }
                .sortedBy { it.second.value.number("roundIndex") }.flatMap { (currentRoundId, _) ->
                    val roundFence = maxOf(turnFence, tombstones["round/$currentRoundId"] ?: -1)
                    index.itemsByRound[currentRoundId].orEmpty().filter { (id, record) -> record.revision > maxOf(roundFence, tombstones["item/$id"] ?: -1) }.map { it.second.value }
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
            listOf(RemoteResponseMapper.chatMessage(ChatMessageResponse(id = user.string("id"), role = "user", content = user.string("content"), turnId = turnId, metadata = user["metadata"], images = userImages(user), timestamp = user.string("timestamp"))),
                RemoteResponseMapper.chatMessage(ChatMessageResponse(id = "${turnId}_assistant", role = "assistant", turnId = turnId,
                    content = rendered.filter { it.type == "text" && it.isSubagent != true }.joinToString("") { it.content.orEmpty() },
                    thinking = rendered.filter { it.type == "thinking" && it.isSubagent != true }.joinToString("") { it.content.orEmpty() },
                    items = shownItems, status = when (turn.string("status")) { "inprogress" -> "streaming"; "error" -> "failed"; else -> turn.string("status") }, error = turn.string("error"), metadata = turn)))
        }
    }

    /** Attachments are recorded with the turn; one that kept only a host path has no
     * pixels to hand a client that cannot reach that filesystem. */
    private fun userImages(user: JsonObject): List<ImageAttachment> =
        (((user["metadata"] as? JsonObject)?.get("images") as? JsonArray) ?: emptyList()).mapNotNull { entry ->
            val image = entry as? JsonObject ?: return@mapNotNull null
            image.string("data_url").takeIf { it.isNotEmpty() }?.let { ImageAttachment(name = image.string("name"), dataUrl = it) }
        }
    private fun JsonObject.string(key: String): String = (get(key) as? JsonPrimitive)?.contentOrNull.orEmpty()
    private fun JsonObject.number(key: String): Long = (get(key) as? JsonPrimitive)?.longOrNull ?: 0
}
