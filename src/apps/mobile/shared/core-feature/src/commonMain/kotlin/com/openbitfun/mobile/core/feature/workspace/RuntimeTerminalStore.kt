package com.openbitfun.mobile.core.feature.workspace

import com.openbitfun.mobile.core.persistence.RelayStreamStore
import com.openbitfun.mobile.core.feature.relay.PersistentSessionReplica
import com.openbitfun.mobile.core.protocol.isError
import com.openbitfun.mobile.core.protocol.CommandStatus
import com.openbitfun.mobile.core.protocol.RemoteCommand
import com.openbitfun.mobile.core.protocol.RelayJson
import com.openbitfun.mobile.core.transport.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

public data class RuntimeTerminalUiState public constructor(
    public val sessionId: String?, public val output: String, public val busy: Boolean, public val failed: Boolean,
    public val revision: Long, public val chunk: String, public val reset: Boolean,
    public val errorDetail: String?,
) {
    public constructor(sessionId: String?, output: String, busy: Boolean, failed: Boolean, revision: Long, chunk: String, reset: Boolean) : this(sessionId, output, busy, failed, revision, chunk, reset, null)
    public constructor(sessionId: String?, output: String, busy: Boolean, failed: Boolean) : this(sessionId, output, busy, failed, 0, "", true)
}

@Serializable
private data class HostResult(override val resp: String? = null, override val message: String? = null,
    val ok: Boolean = false, val value: JsonElement = JsonNull, val error: String? = null) : CommandStatus

