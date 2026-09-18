package com.openbitfun.mobile.core.transport

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.jsonObject
import com.openbitfun.mobile.core.protocol.CommandStatusResponse

import com.openbitfun.mobile.core.crypto.CloudAccountCipher
import com.openbitfun.mobile.core.crypto.DeviceIdentity
import com.openbitfun.mobile.core.protocol.CommandStatus
import com.openbitfun.mobile.core.protocol.EncryptedPayload
import com.openbitfun.mobile.core.protocol.RelayJson
import com.openbitfun.mobile.core.protocol.RemoteCommand
import com.openbitfun.mobile.core.protocol.isError
import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpRequestTimeoutException
import io.ktor.client.request.accept
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import io.ktor.client.plugins.timeout
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.MissingFieldException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.coroutines.CancellationException
import kotlin.io.encoding.Base64
import kotlin.uuid.Uuid
import kotlin.uuid.ExperimentalUuidApi

public const val DEFAULT_CLOUD_RELAY_URL: String = "https://remote.openbitfun.com/v/1.0.2"

/** Device kinds the relay accepts; mirrors `relay-service/src/db.rs::DEVICE_KINDS`. */
private const val DEVICE_KIND_DESKTOP = "desktop"

/**
 * What this client registers itself as. Constant rather than a parameter: the
 * shared transport only ships inside the Android and iOS apps, and a desktop
 * never reaches the relay through it.
 */
private const val DEVICE_KIND_MOBILE = "mobile"

/**
 * Names used by our pre-`device_kind` mobile clients.
 *
 * This belongs to the shared transport rather than an Android/iOS adapter: both
 * native clients can receive the same legacy account rows, and both must hide
 * them from the desktop target picker.
 */
private val KNOWN_NON_DESKTOP_DEVICE_NAMES = setOf(
    "HarmonyOS Phone",
    "HarmonyOS Watch",
)

/**
 * Whether a relay device row is a desktop, and so controllable from a phone.
 *
 * A row that reports its kind is taken at its word. A row without one predates
 * the relay learning about kinds, and is judged by two weaker signals: this
 * phone's own row is never a desktop, and neither is one carrying a name our
 * own builds register under. Anything else stays visible — hiding a real
 * desktop would strand the user, while a stale phone row disappears the next
 * time that phone logs in against a relay that stores kinds.
 */
private fun AccountDeviceWire.isDesktop(
    selfDeviceId: String,
    isLegacyMobileDeviceName: (String) -> Boolean,
): Boolean {
    val kind = deviceKind?.trim().orEmpty()
    if (kind.isNotEmpty()) return kind == DEVICE_KIND_DESKTOP
    if (selfDeviceId.isNotEmpty() && deviceId == selfDeviceId) return false
    return !isLegacyMobileDeviceName(deviceName)
}

public enum class CloudAccountFailure {
    INVALID_CREDENTIALS,
    AUTHENTICATION,
    RATE_LIMITED,
    RELAY_UNAVAILABLE,
    NETWORK,

    /**
     * The request left, and nothing came back before [timeoutMs] ran out.
     *
     * Separate from [NETWORK] because the two ask for different things: a
     * network error means try again, a timeout on a device RPC usually means the
     * desktop is working on something big and the wait was too short.
     */
    TIMEOUT,
    MALFORMED_RESPONSE,
}

public class CloudAccountException public constructor(
    public val failure: CloudAccountFailure,
    public val statusCode: Int?,
    cause: Throwable?,
) : IllegalStateException("Cloud account request failed: $failure", cause) {
    public constructor(failure: CloudAccountFailure, statusCode: Int?) : this(failure, statusCode, null)

    public constructor(failure: CloudAccountFailure) : this(failure, null, null)
}

public data class CloudAccountSession public constructor(
    public val token: String,
    public val userId: String,
    public val masterKey: ByteArray,
) {
    override fun toString(): String = "CloudAccountSession(token=<redacted>, userId=$userId, masterKey=<redacted>)"
}

public data class CloudAccountDevice public constructor(
    public val deviceId: String,
    public val deviceName: String,
    public val online: Boolean,
    public val lastSeenAt: Long?,
    /** `desktop`, or null for a row the relay stored before kinds existed. */
    public val deviceKind: String? = null,
)

