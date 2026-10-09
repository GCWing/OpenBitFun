package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.domain.ChatMessage
import com.openbitfun.mobile.core.domain.ToolInputPolicy
import com.openbitfun.mobile.core.domain.ToolNamePolicy
import com.openbitfun.mobile.core.protocol.ChatMessageItemResponse
import com.openbitfun.mobile.core.protocol.RemoteToolStatusResponse

/**
 * One piece of an agent turn, in the order the agent produced it.
 *
 * Ported from `structuredGroups` in `pages/components/ChatMessageBubble.ets`. A
 * turn is not a paragraph followed by a list of tools — it is a sequence: read
 * two files, say something about them, run a command, say what it printed.
 * Flattening that into "all the text, then all the tools" reads as if the agent
 * explained itself before doing any of the work.
 */
public sealed interface MessageBlock {
    public val id: String

    /** Prose, rendered as markdown. */
    public data class Text public constructor(
        override val id: String,
        public val text: String,
        /** Tokens are still arriving for this block specifically. */
        public val streaming: Boolean,
    ) : MessageBlock

    /** The model's reasoning; apps collapse this by default. */
    public data class Thinking public constructor(
        override val id: String,
        public val text: String,
        public val streaming: Boolean,
    ) : MessageBlock

    /** Tools the agent ran back to back, kept together so they can fold. */
    public data class Tools public constructor(
        override val id: String,
        public val tools: List<ToolCard>,
    ) : MessageBlock

    /**
     * A subagent's own turn, nested inside this one.
     *
     * [title] is empty when the agent gave it none — apps name it themselves
     * rather than printing a relay string.
     */
    public data class Subagent public constructor(
        override val id: String,
        public val title: String,
        /** Its tool is still going, so the app shows it is being waited on. */
        public val running: Boolean,
        public val text: String,
        public val children: List<MessageBlock>,
        /** Preserve host status; running alone loses failure and queued states. */
        public val status: String,
    ) : MessageBlock {
        // Keep source compatibility without default arguments on the exported feature API.
        public constructor(id: String, title: String, running: Boolean, text: String, children: List<MessageBlock>) :
            this(id, title, running, text, children, if (running) "running" else "completed")
    }
}

/**
 * A message as ordered blocks, or empty when it has no structure worth walking.
 *
 * Empty is not "nothing to draw": it means the message is a plain answer, and
 * the app draws [ConversationRow.text] and [ConversationRow.tools] as before.
 * That is the same fork `shouldRenderStructuredItems` makes.
 */
internal fun messageBlocks(message: ChatMessage, streaming: Boolean): List<MessageBlock> {
    val items = scopeSubagentItems(message.items.orEmpty())
    if (items.none(::isRenderable)) return emptyList()

    val blocks = walk(items, message.id, streaming)
    val uncovered = uncoveredTools(message)
    val withTail = if (uncovered.isEmpty()) {
        blocks
    } else {
        blocks + MessageBlock.Tools("${message.id}-tail-tools", uncovered.map(::toolCard))
    }
    return withTail
}

/**
 * Whether the turn has produced nothing at all yet.
 *
 * The three dots stand in for the first token; once anything has arrived they
 * would only be saying what the arriving text already says.
 */
internal fun isTyping(message: ChatMessage, streaming: Boolean): Boolean {
    if (!streaming) return false
    if (message.text.trim().isNotEmpty()) return false
    if (!message.thinking.isNullOrBlank()) return false
    if (!message.tools.isNullOrEmpty()) return false
    return message.items.orEmpty().none(::isRenderable)
}

/** Reconstruct Task ownership before rendering flat remote snapshots (Harmony parity). */
private fun scopeSubagentItems(items: List<ChatMessageItemResponse>): List<ChatMessageItemResponse> {
    val result = mutableListOf<ChatMessageItemResponse>()
    val marked = items.any { it.isSubagent == true }
    var taskIndex: Int? = null
    // A Task's children can arrive nested in its own items and again flat behind
    // it, so folding the restatement would draw every child twice. A counted
    // restatement is skipped, and a child that legitimately repeats survives.
    var carried = mutableListOf<Int>()
    for (entry in items) {
        if (entry.tool?.let(ToolNamePolicy::isTask) == true) {
            result += entry
            taskIndex = result.lastIndex
            carried = result.last().subItems.orEmpty().indices.toMutableList()
            continue
        }
        val owner = taskIndex?.let(result::get)
        val legacyChild = !marked && owner?.tool?.status.orEmpty().lowercase() in SUBAGENT_RUNNING &&
            (isThinking(entry) || isText(entry) || entry.tool != null)
        if (owner != null && (entry.isSubagent == true || legacyChild)) {
            // The marker identifies ownership, not a nested Task card. Keep the
            // original kind/tool so child reasoning and tools render as such.
            val child = entry.copy(isSubagent = false)
            val children = owner.subItems.orEmpty()
            val match = carried.indexOfFirst { sameChildIdentity(children[it], child) }
            if (match >= 0) {
                // A flat tool record can be the newer restatement of the nested
                // copy. Keep its result/status while consuming only this one
                // nested occurrence; a second identical flat child remains real.
                val index = carried.removeAt(match)
                val incomingTool = child.tool
                if (incomingTool != null) {
                    val updated = children.toMutableList()
                    updated[index] = child.copy(
                        content = child.content ?: children[index].content,
                        subItems = child.subItems ?: children[index].subItems,
                        tool = mergeChildTool(children[index].tool, incomingTool),
                    )
                    result[taskIndex] = owner.copy(subItems = updated)
                }
            } else {
                result[taskIndex] = owner.copy(subItems = owner.subItems.orEmpty() + child)
            }
        } else {
            // A partial snapshot may omit the owning Task. Retain a collapsed
            // branch with its content instead of exposing it as parent output.
            result += if (entry.isSubagent == true && entry.type.orEmpty().lowercase() !in SUBAGENT_TYPES &&
                entry.tool?.let(ToolNamePolicy::isTask) != true && entry.subItems.isNullOrEmpty()) {
                entry.copy(content = if (entry.tool == null) "" else entry.content,
                    subItems = listOf(entry.copy(isSubagent = false, subItems = emptyList())))
            } else entry
        }
    }
    return result
}

