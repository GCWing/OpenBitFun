package com.openbitfun.mobile.core.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Envelope for every encrypted relay exchange.
 *
 * The nonce and ciphertext use base64. The optional encoding offer describes
 * the sender’s decoder. The ciphertext carries a trailing 128-bit GCM
 * authentication tag; see [com.openbitfun.mobile.core.protocol] contract fixtures
 * for the exact wire shape.
 */
@Serializable
public data class EncryptedPayload(
    @SerialName("encrypted_data") val encryptedData: String,
    @SerialName("nonce") val nonce: String,
    @SerialName("accept_encoding") val acceptEncoding: String? = null,
)
