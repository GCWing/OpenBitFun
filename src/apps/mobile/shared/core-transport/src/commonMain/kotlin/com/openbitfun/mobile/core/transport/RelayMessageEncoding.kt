package com.openbitfun.mobile.core.transport

import com.squareup.zstd.ZSTD_e_end
import com.squareup.zstd.getErrorName
import com.squareup.zstd.zstdCompressor
import com.squareup.zstd.zstdDecompressor

internal object RelayMessageEncoding {
    const val NAME = "zstd-1"
    private val prefix = byteArrayOf(0xff.toByte(), 0x4f, 0x5a, 1)
    private const val HEADER = 8
    private const val MAX_BYTES = 64 * 1024 * 1024

    fun encode(plain: ByteArray, accepted: Boolean): ByteArray {
        if (!accepted || plain.size <= 256 || plain.size > MAX_BYTES) return plain
        // If this single frame cannot fit in the original budget, send plain JSON.
        val buffer = ByteArray(plain.size)
        zstdCompressor().use { encoder ->
            check(getErrorName(encoder.setParameter(100, 1)) == null) // ZSTD_c_compressionLevel
            val result = encoder.compressStream2(buffer, buffer.size, HEADER, plain, plain.size, 0, ZSTD_e_end)
            check(getErrorName(result) == null) { "Relay Zstd compression failed" }
            val length = HEADER + encoder.outputBytesProcessed
            if (result != 0L || encoder.inputBytesProcessed != plain.size || length >= plain.size) return plain
            prefix.copyInto(buffer)
            repeat(4) { buffer[4 + it] = (plain.size ushr (it * 8)).toByte() }
            return buffer.copyOf(length)
        }
    }

    fun decode(bytes: ByteArray): ByteArray {
        if (bytes.firstOrNull() != prefix[0]) return bytes
        require(bytes.size > HEADER && prefix.indices.all { bytes[it] == prefix[it] }) { "Unknown Relay message encoding" }
        var size = 0
        repeat(4) { size = size or ((bytes[4 + it].toInt() and 255) shl (it * 8)) }
        require(size in 1..MAX_BYTES) { "Invalid Relay decoded size" }
        val output = ByteArray(size)
        zstdDecompressor().use { decoder ->
            val result = decoder.decompressStream(output, size, 0, bytes, bytes.size, HEADER)
            require(result == 0L && decoder.inputBytesProcessed == bytes.size - HEADER && decoder.outputBytesProcessed == size) {
                "Invalid Relay Zstd frame"
            }
        }
        return output
    }
}