private fun walk(items: List<ChatMessageItemResponse>, path: String, streaming: Boolean): List<MessageBlock> {
    val blocks = mutableListOf<MessageBlock>()
    val toolRun = mutableListOf<RemoteToolStatusResponse>()
    val lastIndex = items.indexOfLast(::isRenderable)

    // An id is view identity: changing it discards the drawn block together with
    // its expansion and scroll state. Counting each kind separately keeps an id
    // while siblings of other kinds arrive, so a turn cannot renumber itself.
    val ordinals = mutableMapOf<String, Int>()
    fun nextId(kind: String): String {
        val ordinal = ordinals[kind] ?: 0
        ordinals[kind] = ordinal + 1
        return "$path-$kind-$ordinal"
    }

    fun flushTools() {
        if (toolRun.isEmpty()) return
        blocks += MessageBlock.Tools(nextId("tools"), toolRun.map(::toolCard))
        toolRun.clear()
    }

    items.forEachIndexed { index, entry ->
        val live = streaming && index == lastIndex
        // A subagent is checked before its tool: `Task` arrives as a tool entry
        // and is the subagent, rather than something the subagent did.
        if (isSubagent(entry)) {
            flushTools()
            val status = entry.tool?.status?.takeIf(String::isNotBlank)?.lowercase()
                ?: if (live && !entry.subItems.isNullOrEmpty()) "running" else "completed"
            val running = status in SUBAGENT_RUNNING
            val id = nextId("subagent")
            blocks += MessageBlock.Subagent(
                id = id,
                title = subagentTitle(entry),
                running = running,
                text = subagentBody(entry),
                children = walk(entry.subItems.orEmpty().map { it.copy(isSubagent = false) }, id, running),
                status = status,
            )
            return@forEachIndexed
        }
        val tool = entry.tool
        if (tool != null) {
            toolRun += tool
            return@forEachIndexed
        }
        flushTools()
        when {
            isThinking(entry) -> blocks += MessageBlock.Thinking(
                id = nextId("thinking"),
                text = entry.content.orEmpty().trim(),
                streaming = live,
            )

            isText(entry) -> blocks += MessageBlock.Text(
                id = nextId("text"),
                text = entry.content.orEmpty().trim(),
                streaming = live,
            )
        }
        entry.subItems?.takeIf(List<ChatMessageItemResponse>::isNotEmpty)?.let { children ->
            blocks += walk(children, nextId("nested"), streaming && live)
        }
    }
    flushTools()
    return blocks
}

/**
 * The tools the relay reported flat that no item already accounts for.
 *
 * The same turn arrives twice — once in `tools`, once inline in `items` — and
 * which is populated depends on the agent. Drawing both would show every tool
 * twice on the agents that send both.
 */
private fun uncoveredTools(message: ChatMessage): List<RemoteToolStatusResponse> {
    val flat = message.tools.orEmpty()
    if (flat.isEmpty()) return emptyList()
    val covered = mutableSetOf<String>()
    fun collect(items: List<ChatMessageItemResponse>) {
        items.forEach { entry ->
            entry.tool?.let { covered += fingerprint(it) }
            entry.subItems?.let(::collect)
        }
    }
    collect(message.items.orEmpty())
    return flat.filter { fingerprint(it) !in covered }
}

/** Id when the agent gave one, and what the tool is otherwise. */
private fun fingerprint(tool: RemoteToolStatusResponse): String {
    tool.id?.takeIf(String::isNotEmpty)?.let { return "id:$it" }
    return listOf(
        ToolNamePolicy.normalized(tool),
        tool.status.orEmpty(),
        tool.inputPreview.orEmpty(),
        tool.resultPreview.orEmpty(),
        tool.errorPreview.orEmpty(),
        tool.exitCode?.toString().orEmpty(),
    ).joinToString("|")
}