internal class RuntimeTerminalStore(private val scope: CoroutineScope, private val transport: RemoteCommandTransport,
    private val persistence: RelayStreamStore?) {
    private val mutable = MutableStateFlow(RuntimeTerminalUiState(null, "", false, false))
    val state = mutable.asStateFlow()
    private var owner: Job? = null
    private var action: Job? = null
    private var inputJob: Job? = null
    private var resizeJob: Job? = null
    private var pendingInput = ""
    private var pendingSize: Pair<Int, Int>? = null
    private var historyFailureActive = false
    private fun failHistory(error: Throwable) { historyFailureActive = true; mutable.value = mutable.value.copy(failed = true, errorDetail = error.message) }
    private fun failAction(error: Throwable) { historyFailureActive = false; mutable.value = mutable.value.copy(failed = true, errorDetail = error.message) }
    private var epoch = 0L
    private var location: Pair<String, String?>? = null
    private suspend fun invoke(command: String, args: JsonObject, structured: Boolean = true): JsonElement {
        val result = transport.send<HostResult>(RemoteCommand(cmd = "host_invoke", command = command,
            args = if (structured) buildJsonObject { put("request", args) } else args))
        check(result.ok && !result.isError) { result.error?.takeIf { it.isNotBlank() } ?: result.message?.takeIf { it.isNotBlank() } ?: "Host terminal operation failed" }
        return result.value
    }
    fun open(path: String, connectionId: String?) {
        if (mutable.value.busy || mutable.value.sessionId != null) return
        location = path to connectionId
        mutable.value = mutable.value.copy(busy = true, failed = false, errorDetail = null)
        val ticket = epoch
        action = scope.launch {
            try {
                val result = invoke("terminal_create", buildJsonObject {
                    put("workingDirectory", path); put("connectionId", connectionId.orEmpty())
                    put("cols", 80); put("rows", 24); put("source", "user")
                }).jsonObject
                if (ticket != epoch) return@launch
                val id = result.getValue("id").jsonPrimitive.content
                mutable.value = RuntimeTerminalUiState(id, "", false, false)
                observe(id)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Throwable) { if (ticket == epoch) { failAction(error); mutable.value = mutable.value.copy(busy = false) } }
        }
    }
    private fun observe(id: String) {
        val ticket = epoch
        fun isCurrent(): Boolean = ticket == epoch && mutable.value.sessionId == id
        owner?.cancel()
        owner = scope.launch {
            try {
                val source = transport as? RemoteSessionStreamTransport ?: error("Session stream unavailable")
                val store = persistence ?: error("Persistent session replica unavailable")
                val stream = source.streamIdentity + ":terminal:" + id
                val replica = PersistentSessionReplica(store, stream)
                var offset = 0L
                suspend fun refresh() {
                    do {
                        if (!isCurrent()) return
                        val page = invoke("terminal_get_history", buildJsonObject { put("sessionId", id); put("afterOffset", offset) }, false).jsonObject
                        if (!isCurrent()) return
                        val next = page.getValue("nextOffset").jsonPrimitive.long
                        val cursor = page.getValue("cursor").jsonPrimitive.long
                        val truncated = page["truncated"]?.jsonPrimitive?.boolean == true
                        check(next >= 0 && cursor >= next) { "Invalid terminal history cursor" }
                        check(next >= offset || truncated) { "Terminal cursor moved backwards" }
                        check(next > offset || (truncated && next < offset) || next == cursor) { "Terminal history made no progress" }
                        val data = page.getValue("data").jsonPrimitive.content
                        if (historyFailureActive) {
                            historyFailureActive = false
                            mutable.value = mutable.value.copy(failed = false, errorDetail = null)
                        }
                        if (data.isNotEmpty() || truncated) {
                            // Local replay is bounded like the runtime ring; live rendering receives only this delta.
                            var replay = ((if (truncated) "" else mutable.value.output) + data).takeLast(4 * 1024 * 1024)
                            if (replay.firstOrNull()?.isLowSurrogate() == true) replay = replay.drop(1)
                            mutable.value = mutable.value.copy(output = replay, revision = mutable.value.revision + 1, chunk = data, reset = truncated)
                        }
                        offset = next
                    } while (next < cursor)
                }
                var caughtUp = false
                val refreshRequests = kotlinx.coroutines.channels.Channel<Unit>(kotlinx.coroutines.channels.Channel.CONFLATED)
                launch { for (request in refreshRequests) {
                    try { refresh() }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (error: Throwable) { if (isCurrent()) failHistory(error) }
                } }
                source.subscribe("terminal-$id", replica, { error -> if (isCurrent()) failHistory(error) }, {
                    if (isCurrent() && !caughtUp) { caughtUp = true; refreshRequests.trySend(Unit) }
                }).collect { event ->
                    if (isCurrent() && caughtUp && event["event"]?.jsonPrimitive?.content in setOf("terminal-output", "relay://session-resumed")) refreshRequests.trySend(Unit)
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Throwable) { if (isCurrent()) failHistory(error) }
        }
    }
    fun write(data: String) {
        val id = mutable.value.sessionId ?: return
        if (data.isEmpty()) return
        val ticket = epoch
        pendingInput += data
        if (inputJob?.isActive == true) return
        inputJob = scope.launch {
            delay(8)
            while (pendingInput.isNotEmpty() && ticket == epoch && mutable.value.sessionId == id) {
                val batch = pendingInput; pendingInput = ""
                try { invoke("terminal_write", buildJsonObject { put("sessionId", id); put("data", batch) }) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Throwable) { if (ticket == epoch) { pendingInput = ""; failAction(error) }; break }
            }
        }
    }
    fun resize(cols: Int, rows: Int) {
        val id = mutable.value.sessionId ?: return
        if (cols <= 0 || rows <= 0) return
        val ticket = epoch; pendingSize = cols to rows
        if (resizeJob?.isActive == true) return
        resizeJob = scope.launch {
            delay(8)
            while (pendingSize != null && ticket == epoch && mutable.value.sessionId == id) {
                val size = pendingSize!!; pendingSize = null
                try { invoke("terminal_resize", buildJsonObject { put("sessionId", id); put("cols", size.first); put("rows", size.second) }) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Throwable) { if (ticket == epoch) failAction(error); break }
            }
        }
    }
    fun close() {
        val id = mutable.value.sessionId ?: return
        if (mutable.value.busy) return
        mutable.value = mutable.value.copy(busy = true)
        val ticket = epoch
        action = scope.launch {
            try {
                invoke("terminal_close", buildJsonObject { put("sessionId", id) })
                if (ticket == epoch) stop(clearLocation = false)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Throwable) { if (ticket == epoch) { failAction(error); mutable.value = mutable.value.copy(busy = false) } }
        }
    }
    fun reopen() {
        val previous = location ?: return
        open(previous.first, previous.second)
    }
    fun stop(clearLocation: Boolean = true) {
        historyFailureActive = false
        if (clearLocation) location = null
        epoch++; owner?.cancel(); action?.cancel(); inputJob?.cancel(); resizeJob?.cancel(); pendingInput = ""; pendingSize = null
        mutable.value = RuntimeTerminalUiState(null, "", false, false)
    }
}
