package com.openbitfun.mobile.core.transport

import io.ktor.client.HttpClient
import io.ktor.client.plugins.timeout
import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.utils.io.readAvailable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*

/** Bulk ciphertext is transferred separately from realtime control frames. */
internal class RpcPayload(private val http: HttpClient, relayUrl: String, private val token: String) {
    private val endpoint = "${relayUrl.trimEnd('/')}/v1/rpc/payloads"
    suspend fun uploadIfLarge(value: JsonElement): JsonElement {
        val bytes = withContext(Dispatchers.Default) { value.toString().encodeToByteArray() }
        if (bytes.size <= INLINE_BYTES) return value
        if (bytes.size > MAX_BYTES) throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE)
        val response = withTimeout(120_000) {
            http.post(endpoint) {
                timeout { requestTimeoutMillis = 120_000 }
                bearerAuth(token)
                contentType(ContentType.Application.OctetStream)
                setBody(bytes)
            }
        }
        if (!response.status.isSuccess()) throw CloudAccountException(CloudAccountFailure.RELAY_UNAVAILABLE)
        return Json.parseToJsonElement(response.bodyAsText()).also { reference(it) }
    }
    suspend fun resolve(value: JsonElement): JsonElement {
        if ((value as? JsonObject)?.containsKey("\$relayPayload") != true) return value
        val (id, expected) = reference(value)
        return withTimeout(120_000) {
            val response = http.get("$endpoint/$id") {
                timeout { requestTimeoutMillis = 120_000 }
                bearerAuth(token)
            }
            if (!response.status.isSuccess()) throw CloudAccountException(CloudAccountFailure.RELAY_UNAVAILABLE)
            if (response.contentLength()?.let { it != expected.toLong() } == true) throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE)
            val channel = response.bodyAsChannel()
            val bytes = ByteArray(expected)
            var offset = 0
            while (offset < expected) {
                val read = channel.readAvailable(bytes, offset, expected - offset)
                if (read == -1) break
                offset += read
            }
            val extra = ByteArray(1)
            if (offset != expected || channel.readAvailable(extra, 0, 1) != -1) throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE)
            withContext(Dispatchers.Default) {
                Json.parseToJsonElement(bytes.decodeToString(throwOnInvalidSequence = true))
            }
        }
    }
    private fun reference(value: JsonElement): Pair<String, Int> {
        val ref = value.jsonObject["\$relayPayload"]?.jsonObject
        val id = ref?.get("id")?.jsonPrimitive?.content
        val bytes = ref?.get("bytes")?.jsonPrimitive?.intOrNull
        if (id == null || !UUID.matches(id) || bytes == null || bytes !in 1..MAX_BYTES) throw CloudAccountException(CloudAccountFailure.MALFORMED_RESPONSE)
        return id to bytes
    }
    companion object {
        private const val INLINE_BYTES = 128 * 1024
        private const val MAX_BYTES = 64 * 1024 * 1024
        private val UUID = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
    }
}