/**
 * What makes two subagent children the same piece of work.
 *
 * Children arrive without an id, so the kind, its content, and the tool it names
 * are all there is to tell one from the other.
 */
private fun childFingerprint(entry: ChatMessageItemResponse): String = listOf(
    entry.type.orEmpty().lowercase(),
    entry.content.orEmpty(),
    entry.tool?.let(::fingerprint).orEmpty(),
).joinToString("\u0000")

private fun sameChildIdentity(a: ChatMessageItemResponse, b: ChatMessageItemResponse): Boolean =
    if (a.tool?.id.orEmpty().isNotEmpty() || b.tool?.id.orEmpty().isNotEmpty()) {
        a.tool?.id.orEmpty() == b.tool?.id.orEmpty() && a.tool?.id.orEmpty().isNotEmpty()
    } else childFingerprint(a) == childFingerprint(b)

private fun isRenderable(entry: ChatMessageItemResponse): Boolean =
    isThinking(entry) || isText(entry) || isSubagent(entry) || entry.tool != null ||
        entry.subItems.orEmpty().any(::isRenderable)

private fun isThinking(entry: ChatMessageItemResponse): Boolean =
    entry.type.orEmpty().lowercase() == "thinking" && entry.content.orEmpty().isNotBlank()

private fun isText(entry: ChatMessageItemResponse): Boolean {
    if (entry.content.orEmpty().isBlank()) return false
    if (entry.tool != null || isThinking(entry) || isSubagent(entry)) return false
    return entry.type.orEmpty().lowercase() in TEXT_TYPES
}

private fun isSubagent(entry: ChatMessageItemResponse): Boolean {
    if (entry.isSubagent == true) return true
    if (entry.type.orEmpty().lowercase() in SUBAGENT_TYPES) return true
    return entry.tool?.let(ToolNamePolicy::isTask) == true
}

/**
 * Task descriptions take priority over result content. Legacy branches without
 * a Task use a short plain label, matching Harmony's subagent title policy.
 */
private fun subagentTitle(entry: ChatMessageItemResponse): String {
    val tool = entry.tool
    val task = tool?.let(ToolNamePolicy::isTask) == true
    if (task) {
        plainSubagentLabel(ToolInputPolicy.taskTitle(tool)).takeIf(String::isNotEmpty)?.let { return it }
    }
    val content = plainSubagentLabel(entry.content.orEmpty())
    if (content.isNotEmpty() && content.length <= TITLE_LIMIT) return content
    return if (tool != null && !task) plainSubagentLabel(tool.name.orEmpty()) else ""
}

private fun subagentBody(entry: ChatMessageItemResponse): String {
    if (entry.tool?.let(ToolNamePolicy::isTask) == true) return ""
    val content = plainSubagentLabel(entry.content.orEmpty())
    return content.takeUnless { it == subagentTitle(entry) }.orEmpty()
}

private fun plainSubagentLabel(raw: String): String {
    var text = raw.trim()
    for (wrapper in listOf("**", "__", "`", "*", "_")) {
        if (text.length > wrapper.length * 2 && text.startsWith(wrapper) && text.endsWith(wrapper)) {
            text = text.substring(wrapper.length, text.length - wrapper.length).trim()
            break
        }
    }
    while (text.startsWith("#")) text = text.drop(1).trim()
    return text
}

private val SUBAGENT_RUNNING = setOf("running", "active", "preparing", "pending", "queued")

private const val TITLE_LIMIT = 80
private val TEXT_TYPES = setOf("text", "message", "")
private val SUBAGENT_TYPES = setOf("subagent", "agent")

/** Legacy completion records can omit the invocation fields already in the nested copy. */
private fun mergeChildTool(previous: RemoteToolStatusResponse?, incoming: RemoteToolStatusResponse): RemoteToolStatusResponse =
    incoming.copy(
        id = incoming.id ?: previous?.id,
        name = incoming.name ?: previous?.name,
        status = incoming.status ?: previous?.status,
        durationMs = incoming.durationMs ?: previous?.durationMs,
        startMs = incoming.startMs ?: previous?.startMs,
        inputPreview = incoming.inputPreview ?: previous?.inputPreview,
        toolInput = incoming.toolInput ?: previous?.toolInput,
        stdout = incoming.stdout ?: previous?.stdout,
        stderr = incoming.stderr ?: previous?.stderr,
        toolOutput = incoming.toolOutput ?: previous?.toolOutput,
        resultPreview = incoming.resultPreview ?: previous?.resultPreview,
        errorPreview = incoming.errorPreview ?: previous?.errorPreview,
        exitCode = incoming.exitCode ?: previous?.exitCode,
        plan = incoming.plan ?: previous?.plan,
    )
