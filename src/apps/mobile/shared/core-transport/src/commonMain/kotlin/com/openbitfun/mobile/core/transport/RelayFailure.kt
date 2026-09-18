package com.openbitfun.mobile.core.transport

/**
 * Why a relay exchange failed, as a value rather than a sentence.
 *
 * `RelayHttpClient.ets` maps HTTP status codes straight to localized strings
 * inside the transport, which is why its error handling then has to
 * string-compare those same translations to avoid double-wrapping them. Shared
 * code has no locale, so the mapping stops here and the app layer turns a
 * [RelayFailure] into text.
 */
public sealed interface RelayFailure {
    /** The account session is missing, expired or no longer authorized. */
    public data object AuthenticationRequired : RelayFailure

    /** The selected device is absent from the authenticated directory. */
    public data object DeviceNotFound : RelayFailure

    /** The desktop did not answer in time. 408 / 504, or a client-side timeout. */
    public data object Timeout : RelayFailure

    /** 429. */
    public data object RateLimited : RelayFailure

    /** The relay itself is unhealthy. 5xx. */
    public data class RelayUnavailable(val statusCode: Int) : RelayFailure

    /** Any other non-2xx status. */
    public data class UnexpectedStatus(val statusCode: Int) : RelayFailure

    /** The connection never got far enough to produce a status. */
    public data object NetworkUnreachable : RelayFailure

    /** A 2xx body that is not the envelope we expect, or fails to decrypt. */
    public data object MalformedResponse : RelayFailure

    /**
     * The desktop answered `{"resp":"error"}`.
     *
     * [message] is the peer's own text. It is already user-facing on the desktop
     * and there is no code to map it to, so it is passed through as-is rather
     * than invented here.
     */
    public data class RemoteRejected(val message: String?) : RelayFailure

    /**
     * The desktop runs an OpenBitFun version without `read_stream`, so its
     * sessions cannot be streamed on demand. Only updating that device helps;
     * nothing is retried here.
     */
    public data object HostStreamUnsupported : RelayFailure
}

/** Thrown by every transport entry point; carries a [failure] the UI can switch on. */
public open class RelayTransportException(
    public val failure: RelayFailure,
    cause: Throwable? = null,
) : Exception(failure.toString(), cause)
