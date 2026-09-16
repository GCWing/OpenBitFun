package com.openbitfun.mobile.core.transport

import com.openbitfun.mobile.core.crypto.CloudAccountCipher
import com.openbitfun.mobile.core.crypto.DeviceIdentity
import com.openbitfun.mobile.core.protocol.CommandStatusResponse
import com.openbitfun.mobile.core.protocol.EncryptedPayload
import com.openbitfun.mobile.core.protocol.RelayJson
import com.openbitfun.mobile.core.protocol.RemoteCommand
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.io.encoding.Base64
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CloudAccountClientTest {
    @Test
    fun publicProfileDoesNotForwardCredentialsAndChecksImmutableIdentity() = runTest {
        val client = CloudAccountClient(relayHttpClient(MockEngine { request ->
            assertEquals("https://api.github.com/user/42", request.url.toString())
            assertEquals(null, request.headers["Authorization"])
            json("""{"id":42,"login":"octocat","avatar_url":"https://avatars.githubusercontent.com/u/42"}""")
        }))
        assertEquals("octocat", client.githubProfile("42")?.username)
        assertEquals(null, client.githubProfile("../42"))
        val wrong = CloudAccountClient(relayHttpClient(MockEngine {
            json("""{"id":99,"login":"other"}""")
        }))
        assertEquals(null, wrong.githubProfile("42"))
        val unsafeAvatar = CloudAccountClient(relayHttpClient(MockEngine {
            json("""{"id":42,"login":"octocat","avatar_url":"http://localhost/private"}""")
        }))
        assertEquals(null, unsafeAvatar.githubProfile("42")?.avatarUrl)
    }

    @Test
    fun authorizationAcceptsTheIdentityAuthorityGithubUrlAndRejectsOtherDestinations() = runTest {
        for (url in listOf("https://github.com/login/oauth/authorize?state=test", "https://auth.openbitfun.com/sign-in#ticket=test", "https://auth.openbitfun.com.evil.example/sign-in", "https://user@auth.openbitfun.com/sign-in", "https://auth.openbitfun.com:444/sign-in", "https://github.com.evil.example/login/oauth/authorize", "https://github.com/login", "https://user@github.com/login/oauth/authorize", "http://github.com/login/oauth/authorize")) {
            val engine = MockEngine { json("""{"transactionId":"txn","transactionSecret":"secret","authorizationUrl":"$url","expiresAt":9999999999,"pollIntervalSeconds":3}""") }
            val client = CloudAccountClient(relayHttpClient(engine))
            if (url == "https://github.com/login/oauth/authorize?state=test" || url == "https://auth.openbitfun.com/sign-in#ticket=test") assertEquals(url, client.startAuthorization(DEFAULT_CLOUD_RELAY_URL).authorizationUrl)
            else assertFailsWith<IllegalArgumentException> { client.startAuthorization(DEFAULT_CLOUD_RELAY_URL) }
        }
    }

    @Test
    fun githubLoginRegistersOnlyThePublicDeviceKey() = runTest {
        val bodies = mutableListOf<kotlinx.serialization.json.JsonObject>()
        val engine = MockEngine { request ->
            assertEquals("https://remote.openbitfun.com/v/1.0.1/api/auth/login", request.url.toString())
            bodies += RelayJson.parseToJsonElement(request.text()).jsonObject
            json("""{"token":"token-1","user_id":"123"}""")
        }
        val client = CloudAccountClient(relayHttpClient(engine))
        val first = client.login(DEFAULT_CLOUD_RELAY_URL, "verified-identity", "device-1", "Android", ByteArray(32) { 7 })
        val second = client.login(DEFAULT_CLOUD_RELAY_URL, "verified-identity", "device-2", "iOS", ByteArray(32) { 11 })
        assertEquals("verified-identity", bodies[0]["access_token"]?.jsonPrimitive?.content)
        assertEquals(Base64.Default.encode(DeviceIdentity.publicKey(first.masterKey)), bodies[0]["public_key"]?.jsonPrimitive?.content)
        assertFalse(first.masterKey.contentEquals(second.masterKey))
        assertFalse(bodies[0].containsKey("password"))
        assertFalse(bodies[0].containsKey("master_key"))
        assertFalse(first.toString().contains("token-1"))
    }

    /**
     * Only desktops can be driven, so only desktops are offered. A row without a
     * kind comes from a relay that predates them: this device's own row and the
     * names our own builds register under are dropped anyway, and anything else
     * is kept rather than risk hiding a real desktop.
     */
    @Test
    fun listDevicesOffersDesktopsAndDropsPhones() = runTest {
        val engine = MockEngine {
            json(
                """[
                  {"device_id":"desktop-1","device_name":"Studio Mac","online":true,"device_kind":"desktop"},
                  {"device_id":"phone-2","device_name":"Pixel 8","online":true,"device_kind":"mobile"},
                  {"device_id":"watch-1","device_name":"Watch","online":false,"device_kind":"watch"},
                  {"device_id":"phone-1","device_name":"Pixel 8","online":true},
                  {"device_id":"harmony-phone","device_name":"HarmonyOS Phone","online":true},
                  {"device_id":"harmony-watch","device_name":"HarmonyOS Watch","online":false},
                  {"device_id":"phone-3","device_name":"Legacy Phone","online":true},
                  {"device_id":"watch-2","device_name":"Legacy Watch","online":false},
                  {"device_id":"legacy-1","device_name":"DESKTOP-KM3L4UI","online":false,"last_seen_at":9}
                ]""",
            )
        }
        val client = CloudAccountClient(
            relayHttpClient(engine),
            legacyMobileDeviceNames = setOf("Legacy Phone", "Legacy Watch"),
        )

        val devices = client.listDevices(
            "http://192.168.1.2:9700",
            CloudAccountSession("token-1", "user-1", ByteArray(32)),
            "phone-1",
        )

        assertEquals(listOf("desktop-1", "legacy-1"), devices.map { it.deviceId })
        assertEquals("desktop", devices[0].deviceKind)
        assertEquals(null, devices[1].deviceKind)
    }

    @Test
    fun accountDeviceTransportEncryptsCommandAndDecryptsResponse() = runTest {
        val masterKey = ByteArray(32) { it.toByte() }
        val session = CloudAccountSession("token-1", "user-1", masterKey)
        val peerSecret = ByteArray(32) { 11 }
        val peerPublic = DeviceIdentity.publicKey(peerSecret)
        val messageKey = DeviceIdentity.messageKey(peerSecret, DeviceIdentity.publicKey(masterKey))
        val client = rpcClient(peerPublic) { target, params ->
            assertEquals("desktop 1", target)
            val envelope = RelayJson.decodeFromJsonElement(EncryptedPayload.serializer(), params)
            val commandText = CloudAccountCipher.decrypt(
                Base64.Default.decode(envelope.encryptedData), messageKey,
                Base64.Default.decode(envelope.nonce),
            ).decodeToString()
            assertEquals("ping", RelayJson.decodeFromString(RemoteCommand.serializer(), commandText).cmd)
            encryptedReply(messageKey, CommandStatusResponse("ok", null))
        }
        val transport = AccountDeviceCommandTransport(client, "http://192.168.1.2:9700", session, "desktop 1")

        val response = transport.send<CommandStatusResponse>(RemoteCommand(cmd = "ping"))

        assertEquals("ok", response.resp)
    }

    /**
     * A desktop that answers `{"resp":"error"}` answered — the acknowledged exchange
     * succeeded, so nothing below this notices. The paired transport has always
     * turned that into a rejection, and a caller cannot be asked to remember
     * which of the two it is talking to.
     */
    @Test
    fun accountDeviceTransportReportsARefusalRatherThanReturningIt() = runTest {
        val masterKey = ByteArray(32) { it.toByte() }
        val session = CloudAccountSession("token-1", "user-1", masterKey)
        val peerSecret = ByteArray(32) { 11 }
        val peerPublic = DeviceIdentity.publicKey(peerSecret)
        val messageKey = DeviceIdentity.messageKey(peerSecret, DeviceIdentity.publicKey(masterKey))
        val client = rpcClient(peerPublic) { _, _ ->
            encryptedReply(messageKey, CommandStatusResponse("error", "No workspace is open"))
        }
        val transport = AccountDeviceCommandTransport(
            client,
            "http://192.168.1.2:9700",
            session,
            "desktop-1",
        )

        val error = assertFailsWith<RelayTransportException> {
            transport.send<CommandStatusResponse>(RemoteCommand(cmd = "list_sessions"))
        }

        assertEquals(RelayFailure.RemoteRejected("No workspace is open"), error.failure)
    }

    /**
     * The account path speaks [CloudAccountFailure] and everything above a
     * transport speaks [RelayFailure]; the translation belongs here, or a screen
     * shared with the paired path can only report "something went wrong".
     */
    @Test
    fun accountDeviceTransportTranslatesRelayStatusIntoATypedFailure() = runTest {
        val session = CloudAccountSession("token-1", "user-1", ByteArray(32))
        val engine = MockEngine { respond("upstream is down", HttpStatusCode.ServiceUnavailable) }
        val transport = AccountDeviceCommandTransport(
            CloudAccountClient(relayHttpClient(engine), realtimeFactory = { _, _, _ ->
                FakeRpc { _, _ -> error("Failed key lookup must prevent RPC dispatch") }
            }),
            "http://192.168.1.2:9700",
            session,
            "desktop-1",
        )

        val error = assertFailsWith<RelayTransportException> {
            transport.send<CommandStatusResponse>(RemoteCommand(cmd = "list_sessions"))
        }

        assertEquals(RelayFailure.RelayUnavailable(500), error.failure)
        assertEquals(CloudAccountFailure.RELAY_UNAVAILABLE, (error.cause as CloudAccountException).failure)
    }

    @Test
    fun sessionGrantRetriesTransientFailureButStopsAtAuthenticationFailure() = runTest {
        var calls = 0
        val failures = mutableListOf<Throwable>()
        val client = rpcClient(DeviceIdentity.publicKey(ByteArray(32) { 11 })) { _, _ ->
            calls++
            throw CloudAccountException(if (calls == 1) CloudAccountFailure.TIMEOUT else CloudAccountFailure.AUTHENTICATION)
        }
        val error = assertFailsWith<CloudAccountException> {
            client.subscribeSession("http://192.168.1.2:9700", CloudAccountSession("token-1", "user-1", ByteArray(32)),
                "desktop-1", "session", EmptyReplica(), { failures += it }, {})
        }
        assertEquals(CloudAccountFailure.AUTHENTICATION, error.failure)
        assertEquals(2, calls)
        assertEquals(listOf(CloudAccountFailure.TIMEOUT), failures.map { (it as CloudAccountException).failure })
    }

    @Test
    fun cancellingSessionGrantBackoffPreventsAnotherRequest() = runTest {
        var calls = 0
        val entered = CompletableDeferred<Unit>()
        val client = rpcClient(DeviceIdentity.publicKey(ByteArray(32) { 11 })) { _, _ ->
            calls++
            entered.complete(Unit)
            throw CloudAccountException(CloudAccountFailure.NETWORK)
        }
        val job = launch {
            client.subscribeSession("http://192.168.1.2:9700", CloudAccountSession("token-1", "user-1", ByteArray(32)),
                "desktop-1", "session", EmptyReplica(), {}, {})
        }
        entered.await()
        assertEquals(1, calls)
        job.cancelAndJoin()
        advanceUntilIdle()
        assertEquals(1, calls)
    }

    @Test
    fun sessionGrantRecoversAndOnlyRepeatsTheReadCommand() = runTest {
        var calls = 0
        val master = ByteArray(32)
        val peerSecret = ByteArray(32) { 11 }
        val key = DeviceIdentity.messageKey(peerSecret, DeviceIdentity.publicKey(master))
        val client = rpcClient(DeviceIdentity.publicKey(peerSecret)) { _, params ->
            val envelope = RelayJson.decodeFromJsonElement(EncryptedPayload.serializer(), params)
            val plain = CloudAccountCipher.decrypt(Base64.Default.decode(envelope.encryptedData), key,
                Base64.Default.decode(envelope.nonce)).decodeToString()
            assertEquals("get_session_key", RelayJson.decodeFromString(RemoteCommand.serializer(), plain).cmd)
            if (++calls == 1) throw CloudAccountException(CloudAccountFailure.TIMEOUT)
            val nonce = ByteArray(12) { 20 }
            val response = """{"resp":"session_key","session_id":"session","relay_session_id":"opaque","key":"${Base64.Default.encode(ByteArray(32))}"}"""
            val encrypted = CloudAccountCipher.encrypt(response.encodeToByteArray(), key, nonce)
            RelayJson.encodeToJsonElement(EncryptedPayload.serializer(),
                EncryptedPayload(Base64.Default.encode(encrypted), Base64.Default.encode(nonce)))
        }
        client.subscribeSession("http://192.168.1.2:9700", CloudAccountSession("token-1", "user-1", master),
            "desktop-1", "session", EmptyReplica(), {}, {})
        assertEquals(2, calls)
    }

    private class EmptyReplica : SessionStreamReplica {
        override suspend fun eventIds() = emptyList<String>()
        override suspend fun cursor() = 0L
        override suspend fun fragments(eventId: String) = emptyList<String>()
        override suspend fun commit(fragments: List<String>, cursor: Long) {}
    }

    private class FakeRpc(private val reply: suspend (String, JsonElement) -> JsonElement) : AccountRpcConnection {
        override suspend fun call(target: String, params: JsonElement, timeoutMs: Long): JsonElement = reply(target, params)
        override fun close() {}
    }

    private fun rpcClient(peerPublic: ByteArray, reply: suspend (String, JsonElement) -> JsonElement): CloudAccountClient =
        CloudAccountClient(relayHttpClient(MockEngine { request ->
            assertEquals("Bearer token-1", request.headers[HttpHeaders.Authorization])
            assertTrue(request.url.encodedPath.endsWith("/key"), "HTTP must only read the authenticated public key")
            json("""{"public_key":"${Base64.Default.encode(peerPublic)}"}""")
        }), realtimeFactory = { _, _, token ->
            assertEquals("token-1", token)
            FakeRpc(reply)
        })

    private suspend fun encryptedReply(key: ByteArray, response: CommandStatusResponse): JsonElement {
        val nonce = ByteArray(12) { (it + 20).toByte() }
        val plain = RelayJson.encodeToString(CommandStatusResponse.serializer(), response)
        val ciphertext = CloudAccountCipher.encrypt(plain.encodeToByteArray(), key, nonce)
        return RelayJson.encodeToJsonElement(EncryptedPayload.serializer(),
            EncryptedPayload(Base64.Default.encode(ciphertext), Base64.Default.encode(nonce)))
    }

    /**
     * The reply is the user's own sessions, so the reason a decode failed has to
     * be assembled from the schema rather than quoted from the document.
     */
    @Test
    fun decodeDetailNamesTheFieldWithoutQuotingThePayload() {
        val secret = "a session title nobody else should read"
        val cause = assertFailsWith<Throwable> {
            RelayJson.decodeFromString(
                RemoteWorkspaceProbe.serializer(),
                """{"title":"$secret"}""",
            )
        }

        val detail = decodeDetail(cause)

        assertTrue(detail.contains("missing="), detail)
        assertTrue(detail.contains("path"), detail)
        assertFalse(detail.contains(secret), detail)
    }
}

/** A required field the fixture above deliberately omits. */
@kotlinx.serialization.Serializable
private data class RemoteWorkspaceProbe(val path: String, val title: String)

private suspend fun HttpRequestData.text(): String = body.toByteArray().decodeToString()

private fun MockRequestHandleScope.json(body: String) =
    respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
