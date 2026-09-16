package com.openbitfun.mobile.core.transport

import io.ktor.client.engine.okhttp.OkHttp
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import java.net.ServerSocket
import java.security.MessageDigest
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals

/** Uses Android's actual engine: the JVM production engine does not reject frame-limit setters. */
class OkHttpRealtimeTest {
    @Test
    fun androidEngineAuthenticatesAndReceivesRpcAcknowledgement() = exerciseReconnect(false)

    @Test
    fun androidEngineReconnectsAfterSilentSocketTimeout() = exerciseReconnect(true)

    @Test
    fun androidEngineReconnectsAfterConnectionReset() = exerciseReconnect(true, true)

    private fun exerciseReconnect(interruptFirst: Boolean, resetFirst: Boolean = false): Unit = runBlocking {
        ServerSocket(0).use { server ->
            server.soTimeout = 10_000
            val received = CompletableDeferred<Unit>()
            val host = async(Dispatchers.IO) {
                repeat(if (interruptFirst) 2 else 1) { connectionIndex ->
                server.accept().use { socket ->
                    socket.soTimeout = 10_000
                    val input = socket.getInputStream()
                    val output = socket.getOutputStream()
                    val header = StringBuilder()
                    while (!header.endsWith("\r\n\r\n")) {
                        val byte = input.read()
                        check(byte >= 0)
                        header.append(byte.toChar())
                    }
                    val key = header.lines().first { it.startsWith("Sec-WebSocket-Key:", true) }
                        .substringAfter(':').trim()
                    val accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
                        .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()))
                    output.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
                        "Connection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n").toByteArray())
                    fun send(text: String) {
                        val bytes = text.toByteArray()
                        check(bytes.size < 126)
                        output.write(byteArrayOf(0x81.toByte(), bytes.size.toByte()))
                        output.write(bytes)
                        output.flush()
                    }
                    fun receive(): String {
                        val opcode = input.read()
                        check(opcode == 0x81) { "Expected text frame, received opcode $opcode" }
                        val lengthByte = input.read()
                        check(lengthByte and 0x80 != 0)
                        var length = lengthByte and 0x7f
                        if (length == 126) length = (input.read() shl 8) or input.read()
                        check(length < 65536)
                        val mask = input.readNBytes(4)
                        val bytes = input.readNBytes(length)
                        return ByteArray(length) { (bytes[it].toInt() xor mask[it % 4].toInt()).toByte() }
                            .toString(Charsets.UTF_8)
                    }
                    send("0{\"sid\":\"test\",\"upgrades\":[],\"pingInterval\":${if (interruptFirst && connectionIndex == 0) 100 else 25000},\"pingTimeout\":${if (interruptFirst && connectionIndex == 0) 100 else 20000}}")
                    check(receive().startsWith("40"))
                    send("40{\"sid\":\"test\"}")
                    send("42[\"auth-ok\",{}]")
                    if (interruptFirst && connectionIndex == 0) {
                        // Stop sending Engine.IO heartbeats without closing TCP.
                        if (resetFirst) socket.setSoLinger(true, 0) else delay(500)
                        return@use
                    }
                    val request = receive()
                    check(request.startsWith("42"))
                    val ackId = request.substring(2, request.indexOf('['))
                    send("43$ackId[{\"ok\":true,\"result\":{\"value\":42}}]")
                    // Keep the epoch alive until the caller receives the ack.
                    received.await()
                }
                }
            }
            val http = relayHttpClient(OkHttp.create())
            val realtime = AccountRealtime(http, "http://127.0.0.1:${server.localPort}", "test-token")
            try {
                if (interruptFirst) withTimeout(10_000) { realtime.connections.first { it >= 2 } }
                val result = withTimeout(10_000) {
                    realtime.call("host", buildJsonObject { put("cmd", "ping") }, 5000)
                }
                assertEquals(42, result.jsonObject.getValue("value").jsonPrimitive.int)
                assertEquals(if (interruptFirst) 2 else 1, realtime.connections.value)
            } finally {
                received.complete(Unit)
                realtime.close()
                http.close()
                host.cancelAndJoin()
            }
        }
    }
}