public class CloudAccountClient internal constructor(
    private val client: HttpClient,
    private val log: TransportLog = TransportLog.None,
    legacyMobileDeviceNames: Set<String> = emptySet(),
    private val realtimeFactory: (HttpClient, String, String) -> AccountRpcConnection = { client, url, token -> AccountRealtime(client, url, token, log) },
) {
    private class Connection(val url: String, val token: String, val socket: AccountRpcConnection)
    private val realtime = MutableStateFlow<Connection?>(null)

    private fun connection(relayUrl: String, token: String): AccountRpcConnection {
        val url = requireNotNull(normalizeAccountRelayUrl(relayUrl))
        while (true) {
            val current = realtime.value
            if (current != null && current.url == url && current.token == token) return current.socket
            val next = Connection(url, token, realtimeFactory(client, url, token))
            if (realtime.compareAndSet(current, next)) {
                current?.socket?.close()
                return next.socket
            }
            next.socket.close()
        }
    }

    /** Retain the closed binding so stale transports cannot reopen a signed-out account. */
    private val historyReaders = mutableMapOf<String, Channel<CompletableDeferred<Unit>>>()
    public suspend fun loadOlderSession(targetDeviceId: String, sessionId: String) {
        val channel = historyReaders[targetDeviceId + ":" + sessionId] ?: error("Session is not subscribed")
        val request = CompletableDeferred<Unit>()
        channel.send(request)
        request.await()
    }
    private val foregroundResumes = MutableSharedFlow<Long>(extraBufferCapacity = 1)
    public fun resumeSessionStreams() { foregroundResumes.tryEmit(0L) }

    /** Directory changes are invalidation hints, never a substitute for authenticated membership. */
    public fun deviceDirectoryChanges(relayUrl: String, session: CloudAccountSession): kotlinx.coroutines.flow.Flow<Unit> {
        val socket = connection(relayUrl, session.token)
        return merge(socket.notifications.filter { it["type"]?.jsonPrimitive?.contentOrNull == "device-presence" }.map { Unit },
            socket.connections.drop(1).map { Unit })
    }

    public fun closeAccount() { forgetPeerKeys(); realtime.value?.socket?.close() }

    private val normalizedLegacyMobileDeviceNames =
        (KNOWN_NON_DESKTOP_DEVICE_NAMES + legacyMobileDeviceNames).mapTo(mutableSetOf()) {
            it.trim().lowercase()
        }

    public suspend fun startAuthorization(relayUrl: String): GitHubAuthorization = request(
        relayUrl, "/api/auth/github/start?methods=all", HttpMethod.Post,
        JsonObject.serializer(), JsonObject(emptyMap()), GitHubAuthorization.serializer(), "", RELAY_DEFAULT_TIMEOUT_MS,
    ).also {
        val url = io.ktor.http.Url(it.authorizationUrl)
        require(url.protocol.name == "https" && ((url.host == "github.com" && url.encodedPath == "/login/oauth/authorize") || (url.host == "auth.openbitfun.com" && url.encodedPath == "/sign-in")) && url.port == 443 && url.user == null && url.password == null)
    }

    public suspend fun pollAuthorization(relayUrl: String, start: GitHubAuthorization): GitHubAuthorizationPoll = request(
        relayUrl, "/api/auth/github/poll", HttpMethod.Post,
        GitHubPollRequest.serializer(), GitHubPollRequest(start.transactionId, start.transactionSecret),
        GitHubAuthorizationPoll.serializer(), "", RELAY_DEFAULT_TIMEOUT_MS,
    )

    @OptIn(ExperimentalUuidApi::class)
    public suspend fun login(relayUrl: String, accessToken: String, deviceId: String, deviceName: String, deviceSecret: ByteArray): CloudAccountSession {
        require(accessToken.isNotBlank())
        require(deviceSecret.size == 32) { "Invalid device key." }
        val secret = deviceSecret.copyOf()
        try {
            val auth = request(
                relayUrl, "/api/auth/login", HttpMethod.Post,
                LoginRequest.serializer(), LoginRequest(accessToken, deviceId, deviceName, DEVICE_KIND_MOBILE,
                    Base64.Default.encode(DeviceIdentity.publicKey(secret)), Uuid.random().toString()),
                AccountAuthResponse.serializer(), "", RELAY_DEFAULT_TIMEOUT_MS,
            )
            if (auth.token.isBlank() || auth.userId.isBlank()) throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE)
            return CloudAccountSession(auth.token, auth.userId, secret)
        } catch (cause: Throwable) { secret.fill(0); throw cause }
    }

    /**
     * The account's controllable devices — desktops only.
     *
     * A relay that stores device kinds already filters this list; the client
     * repeats the judgement so a phone stops listing itself and its peers
     * before that relay is deployed. [selfDeviceId] is this install's own id.
     */
    public suspend fun listDevices(
        relayUrl: String,
        session: CloudAccountSession,
        selfDeviceId: String = "",
    ): List<CloudAccountDevice> =
        requestWithoutBody(
            relayUrl,
            "/api/devices",
            HttpMethod.Get,
            ListSerializer(AccountDeviceWire.serializer()),
            session.token,
            RELAY_DEFAULT_TIMEOUT_MS,
        ).filter { device ->
            device.isDesktop(selfDeviceId) { name ->
                name.trim().lowercase() in normalizedLegacyMobileDeviceNames
            }
        }.map { device ->
            CloudAccountDevice(
                device.deviceId,
                device.deviceName.ifEmpty { device.deviceId },
                device.online,
                device.lastSeenAt,
                device.deviceKind,
            )
        }

    /**
     * Opens one host-owned stream on [targetDeviceId], read on demand over
     * encrypted device RPC. The relay forwards ciphertext only, and nothing is
     * written on this device: the transcript lives exactly as long as the flow.
     */
    public suspend fun subscribeSession(
        relayUrl: String, session: CloudAccountSession, targetDeviceId: String, sessionId: String,
        onError: (Throwable) -> Unit, onCaughtUp: () -> Unit,
    ): kotlinx.coroutines.flow.Flow<JsonObject> {
        val socket = connection(relayUrl, session.token)
        val target = targetDeviceId.trim()
        val historyKey = target + ":" + sessionId
        val historyRequests = Channel<CompletableDeferred<Unit>>(Channel.RENDEZVOUS)
        historyReaders[historyKey] = historyRequests
        val hints = socket.notifications.mapNotNull { notice -> decodeStreamHint(relayUrl, session, target, notice) }
        val reads = object : HostStreamReads {
            override suspend fun read(after: Long?, before: Long?, epoch: Long?): StreamPageWire {
                check(realtime.value?.socket === socket) { "Account changed" }
                return deviceRpc(relayUrl, session, target,
                    RemoteCommand(cmd = "read_stream", streamId = sessionId, after = after, before = before, epoch = epoch, subscribe = true),
                    StreamPageWire.serializer(), RELAY_DEFAULT_TIMEOUT_MS)
            }
            override suspend fun unsubscribe() {
                if (realtime.value?.socket !== socket) return
                deviceRpc(relayUrl, session, target, RemoteCommand(cmd = "unsubscribe_stream", streamId = sessionId),
                    CommandStatusResponse.serializer(), RELAY_DEFAULT_TIMEOUT_MS)
            }
        }
        return hostStream(sessionId, target, hints, merge(socket.connections.drop(1), foregroundResumes), reads,
            olderRequests = historyRequests, onError = { error ->
                log.warn("host stream read failed stream=${sessionId.take(24)} type=${error::class.simpleName} failure=${(error as? CloudAccountException)?.failure}")
                onError(error)
            }, onCaughtUp = onCaughtUp).onCompletion { cause ->
                log.info("host stream ended stream=${sessionId.take(24)} cause=${cause?.let { it::class.simpleName } ?: "none"}")
                if (historyReaders[historyKey] === historyRequests) historyReaders.remove(historyKey)
                historyRequests.close()
            }
    }

    /**
     * Decrypts a relayed `device-event` from [target]; null for presence
     * notices, events from other devices, and anything that is not a stream
     * hint. A hint that cannot be decrypted is dropped: the next keepalive or
     * reconnect re-reads the host anyway.
     */
    private suspend fun decodeStreamHint(relayUrl: String, session: CloudAccountSession, target: String, notice: JsonObject): StreamHint? {
        if (notice["type"]?.jsonPrimitive?.contentOrNull != "device-event") return null
        val source = notice["sourceDeviceId"]?.jsonPrimitive?.contentOrNull ?: return null
        if (source != target) return null
        val params = notice["params"] as? JsonObject ?: return null
        val envelope = try { RelayJson.decodeFromJsonElement(EncryptedPayload.serializer(), params) } catch (_: Throwable) { return null }
        return try {
            val key = peerMessageKey(relayUrl, session, target)
            val plain = CloudAccountCipher.decrypt(decode(envelope.encryptedData), key, decode(envelope.nonce)).decodeToString()
            parseStreamHint(source, RelayJson.parseToJsonElement(plain).jsonObject)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            log.warn("device event ignored source=${source.take(12)} reason=${error::class.simpleName}")
            null
        }
    }

    /**
     * Pairwise message keys, cached per relay and peer. Stream reads happen on
     * every hint; fetching the peer's public key each time would double their
     * relay traffic. A decrypt failure evicts the entry so a re-paired desktop
     * is picked up on the next call.
     */
    private val peerKeys = MutableStateFlow<Map<String, ByteArray>>(emptyMap())
    private suspend fun peerMessageKey(relayUrl: String, session: CloudAccountSession, target: String): ByteArray {
        val cacheId = requireNotNull(normalizeAccountRelayUrl(relayUrl)) + "|" + session.userId + "|" + target
        peerKeys.value[cacheId]?.let { return it }
        val peer = requestWithoutBody(relayUrl,
            "/api/devices/" + encodePathSegment(target) + "/key", HttpMethod.Get,
            DeviceKeyWire.serializer(), session.token, RELAY_DEFAULT_TIMEOUT_MS)
        val key = DeviceIdentity.messageKey(session.masterKey, decode(peer.publicKey))
        peerKeys.update { it + (cacheId to key) }
        return key
    }
    private fun forgetPeerKeys() { peerKeys.value = emptyMap() }

    public suspend fun <T : CommandStatus> deviceRpc(
        relayUrl: String,
        session: CloudAccountSession,
        targetDeviceId: String,
        command: RemoteCommand,
        deserializer: DeserializationStrategy<T>,
        timeoutMs: Long,
    ): T {
        val target = targetDeviceId.trim()
        if (target.isEmpty()) throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE)
        val socket = connection(relayUrl, session.token)
        val messageKey = peerMessageKey(relayUrl, session, target)
        val nonce = DeviceIdentity.randomBytes(12)
        val plain = RelayJson.encodeToString(RemoteCommand.serializer(), command).encodeToByteArray()
        val encrypted = CloudAccountCipher.encrypt(plain, messageKey, nonce)
        val payload = EncryptedPayload(Base64.Default.encode(encrypted), Base64.Default.encode(nonce))
        val response = RelayJson.decodeFromJsonElement(EncryptedPayload.serializer(),
            socket.call(target,
                RelayJson.encodeToJsonElement(EncryptedPayload.serializer(), payload), timeoutMs))
        val decoded = try {
            CloudAccountCipher.decrypt(
                decode(response.encryptedData),
                messageKey,
                decode(response.nonce),
            ).decodeToString()
        } catch (error: CloudAccountException) {
            throw error
        } catch (cause: Throwable) {
            forgetPeerKeys()
            log.error("device rpc undecryptable cmd=${command.cmd} reason=${cause::class.simpleName}")
            throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE, null, cause)
        }
        return try {
            RelayJson.decodeFromString(deserializer, decoded)
        } catch (cause: Throwable) {
            log.error("device rpc undecodable cmd=${command.cmd} bytes=${decoded.length} ${decodeDetail(cause)}")
            throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE, null, cause)
        }
    }

    private suspend fun <Request, Response> request(
        relayUrl: String,
        path: String,
        method: HttpMethod,
        serializer: SerializationStrategy<Request>,
        body: Request,
        deserializer: DeserializationStrategy<Response>,
        token: String,
        timeoutMs: Long,
    ): Response = execute(relayUrl, path, method, RelayJson.encodeToString(serializer, body), deserializer, token, timeoutMs)

    private suspend fun <Response> requestWithoutBody(
        relayUrl: String,
        path: String,
        method: HttpMethod,
        deserializer: DeserializationStrategy<Response>,
        token: String,
        timeoutMs: Long,
    ): Response = execute(relayUrl, path, method, null, deserializer, token, timeoutMs)

    private suspend fun <Response> execute(
        relayUrl: String,
        path: String,
        method: HttpMethod,
        body: String?,
        deserializer: DeserializationStrategy<Response>,
        token: String,
        timeoutMs: Long,
    ): Response {
        val response = try {
            client.request(requireNotNull(normalizeAccountRelayUrl(relayUrl)) + path) {
                this.method = method
                contentType(ContentType.Application.Json)
                accept(ContentType.Application.Json)
                if (token.isNotEmpty()) bearerAuth(token)
                if (body != null) setBody(body)
                timeout { requestTimeoutMillis = timeoutMs }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (timedOut: HttpRequestTimeoutException) {
            log.warn("account request timed out path=$path after=${timeoutMs}ms")
            throw CloudAccountException(CloudAccountFailure.TIMEOUT, null, timedOut)
        } catch (cause: Throwable) {
            log.error("account request failed path=$path reason=${cause::class.simpleName}")
            throw CloudAccountException(CloudAccountFailure.NETWORK, null, cause)
        }
        val text = response.bodyAsText()
        if (response.status.value !in 200..299) {
            log.warn("account request rejected path=$path status=${response.status.value}")
            throw statusFailure(response.status.value)
        }
        return try {
            RelayJson.decodeFromString(deserializer, text)
        } catch (cause: Throwable) {
            // The body itself is never logged: it carries whatever the desktop
            // was asked for, and on this path that is the user's own sessions.
            log.error("account response undecodable path=$path bytes=${text.length} ${decodeDetail(cause)}")
            throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE, null, cause)
        }
    }

    /** GitHub public metadata only: never attach the relay token or master key. */
    public suspend fun githubProfile(userId: String): GitHubProfile? {
        if (userId.isEmpty() || userId.first() == '0' || !userId.all { it in '0'..'9' }) return null
        val response = client.request("https://api.github.com/user/$userId") {
            method = HttpMethod.Get
            accept(ContentType.Application.Json)
            headers.append("User-Agent", "OpenBitFun-Mobile")
        }
        if (response.status.value != 200) return null
        val profile = RelayJson.decodeFromString<GitHubProfile>(response.bodyAsText())
        return profile.takeIf { it.userId == userId && Regex("[A-Za-z0-9][A-Za-z0-9-]{0,38}").matches(it.username) }
            ?.let { it.copy(avatarUrl = it.avatarUrl?.takeIf { url -> url.startsWith("https://avatars.githubusercontent.com/") }) }
    }

    public companion object {
        public fun generateDeviceSecret(): ByteArray = DeviceIdentity.generateSecret()

        public fun create(): CloudAccountClient = CloudAccountClient(relayHttpClient(), TransportLog.None)

        public fun create(log: TransportLog): CloudAccountClient = CloudAccountClient(relayHttpClient(), log)

        public fun create(
            log: TransportLog,
            legacyMobileDeviceNames: Set<String>,
        ): CloudAccountClient = CloudAccountClient(relayHttpClient(), log, legacyMobileDeviceNames)
    }
}

