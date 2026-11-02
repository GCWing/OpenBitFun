package com.openbitfun.mobile.core.transport

import com.openbitfun.mobile.core.crypto.CloudAccountCipher
import com.openbitfun.mobile.core.crypto.DeviceIdentity
import com.openbitfun.mobile.core.protocol.CommandStatusResponse
import com.openbitfun.mobile.core.protocol.EncryptedPayload
import com.openbitfun.mobile.core.protocol.RelayJson
import com.openbitfun.mobile.core.protocol.RemoteCommand
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.headersOf
import java.util.concurrent.Executors
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlin.io.encoding.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotSame

class RpcProcessingThreadTest {
    @Test
    fun responseDecodingDoesNotOccupyTheCallingUiThread() {
        Executors.newSingleThreadExecutor().asCoroutineDispatcher().use { ui ->
            runBlocking(ui) {
                val uiThread = Thread.currentThread()
                val master = ByteArray(32) { 7 }
                val peer = ByteArray(32) { 11 }
                val key = DeviceIdentity.messageKey(peer, DeviceIdentity.publicKey(master))
                val nonce = ByteArray(12) { 3 }
                // Use the production serializer for the wire shape.
                val plain = RelayJson.encodeToString(CommandStatusResponse.serializer(), CommandStatusResponse("ok"))
                val reply = RelayJson.encodeToJsonElement(EncryptedPayload.serializer(), EncryptedPayload(
                    Base64.Default.encode(CloudAccountCipher.encrypt(plain.encodeToByteArray(), key, nonce)),
                    Base64.Default.encode(nonce),
                ))
                val http = relayHttpClient(MockEngine {
                    respond("""{"public_key":"${Base64.Default.encode(DeviceIdentity.publicKey(peer))}"}""",
                        headers = headersOf(HttpHeaders.ContentType, "application/json"))
                })
                try {
                    val client = CloudAccountClient(http, realtimeFactory = { _, _, _ ->
                        object : AccountRpcConnection {
                            override val notifications = emptyFlow<JsonObject>()
                            override suspend fun call(target: String, params: JsonElement, timeoutMs: Long) = reply
                            override fun close() {}
                        }
                    })
                    val serializer = CommandStatusResponse.serializer()
                    val checked = object : DeserializationStrategy<CommandStatusResponse> by serializer {
                        override fun deserialize(decoder: Decoder): CommandStatusResponse {
                            assertNotSame(uiThread, Thread.currentThread(), "RPC decoding must leave the UI caller")
                            return serializer.deserialize(decoder)
                        }
                    }
                    val result = client.deviceRpc(DEFAULT_CLOUD_RELAY_URL, CloudAccountSession("token", "user", master),
                        "desktop", RemoteCommand(cmd = "list_sessions"), checked, 5_000)
                    assertEquals("ok", result.resp)
                    assertEquals(uiThread, Thread.currentThread(), "UI state delivery must resume on its caller")
                } finally { http.close() }
            }
        }
    }
}
