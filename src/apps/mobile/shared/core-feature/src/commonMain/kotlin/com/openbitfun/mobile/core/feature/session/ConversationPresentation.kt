package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.domain.ChatMessage
import com.openbitfun.mobile.core.domain.ChatTimelineItemType
import com.openbitfun.mobile.core.domain.ChatTimelineProjector
import com.openbitfun.mobile.core.domain.ChatTimelineState
import com.openbitfun.mobile.core.domain.ChatTranscriptOrigin
import com.openbitfun.mobile.core.domain.ToolInputPolicy
import com.openbitfun.mobile.core.domain.ToolQuestionPolicy
import com.openbitfun.mobile.core.domain.ToolStatusPolicy
import com.openbitfun.mobile.core.protocol.ChatMessageItemResponse
import com.openbitfun.mobile.core.protocol.RemoteToolStatusResponse

/** Who a row belongs to, and the one row that belongs to nobody. */
public enum class ConversationRowKind {
    USER,
    ASSISTANT,

    /** The session has no messages at all; apps render their own invitation. */
    EMPTY,
}

/**
 * The state a tool card shows.
 *
 * Named after what the user sees rather than after the relay's status strings,
 * which overlap: `completed` / `done` / `sent` are one state, and confirmation
 * arrives as either `pending_confirmation` or `needs_confirmation`.
 */
public enum class ToolPhase {
    PENDING_CONFIRMATION,
    RUNNING,
    COMPLETED,
    CANCELLED,
    FAILED,

    /** Queued behind another tool, or a status this client has not seen before. */
    WAITING,
}

/** What the user may do to a tool right now. */
public enum class ToolAction {
    APPROVE,
    REJECT,

    /** Stop a tool that is already running. */
    CANCEL,

    /** Reply to `AskUserQuestion`, which takes an answer rather than a verdict. */
    ANSWER,
}

public data class ConversationImage public constructor(
    public val name: String,
    public val dataUrl: String,
)

public data class ToolCard public constructor(
    public val id: String,
    public val name: String,
    public val phase: ToolPhase,
    /** The picture the row leads with. */
    public val kind: ToolKind,
    /** What the row says is happening; [ToolOperation.UNKNOWN] falls back to [name]. */
    public val operation: ToolOperation,
    /**
     * What the tool is acting on — a file's name, a command, a pattern — already
     * shortened to one line. Empty when the input added nothing to [operation].
     */
    public val target: String,
    /** The file to open when the row is tapped; empty when there is none. */
    public val filePath: String,
    /** What to call [filePath] on screen; empty exactly when it is. */
    public val fileLabel: String,
    /** What the tool was asked to do; empty when the agent sent no preview. */
    public val input: String,
    /** Result, error and streams, capped so one tool cannot fill the screen. */
    public val output: String,
    /**
     * Non-null only when the tool is waiting for an answer rather than a verdict.
     *
     * Null while [actions] contains [ToolAction.ANSWER] means the agent sent no
     * preview to quote — the app asks in its own words.
     */
    public val question: String?,
    public val questions: List<ToolQuestion>,
    public val actions: Set<ToolAction>,
    public val expandable: Boolean,
) {
    public val plan: PlanToolDescriptor?
        get() = PlanToolPolicy.descriptor(name, input, filePath)

    /** Whether a finished tool can join the compact consecutive-activity summary. */
    public val foldIntoSummary: Boolean
        get() {
            if (actions.isNotEmpty() || kind == ToolKind.QUESTION) return false
            if (phase !in setOf(ToolPhase.COMPLETED, ToolPhase.CANCELLED, ToolPhase.FAILED)) return false
            val normalizedName = name.filterNot { it == '_' || it == '-' || it.isWhitespace() }.lowercase()
            val planWrite = normalizedName in setOf("write", "writefile", "createfile") &&
                filePath.lowercase().endsWith(".plan.md")
            return normalizedName != "createplan" && !planWrite
        }

    public constructor(
        id: String,
        name: String,
        phase: ToolPhase,
        kind: ToolKind,
        operation: ToolOperation,
        target: String,
        filePath: String,
        fileLabel: String,
        input: String,
        output: String,
        question: String?,
        actions: Set<ToolAction>,
    ) : this(
        id,
        name,
        phase,
        kind,
        operation,
        target,
        filePath,
        fileLabel,
        input,
        output,
        question,
        emptyList(),
        actions,
        expandable = phase != ToolPhase.WAITING || ToolAction.ANSWER in actions,
    )
}

