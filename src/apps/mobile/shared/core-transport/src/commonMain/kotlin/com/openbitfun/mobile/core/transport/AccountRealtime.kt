package com.openbitfun.mobile.core.transport

import io.ktor.client.HttpClient
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import io.ktor.websocket.send
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import org.hildan.socketio.EngineIO
import org.hildan.socketio.EngineIOPacket
import org.hildan.socketio.SocketIOPacket
import kotlin.random.Random

internal const val MAX_ACCOUNT_FRAME_BYTES = 256 * 1024

internal interface AccountRpcConnection {
    val notifications: Flow<JsonObject> get() = emptyFlow()
    val connections: Flow<Long> get() = emptyFlow()
    suspend fun call(target: String, params: JsonElement, timeoutMs: Long): JsonElement
    fun close()
}

/** Happy's user-scoped Socket.IO connection. The codec owns wire framing;
 * this owner owns epochs and never buffers mutations across a reconnect. */
internal class AccountRealtime(
    private val http: HttpClient,
    private val relayUrl: String,
    private val token: String,
    private val log: TransportLog = TransportLog.None,
) : AccountRpcConnection {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val state = MutableStateFlow<Epoch?>(null)
    private val payloads = RpcPayload(http, relayUrl, token)
    private val updates = MutableSharedFlow<JsonObject>(extraBufferCapacity = 100)
    private val generation = MutableStateFlow(0L)
    private val connectionFailure = MutableStateFlow<Throwable?>(null)
    override val notifications: SharedFlow<JsonObject> = updates.asSharedFlow()
    override val connections: StateFlow<Long> = generation.asStateFlow()
    private val owner = scope.launch { supervise() }.also { job ->
        job.invokeOnCompletion { cause ->
            log.info("account realtime owner ended cancelled=${job.isCancelled} cause=${cause?.let { it::class.simpleName } ?: "none"}")
        }
    }

    private class Epoch(val socket: DefaultClientWebSocketSession) {
        val ready = CompletableDeferred<Unit>()
        val mutex = Mutex()
        val pending = mutableMapOf<Int, CompletableDeferred<JsonElement>>()
        var nextId = 0
        var closed = false
        suspend fun fail() = mutex.withLock {
            closed = true
            ready.completeExceptionally(CloudAccountException(CloudAccountFailure.NETWORK))
            pending.values.forEach { it.completeExceptionally(CloudAccountException(CloudAccountFailure.TIMEOUT)) }
            pending.clear()
        }
    }

    override suspend fun call(target: String, params: JsonElement, timeoutMs: Long): JsonElement {
        require(timeoutMs in 1..Int.MAX_VALUE.toLong()) { "Invalid RPC timeout" }
        try {
            if (!owner.isActive) throw CloudAccountException(CloudAccountFailure.AUTHENTICATION)
            val epoch = withTimeout(RELAY_CONNECT_TIMEOUT_MS) {
                state.filterNotNull().first().also { it.ready.await() }
            }
            val wireParams = payloads.uploadIfLarge(params)
            if (!owner.isActive || epoch.closed || state.value !== epoch) throw CloudAccountException(CloudAccountFailure.NETWORK)
            val reply = CompletableDeferred<JsonElement>()
            val id = epoch.mutex.withLock {
                if (epoch.closed || state.value !== epoch) throw CloudAccountException(CloudAccountFailure.NETWORK)
                val id = epoch.nextId++
                epoch.pending[id] = reply
                id
            }
            try {
                val packet = SocketIOPacket.Event("/", id, buildJsonArray {
                    add("rpc-call")
                    add(buildJsonObject { put("method", "$target:invoke"); put("params", wireParams); put("timeoutMs", timeoutMs) })
                })
                // If write or ack fails, execution may already have happened.
                // Only durable writes with a stable localId may be retried.
                val response = withTimeout(timeoutMs) {
                    epoch.socket.send(EngineIO.encodeSocketIO(EngineIOPacket.Message(packet)))
                    val result = reply.await().jsonObject
                    if (result["ok"]?.jsonPrimitive?.booleanOrNull != true) {
                        throw CloudAccountException(CloudAccountFailure.RELAY_UNAVAILABLE)
                    }
                    result["result"] ?: throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE)
                }
                val resolved = payloads.resolve(response)
                if (!owner.isActive || epoch.closed || state.value !== epoch) throw CloudAccountException(CloudAccountFailure.NETWORK)
                return resolved
            } finally {
                withContext(NonCancellable) { epoch.mutex.withLock { epoch.pending.remove(id) } }
            }
        } catch (timeout: TimeoutCancellationException) {
            throw CloudAccountException(CloudAccountFailure.TIMEOUT, null, connectionFailure.value ?: timeout)
        }
    }

    private suspend fun supervise() {
        var delayMs = 1000L
        while (currentCoroutineContext().isActive) {
            var epoch: Epoch? = null
            try {
                val base = requireNotNull(normalizeAccountRelayUrl(relayUrl))
                val url = base.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
                val socket = withTimeout(RELAY_CONNECT_TIMEOUT_MS) {
                    http.webSocketSession("$url/v1/updates/?EIO=4&transport=websocket")
                }
                log.info("account realtime socket opened")
                epoch = Epoch(socket)
                state.value = epoch
                var idleMs = RELAY_CONNECT_TIMEOUT_MS
                var engineOpened = false
                while (currentCoroutineContext().isActive) {
                    val frame = withTimeout(idleMs) { socket.incoming.receive() }
                    if (frame !is Frame.Text || frame.data.size > MAX_ACCOUNT_FRAME_BYTES) {
                        throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE)
                    }
                    when (val packet = EngineIO.decodeSocketIO(frame.readText())) {
                        is EngineIOPacket.Open -> {
                            check(!engineOpened)
                            engineOpened = true
                            require(packet.pingInterval > 0 && packet.pingTimeout > 0)
                            idleMs = packet.pingInterval.toLong() + packet.pingTimeout
                            val auth = buildJsonObject { put("token", token); put("clientType", "user-scoped") }
                            socket.send(EngineIO.encodeSocketIO(EngineIOPacket.Message(SocketIOPacket.Connect("/", auth))))
                        }
                        is EngineIOPacket.Ping -> socket.send(EngineIO.encodeSocketIO(EngineIOPacket.Pong(packet.payload)))
                        is EngineIOPacket.Message -> when (val message = packet.payload) {
                            is SocketIOPacket.Connect -> {
                                check(message.namespace == "/" && engineOpened)
                            }
                            is SocketIOPacket.Ack -> epoch.mutex.withLock {
                                val result = message.payload.singleOrNull()
                                    ?: throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE)
                                epoch.pending.remove(message.ackId)?.complete(result)
                            }
                            is SocketIOPacket.Event -> {
                                val name = message.payload.firstOrNull()?.jsonPrimitive?.content
                                if (name == "auth-ok") {
                                    connectionFailure.value = null
                                    epoch.ready.complete(Unit)
                                    delayMs = 1000
                                    generation.value += 1
                                    log.info("account realtime authenticated generation=${generation.value}")
                                }
                                if (name == "update" || name == "ephemeral") {
                                    val value = message.payload.getOrNull(1)?.jsonObject
                                        ?: throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE)
                                    // Overflow closes this epoch; reconnect triggers durable catch-up.
                                    if (!updates.tryEmit(value)) throw CloudAccountException(CloudAccountFailure.NETWORK)
                                }
                            }
                            is SocketIOPacket.ConnectError -> throw CloudAccountException(CloudAccountFailure.AUTHENTICATION)
                            is SocketIOPacket.Disconnect -> throw CloudAccountException(CloudAccountFailure.NETWORK)
                            else -> throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE)
                        }
                        is EngineIOPacket.Close -> throw CloudAccountException(CloudAccountFailure.NETWORK)
                        else -> throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE)
                    }
                }
            } catch (cancelled: CancellationException) {
                if (cancelled !is TimeoutCancellationException) {
                    log.warn("account realtime receive cancelled ownerActive=${currentCoroutineContext().isActive} cause=${cancelled::class.simpleName}")
                    throw cancelled
                }
                log.warn("account realtime timed out")
            } catch (failure: CloudAccountException) {
                connectionFailure.value = failure
                log.warn("account realtime failed type=${failure::class.simpleName}")
                if (failure.failure == CloudAccountFailure.AUTHENTICATION) return
            } catch (failure: Exception) {
                connectionFailure.value = failure
                log.warn("account realtime failed type=${failure::class.simpleName}")
                // Read/connect failures reconnect. Submitted calls fail in fail().
            } finally {
                val old = epoch
                withContext(NonCancellable) {
                    if (old != null) {
                        state.compareAndSet(old, null)
                        old.fail()
                        withTimeoutOrNull(1000) { old.socket.close() }
                        old.socket.cancel()
                    }
                }
            }
            delay(Random.nextLong(delayMs / 2, delayMs + delayMs / 2 + 1))
            delayMs = (delayMs * 2).coerceAtMost(5000)
        }
    }

    override fun close() {
        log.info("account realtime close requested")
        scope.cancel()
    }
}
