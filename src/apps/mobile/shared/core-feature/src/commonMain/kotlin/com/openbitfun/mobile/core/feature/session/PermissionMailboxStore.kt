package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.protocol.*
import com.openbitfun.mobile.core.transport.*
import kotlinx.coroutines.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

public data class PermissionMailboxRequest public constructor(
    public val requestId: String, public val action: String, public val resources: List<String>,
    public val toolCallId: String?, public val source: String,
)
public data class PermissionMailboxUiState public constructor(
    public val requests: List<PermissionMailboxRequest>, public val busy: Boolean, public val failed: Boolean,
    public val questions: List<ToolCard>,
    public val ownedToolIds: Set<String>,
) {
    public constructor(requests: List<PermissionMailboxRequest>, busy: Boolean, failed: Boolean, questions: List<ToolCard>) :
        this(requests, busy, failed, questions, emptySet())
    public constructor(requests: List<PermissionMailboxRequest>, busy: Boolean, failed: Boolean) : this(requests, busy, failed, emptyList())

    /** A transcript row may show details, but must not duplicate a mailbox action. */
    public fun ownsToolInteraction(toolId: String): Boolean =
        toolId.isNotEmpty() && (toolId in ownedToolIds || questions.any { it.id == toolId } || requests.any { it.toolCallId == toolId })
}
@Serializable
private data class MailboxResult(override val resp: String? = null, override val message: String? = null,
    val ok: Boolean = false, val value: JsonElement = JsonNull) : CommandStatus

/** The runtime owns permissions. Transcript tool identifiers are never reply identities. */
internal class PermissionMailboxStore(private val scope: CoroutineScope, private val transport: RemoteCommandTransport,
    private val publish: (PermissionMailboxUiState) -> Unit) {
    private var state = PermissionMailboxUiState(emptyList(), false, false)
    private var session: String? = null
    private var epoch = 0L
    private var refresh: Job? = null
    private var reply: Job? = null
    private var dirty = false
    private val interacting = mutableSetOf<String>()
    private fun update(next: PermissionMailboxUiState) { state = next; publish(next) }
    fun select(id: String?) {
        if (session == id) return
        epoch++; refresh?.cancel(); reply?.cancel(); refresh = null; reply = null; dirty = false; interacting.clear(); session = id
        update(PermissionMailboxUiState(emptyList(), false, false))
        if (id != null) invalidate()
    }
    private suspend fun invoke(command: String, args: JsonObject): JsonElement {
        val result = transport.send<MailboxResult>(RemoteCommand(cmd = "host_invoke", command = command, args = args))
        check(result.ok && !result.isError) { "Runtime permission request failed" }
        return result.value
    }
    fun invalidate() {
        val selected = session ?: return
        dirty = true
        if (refresh?.isActive == true) return
        val ticket = epoch
        refresh = scope.launch {
            try {
                while (dirty && ticket == epoch) {
                    dirty = false
                    val snapshot = try {
                        invoke("get_session_interaction_mailbox", buildJsonObject { put("request", buildJsonObject { put("sessionId", selected) }) }).jsonObject
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Throwable) {
                        if (ticket != epoch) return@launch
                        // A newer invalidation must survive an older request failure.
                        if (dirty) continue
                        throw error
                    }
                    // An interaction event may invalidate this snapshot while the RPC is
                    // in flight. Keep the last authoritative rows until the newer read
                    // completes, matching Harmony's mailbox version check.
                    if (ticket != epoch) return@launch
                    if (dirty) continue
                    check(snapshot.getValue("sessionId").jsonPrimitive.content == selected) { "Interaction mailbox session mismatch" }
                    val value = snapshot.getValue("permissions").jsonObject.getValue("requests").jsonArray
                    val questions = snapshot.getValue("userQuestions").jsonObject.getValue("questions").jsonArray.map { it.jsonObject }
                        .filter { it["sessionId"]?.jsonPrimitive?.content == selected }.map {
                            toolCard(RemoteToolStatusResponse(id = it.getValue("toolId").jsonPrimitive.content, name = "AskUserQuestion", status = "running", toolInput = it.getValue("questions")))
                        }
                    val requests = value.map { it.jsonObject }.filter { it["sessionId"]?.jsonPrimitive?.content == selected }.map {
                        PermissionMailboxRequest(it.getValue("requestId").jsonPrimitive.content,
                            it.getValue("action").jsonPrimitive.content,
                            it["resources"]?.jsonArray?.map { item -> item.jsonPrimitive.content }.orEmpty(),
                            it["toolCallId"]?.jsonPrimitive?.contentOrNull,
                            (it["source"] as? JsonObject)?.get("identity")?.jsonPrimitive?.contentOrNull.orEmpty())
                    }
                    // Keep ownership after a successful reply removes the mailbox
                    // row: transcript completion may arrive later over another stream.
                    val ownedToolIds = state.ownedToolIds + questions.map { it.id } + requests.mapNotNull { it.toolCallId }
                    if (ticket == epoch) update(state.copy(requests = requests, questions = questions, failed = false, ownedToolIds = ownedToolIds))
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Throwable) { if (ticket == epoch) update(state.copy(failed = true)) }
        }
    }
    fun startQuestion(toolId: String) {
        val selected = session ?: return
        if (state.questions.none { it.id == toolId }) return
        if (!interacting.add(toolId)) return
        val ticket = epoch
        scope.launch {
            if (ticket != epoch) return@launch
            try {
                val result = transport.send<CommandStatusResponse>(RemoteCommand(cmd = "start_question_interaction", sessionId = selected, toolId = toolId))
                check(!result.isError) { result.message ?: "Question interaction failed" }
                if (ticket == epoch) invalidate()
            }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Throwable) { if (ticket == epoch) { interacting.remove(toolId); update(state.copy(failed = true)) } }
        }
    }
    /** Returns false only for questions owned by the legacy transcript path. */
    fun answer(selected: String, toolId: String, answers: JsonObject): Boolean {
        if (session != selected || state.questions.none { it.id == toolId }) return false
        if (state.busy) return true
        val ticket = epoch
        update(state.copy(busy = true, failed = false))
        reply = scope.launch {
            try {
                val result = transport.send<CommandStatusResponse>(RemoteCommand(
                    cmd = "answer_question", sessionId = selected, toolId = toolId, answers = answers))
                check(!result.isError) { "Question answer failed" }
                if (ticket == epoch) {
                    invalidate()
                    refresh?.join()
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Throwable) { if (ticket == epoch) update(state.copy(failed = true)) }
            finally { if (ticket == epoch) update(state.copy(busy = false)) }
        }
        return true
    }

    fun respond(requestId: String, approve: Boolean, updatedInput: String?) {
        if (state.busy || state.requests.none { it.requestId == requestId }) return
        val ticket = epoch
        update(state.copy(busy = true, failed = false))
        reply = scope.launch {
            try {
                val patch = if (approve) updatedInput?.let {
                    Json.parseToJsonElement(it) as? JsonObject ?: error("Input must be an object")
                } else null
                invoke("respond_permission", buildJsonObject { put("request", buildJsonObject {
                    put("requestId", requestId); put("reply", if (approve) "once" else "reject")
                    if (approve && patch != null) put("updatedInput", patch)
                }) })
                if (ticket == epoch) {
                    invalidate()
                    // Keep the mutation busy until the authoritative mailbox refresh
                    // finishes, so stale request rows cannot be submitted again.
                    refresh?.join()
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Throwable) { if (ticket == epoch) update(state.copy(failed = true)) }
            finally { if (ticket == epoch) update(state.copy(busy = false)) }
        }
    }
}
