package com.openbitfun.mobile.core.feature.session

import com.openbitfun.mobile.core.transport.RelayFailure
import com.openbitfun.mobile.core.transport.RelayTransportException

/**
 * Turns a transport error into the state a session screen shows.
 *
 * `RemoteCommandTransport.send` throws [RelayFailure.RemoteRejected] when the
 * desktop answers `resp: "error"`, and that message is the only thing that says
 * *why* — folding it into `TRANSPORT` left the UI with nothing to show. The
 * split is by what the user can do next, the same way `PairingFailureReason`
 * splits, which is why the relay's own 4xx/5xx all collapse into `TRANSPORT`
 * while a timeout stays separate: one is "the desktop is not reachable", the
 * other is "try again".
 */
internal fun remoteSessionFailure(error: Throwable): RemoteSessionUiState.Failed {
    val failure = (error as? RelayTransportException)?.failure
        ?: return RemoteSessionUiState.Failed(RemoteSessionFailureReason.TRANSPORT)
    return when (failure) {
        is RelayFailure.RemoteRejected -> RemoteSessionUiState.Failed(
            RemoteSessionFailureReason.REMOTE_REJECTED,
            failure.message?.trim()?.takeIf { it.isNotEmpty() },
        )
        RelayFailure.Timeout -> RemoteSessionUiState.Failed(RemoteSessionFailureReason.TIMEOUT)
        RelayFailure.NetworkUnreachable -> RemoteSessionUiState.Failed(RemoteSessionFailureReason.NETWORK)
        RelayFailure.RateLimited -> RemoteSessionUiState.Failed(RemoteSessionFailureReason.RATE_LIMITED)
        RelayFailure.MalformedResponse -> RemoteSessionUiState.Failed(RemoteSessionFailureReason.PROTOCOL_MISMATCH)
        RelayFailure.HostStreamUnsupported -> RemoteSessionUiState.Failed(RemoteSessionFailureReason.HOST_STREAM_UNSUPPORTED)
        RelayFailure.AuthenticationRequired,
        RelayFailure.DeviceNotFound,
        is RelayFailure.RelayUnavailable,
        is RelayFailure.UnexpectedStatus,
        -> RemoteSessionUiState.Failed(RemoteSessionFailureReason.TRANSPORT)
    }
}