/**
 * One bubble in the conversation.
 *
 * Everything an app needs to draw a turn, with no relay vocabulary left in it —
 * the wording for each state lives in the app's resources (design doc §4.3).
 */
public data class ConversationRow public constructor(
    public val id: String,
    public val kind: ConversationRowKind,
    public val text: String,
    /** The model's reasoning, when it sent any; apps collapse this by default. */
    public val thinking: String?,
    public val images: List<ConversationImage>,
    public val tools: List<ToolCard>,
    /**
     * The turn in the order the agent produced it, or empty when it has no such
     * structure.
     *
     * Empty is the ordinary case for a user message and for an agent that only
     * answered: the app draws [text], [thinking] and [tools] instead. When this
     * is populated it *replaces* those three — everything in them is already in
     * here, in the right place.
     */
    public val blocks: List<MessageBlock>,
    /** Tokens are still arriving, so the text will grow. */
    public val streaming: Boolean,
    /** Streaming, with nothing to show yet; apps draw the waiting indicator. */
    public val typing: Boolean,
    /** The send failed and this is the row a retry would repeat. */
    public val showRetry: Boolean,
    /** A user-visible assistant failure returned by the desktop. */
    public val error: String?,
    /** This is the current turn, including its finalizing snapshot before persistence. */
    public val live: Boolean,
    public val timestampMs: Long?,
)

/**
 * The conversation as rows, deduplicated and ordered.
 *
 * Goes through [ChatTimelineProjector] rather than reading the lists directly:
 * that is what drops the seed message, hides an active turn the desktop has
 * already persisted, and keeps an optimistic message on screen exactly until its
 * persisted twin arrives. Reading `persistedMessages` alone would both lose
 * messages in flight and show finished ones twice.
 */
public fun ChatTimelineState.conversationRows(): List<ConversationRow> =
    ChatTimelineProjector.project(
        persistedMessages,
        optimisticMessages,
        activeTurn,
        // The app pages the session list, not the message list, so an empty
        // timeline here really is an empty session.
        false,
        activeTurnAnchorId,
    ).map { item ->
        val message = item.message
        ConversationRow(
            id = item.id,
            kind = when (item.type) {
                ChatTimelineItemType.USER_MESSAGE,
                ChatTimelineItemType.OPTIMISTIC_USER_MESSAGE,
                -> ConversationRowKind.USER

                ChatTimelineItemType.ASSISTANT_MESSAGE,
                ChatTimelineItemType.ASSISTANT_LIVE_TURN,
                -> ConversationRowKind.ASSISTANT

                ChatTimelineItemType.EMPTY_STATE -> ConversationRowKind.EMPTY
            },
            text = message?.let(::displayText).orEmpty(),
            thinking = message?.thinking?.trim()?.takeIf(String::isNotEmpty),
            images = message?.images.orEmpty().map { ConversationImage(it.name, it.dataUrl) },
            tools = message?.let(::toolCards).orEmpty(),
            blocks = message?.let { messageBlocks(it, item.isStreaming) }.orEmpty(),
            live = item.type == ChatTimelineItemType.ASSISTANT_LIVE_TURN,
            streaming = item.isStreaming,
            typing = message?.let { isTyping(it, item.isStreaming) } == true,
            showRetry = item.showRetryAction,
            error = message?.error?.trim()?.takeIf(String::isNotEmpty),
            timestampMs = message?.timestamp?.let(SessionTimePresentation::timestampMs),
        )
    }

/**
 * Whether this timeline is still the copy this device stored, rather than the
 * host's answer for the session.
 *
 * The stored copy is worth showing at once, but it stops wherever the last write
 * stopped — inside whatever turn was running when the app went away — so a wait
 * for "the transcript" ends on the host's answer rather than on rows, and rows
 * already on screen are labelled unconfirmed until it arrives.
 */
public fun ChatTimelineState.transcriptUnconfirmed(): Boolean =
    origin != ChatTranscriptOrigin.HOST

/**
 * What to print for a message.
 *
 * Some agents leave `text` empty and put the answer in the item list instead, so
 * the last plain item stands in. Reasoning is skipped here because it has its
 * own slot; printing it twice is how it looked before the split.
 */
private fun displayText(message: ChatMessage): String {
    val text = message.text.trim()
    if (text.isNotEmpty() && text != message.thinking.orEmpty().trim()) return text
    return lastPlainItem(message.items.orEmpty())
}

