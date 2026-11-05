package com.openbitfun.mobile.core.transport

import kotlin.test.*

class RelayMessageEncodingTest {
    @Test fun legacyAndNewMessagesRoundTrip() {
        val text = "x".repeat(300).encodeToByteArray()
        assertSame(text, RelayMessageEncoding.encode(text, false))
        assertSame(text, RelayMessageEncoding.decode(text))
        assertEquals(256, RelayMessageEncoding.encode(ByteArray(256), true).size)
        val encoded = RelayMessageEncoding.encode(text, true)
        assertTrue(encoded.size < text.size)
        assertContentEquals(text, RelayMessageEncoding.decode(encoded))
        // Reference frame from the shared Relay message-encoding fixture.
        val frame = "ff4f5a012c01000028b52ffd602c004d00001078780100272ac002".chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        assertContentEquals(text, RelayMessageEncoding.decode(frame))
        frame[4] = 1
        assertFails { RelayMessageEncoding.decode(frame) }
    }
}