/** Device-to-device commands encrypted using authenticated X25519 public keys. */
public class AccountDeviceCommandTransport public constructor(
    private val client: CloudAccountClient,
    private val relayUrl: String,
    private val session: CloudAccountSession,
    private val targetDeviceId: String,
    private val log: TransportLog,
) : RemoteCommandTransport, RemoteSessionStreamTransport {
    override fun wakeSessionStreams() { client.resumeSessionStreams() }
    override suspend fun loadOlder(sessionId: String) { client.loadOlderSession(targetDeviceId, sessionId) }
    override suspend fun subscribe(sessionId: String, onError: (Throwable) -> Unit, onCaughtUp: () -> Unit): kotlinx.coroutines.flow.Flow<JsonObject> =
        client.subscribeSession(relayUrl, session, targetDeviceId, sessionId, onError, onCaughtUp)

    public constructor(
        client: CloudAccountClient,
        relayUrl: String,
        session: CloudAccountSession,
        targetDeviceId: String,
    ) : this(client, relayUrl, session, targetDeviceId, TransportLog.None)

    override suspend fun <T : CommandStatus> send(
        deserializer: DeserializationStrategy<T>,
        command: RemoteCommand,
        timeoutMs: Long,
    ): T {
        val label = "cmd=${command.cmd} request=${command.requestId.orEmpty().take(12)} " +
            "device=${targetDeviceId.take(12)}"
        log.info("command start $label")

        val response = try {
            client.deviceRpc(relayUrl, session, targetDeviceId, command, deserializer, timeoutMs)
        } catch (error: CloudAccountException) {
            log.warn("command failed $label failure=${error.failure}")
            throw RelayTransportException(error.failure.asRelayFailure(), error)
        }

        if (response.isError) {
            // The desktop's own sentence, already localized there. Echoed to the
            // user, never matched on — same rule as the paired transport.
            log.warn("command rejected $label")
            throw RelayTransportException(RelayFailure.RemoteRejected(response.message))
        }
        log.info("command done $label resp=${response.resp ?: "unknown"}")
        return response
    }
}