private fun lastPlainItem(items: List<ChatMessageItemResponse>): String {
    for (item in items.asReversed()) {
        val type = item.type.orEmpty().lowercase()
        val content = item.content.orEmpty().trim()
        if (
            content.isNotEmpty() &&
            item.tool == null &&
            item.isSubagent != true &&
            type !in NON_TEXT_ITEM_TYPES
        ) {
            return content
        }
    }
    return ""
}

/**
 * Every tool attached to a message, including the ones nested in its items.
 *
 * The relay reports a turn's tools twice — flat in `tools` and inline in
 * `items` — and which one is populated depends on the agent, so both are read
 * and merged by id.
 */
private fun toolCards(message: ChatMessage): List<ToolCard> {
    val seen = LinkedHashMap<String, RemoteToolStatusResponse>()
    var anonymous = 0
    fun add(tool: RemoteToolStatusResponse) {
        val key = tool.id?.takeIf(String::isNotEmpty) ?: "anonymous-${anonymous++}"
        // Later wins: the inline copy in `items` is the one the agent updates.
        seen[key] = tool
    }
    message.tools.orEmpty().forEach(::add)
    fun walk(items: List<ChatMessageItemResponse>) {
        items.forEach { item ->
            item.tool?.let(::add)
            item.subItems?.let(::walk)
        }
    }
    walk(message.items.orEmpty())
    return seen.values.map(::toolCard)
}

internal fun toolCard(tool: RemoteToolStatusResponse): ToolCard {
    val question = if (ToolStatusPolicy.isQuestion(tool)) {
        ToolStatusPolicy.questionPrompt(tool)
    } else {
        null
    }
    val questions = if (ToolStatusPolicy.isQuestion(tool)) {
        ToolQuestionPolicy.parse(tool).map { spec ->
            ToolQuestion(
                index = spec.index,
                header = spec.header,
                question = spec.question,
                options = spec.options.map { QuestionOption(it.label, it.description) },
                multiSelect = spec.multiSelect,
            )
        }
    } else {
        emptyList()
    }
    // Every action is addressed by tool id, so a tool without one gets none of
    // them: offering a button that cannot be delivered is worse than offering
    // nothing. The phase below is still shown, because that much is knowable.
    val actions = if (tool.id.isNullOrEmpty()) {
        emptySet()
    } else {
        buildSet {
            if (ToolStatusPolicy.isPendingConfirmation(tool)) {
                add(ToolAction.APPROVE)
                add(ToolAction.REJECT)
            }
            if (ToolStatusPolicy.isQuestion(tool)) add(ToolAction.ANSWER)
            if (ToolStatusPolicy.isRunning(tool)) add(ToolAction.CANCEL)
        }
    }
    val file = ToolInputPolicy.fileTarget(tool)
    val planInput = tool.plan?.toString() ?: ToolStatusPolicy.inputText(tool)
    val plan = PlanToolPolicy.descriptor(if (tool.plan != null) "CreatePlan" else tool.name.orEmpty(), planInput, file?.path.orEmpty())
    return ToolCard(
        id = tool.id.orEmpty(),
        name = if (tool.plan != null) "CreatePlan" else tool.name.orEmpty(),
        phase = toolPhase(tool),
        kind = toolKind(tool),
        operation = toolOperation(tool),
        target = ToolInputPolicy.summary(tool),
        filePath = plan?.path ?: file?.path.orEmpty(),
        fileLabel = file?.label.orEmpty(),
        input = planInput,
        output = ToolStatusPolicy.outputText(tool),
        question = question,
        questions = questions,
        actions = actions,
        expandable = ToolStatusPolicy.isExpandable(tool),
    )
}

/**
 * Failure is checked first because a tool can report `completed` and still have
 * written to `stderr`; the HarmonyOS card treats that as an error too.
 */
private fun toolPhase(tool: RemoteToolStatusResponse): ToolPhase = when {
    ToolStatusPolicy.isFailed(tool) -> ToolPhase.FAILED
    ToolStatusPolicy.isCancelled(tool) -> ToolPhase.CANCELLED
    ToolStatusPolicy.isRunning(tool) -> ToolPhase.RUNNING
    ToolStatusPolicy.isPendingConfirmation(tool) -> ToolPhase.PENDING_CONFIRMATION
    ToolStatusPolicy.isCompleted(tool) -> ToolPhase.COMPLETED
    else -> ToolPhase.WAITING
}

private val NON_TEXT_ITEM_TYPES = setOf("thinking", "tool", "subagent", "agent")