private fun CloudAccountFailure.asRelayFailure(): RelayFailure = when (this) {
    CloudAccountFailure.INVALID_CREDENTIALS, CloudAccountFailure.AUTHENTICATION -> RelayFailure.AuthenticationRequired
    CloudAccountFailure.RATE_LIMITED -> RelayFailure.RateLimited
    CloudAccountFailure.RELAY_UNAVAILABLE -> RelayFailure.RelayUnavailable(HTTP_SERVER_ERROR)
    CloudAccountFailure.NETWORK -> RelayFailure.NetworkUnreachable
    CloudAccountFailure.TIMEOUT -> RelayFailure.Timeout
    CloudAccountFailure.MALFORMED_RESPONSE -> RelayFailure.MalformedResponse
}

/**
 * [CloudAccountFailure] keeps the status on the exception rather than in the
 * value, and [RelayFailure.RelayUnavailable] wants one — this stands in for the
 * whole 5xx band, which is all that value is ever switched on.
 */
private const val HTTP_SERVER_ERROR = 500

@Serializable
public data class GitHubAuthorization(
    public val transactionId: String,
    public val transactionSecret: String,
    public val authorizationUrl: String,
    public val expiresAt: Long,
    public val pollIntervalSeconds: Int,
) {
    override fun toString(): String = "GitHubAuthorization(<redacted>)"
}
@Serializable
private data class GitHubPollRequest(val transactionId: String, val transactionSecret: String)
@Serializable
public data class GitHubAuthorizationPoll(public val status: String, public val tokens: GitHubTokens? = null)
@Serializable
public data class GitHubTokens(public val accessToken: String) {
    override fun toString(): String = "GitHubTokens(<redacted>)"
}
@Serializable
private data class LoginRequest(
    @SerialName("access_token") val accessToken: String,
    @SerialName("device_id") val deviceId: String,
    @SerialName("device_name") val deviceName: String,
    @SerialName("device_kind") val deviceKind: String,
    @SerialName("public_key") val publicKey: String,
    @SerialName("request_id") val requestId: String,
)
@Serializable
private data class AccountAuthResponse(val token: String, @SerialName("user_id") val userId: String)
@Serializable
private data class DeviceKeyWire(@SerialName("public_key") val publicKey: String)

@Serializable
private data class AccountDeviceWire(
    @SerialName("device_id") val deviceId: String,
    @SerialName("device_name") val deviceName: String,
    val online: Boolean,
    @SerialName("last_seen_at") val lastSeenAt: Long? = null,
    @SerialName("device_kind") val deviceKind: String? = null,
)

private fun decode(value: String): ByteArray = try {
    Base64.Default.withPadding(Base64.PaddingOption.PRESENT_OPTIONAL).decode(value)
} catch (_: Throwable) {
    throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE)
}

/**
 * What to say about a decode failure without quoting the payload.
 *
 * kotlinx puts the useful part — which field, at which position in the document —
 * into a message that also carries a slice of the input, and on this path that
 * input is the user's own sessions. So the message is never printed: the missing
 * field names come from [MissingFieldException]'s own list, and everything else
 * contributes only the `$.a.b[0]` path that kotlinx appends, which names the
 * schema rather than the data.
 */
@OptIn(ExperimentalSerializationApi::class)
internal fun decodeDetail(cause: Throwable): String {
    val kind = "reason=" + (cause::class.simpleName ?: "unknown")
    if (cause is MissingFieldException) {
        return kind + " missing=" + cause.missingFields.joinToString(",")
    }
    val path = cause.message?.let { JSON_PATH.find(it) }?.value
    return if (path == null) kind else "$kind at=$path"
}

private val JSON_PATH = Regex("""\$(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+])+""")

private fun statusFailure(status: Int): CloudAccountException = when (status) {
    401, 403 -> CloudAccountException(CloudAccountFailure.AUTHENTICATION, status)
    429 -> CloudAccountException(CloudAccountFailure.RATE_LIMITED, status)
    in 500..599 -> CloudAccountException(CloudAccountFailure.RELAY_UNAVAILABLE, status)
    else -> CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE, status)
}

private fun encodePathSegment(value: String): String = value.encodeToByteArray().joinToString("") { byte ->
    val unsigned = byte.toInt() and 0xff
    val character = unsigned.toChar()
    if (character.isLetterOrDigit() || character in "-._~") character.toString()
    else "%" + unsigned.toString(16).uppercase().padStart(2, '0')
}

@Serializable
public data class GitHubProfile(
    @SerialName("id") private val id: Long,
    @SerialName("login") public val username: String,
    @SerialName("avatar_url") public val avatarUrl: String? = null,
) {
    public val userId: String get() = id.toString()
}
