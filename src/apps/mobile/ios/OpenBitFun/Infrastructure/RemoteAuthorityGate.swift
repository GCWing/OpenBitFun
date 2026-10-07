import Foundation

struct RemoteAuthorityScope: Equatable {
    let targetKey: String
    let epoch: UInt64
    let revision: Int64
}

struct RemoteCommittedProjectionDecision: Equatable {
    let retainMarker: Bool
    let protectCommittedRowAndSelection: Bool
}

struct RemoteTargetProjectionState: Equatable {
    var hasSessionRows: Bool
    var hasWorkspaceRows: Bool
    var hasSelection: Bool
    var hasTimeline: Bool
    var hasActiveTurn: Bool
    var hasPendingNavigation: Bool
    var hasReadyAuthority: Bool
    var hasCreateState: Bool

    static let cleared = RemoteTargetProjectionState(
        hasSessionRows: false,
        hasWorkspaceRows: false,
        hasSelection: false,
        hasTimeline: false,
        hasActiveTurn: false,
        hasPendingNavigation: false,
        hasReadyAuthority: false,
        hasCreateState: false
    )
}

struct RemoteTargetBoundTransition: Equatable {
    let scopeChanged: Bool
    let projection: RemoteTargetProjectionState
}

enum RemoteAuthorityInvalidationResult: Equatable {
    case invalidated(newEpoch: UInt64)
    case notMatched(currentTargetKey: String?, currentEpoch: UInt64)
}

/// Target-scoped lifecycle of the workspace catalog used by remote creation.
///
/// This is intentionally separate from session `busy`: workspace discovery is
/// an independent request and should become interactive as soon as its own
/// authority is ready, regardless of a slower session-directory refresh.
enum RemoteCreateWorkspacePhase: Equatable {
    case unavailable
    case loading
    case ready
    case failed
}

struct RemoteCreateInteractionState: Equatable {
    let canOpenDevicePicker: Bool
    let canOpenWorkspacePicker: Bool
    let canSelectWorkspace: Bool
    let canSubmit: Bool
}

enum RemoteCreateInteractionPolicy {
    static func resolve(
        hasTarget: Bool,
        remoteConnected: Bool,
        accountSwitching: Bool,
        workspacePhase: RemoteCreateWorkspacePhase,
        workspaceSelecting: Bool,
        createSubmitting: Bool,
        activeTurn: Bool
    ) -> RemoteCreateInteractionState {
        let contextMutationBlocked = createSubmitting || activeTurn
        let canOpenDevicePicker = !accountSwitching && !contextMutationBlocked
        let canOpenWorkspacePicker = hasTarget && !accountSwitching && !contextMutationBlocked
        let workspaceReady = workspacePhase == .ready && !workspaceSelecting

        return RemoteCreateInteractionState(
            canOpenDevicePicker: canOpenDevicePicker,
            // Loading and failure are deliberately openable: the picker owns
            // progress, retry, and cached-list presentation for its request.
            canOpenWorkspacePicker: canOpenWorkspacePicker,
            canSelectWorkspace: canOpenWorkspacePicker && workspaceReady,
            canSubmit: remoteConnected && hasTarget && !accountSwitching &&
                !contextMutationBlocked && workspaceReady
        )
    }
}

enum RemoteAuthorityGate {
    /// A directory page can omit the open conversation (another workspace,
    /// filter, or pagination). Its membership is not mutation authority.
    static func sendSessionID(
        selectedSessionID: String?,
        openedSessionID: String?,
        connected: Bool,
        busy: Bool,
        sending: Bool
    ) -> String? {
        guard connected, !busy, !sending,
              let selectedSessionID, !selectedSessionID.isEmpty,
              selectedSessionID == openedSessionID else { return nil }
        return selectedSessionID
    }

    static func targetBoundTransition(
        currentTargetKey: String?,
        currentEpoch: UInt64?,
        boundTargetKey: String,
        boundEpoch: UInt64,
        projection: RemoteTargetProjectionState
    ) -> RemoteTargetBoundTransition {
        let changed = currentTargetKey != boundTargetKey || currentEpoch != boundEpoch
        return RemoteTargetBoundTransition(
            scopeChanged: changed,
            projection: changed ? .cleared : projection
        )
    }

    static func callbackMatchesAuthority(
        targetKey: String,
        epoch: UInt64,
        expectedTargetKey: String?,
        expectedEpoch: UInt64
    ) -> Bool {
        targetKey == expectedTargetKey && epoch == expectedEpoch
    }

    static func fileTransferCallbackMatchesAuthority(
        requestTargetKey: String?,
        requestEpoch: UInt64?,
        adapterTargetKey: String?,
        adapterEpoch: UInt64
    ) -> Bool {
        guard let requestTargetKey, let requestEpoch else { return false }
        return requestTargetKey == adapterTargetKey && requestEpoch == adapterEpoch
    }

    static func filePreviewCallbackMatchesAuthority(
        requestTargetKey: String?, requestEpoch: UInt64,
        adapterTargetKey: String?, adapterEpoch: UInt64,
        expectedStoreDeviceKey: String?, callbackDeviceKey: String?
    ) -> Bool {
        fileTransferCallbackMatchesAuthority(
            requestTargetKey: requestTargetKey, requestEpoch: requestEpoch,
            adapterTargetKey: adapterTargetKey, adapterEpoch: adapterEpoch
        ) && expectedStoreDeviceKey == callbackDeviceKey
    }

    static func exactInvalidationMatchesAuthority(
        expectedTargetKey: String,
        expectedEpoch: UInt64,
        currentTargetKey: String?,
        currentEpoch: UInt64
    ) -> Bool {
        expectedTargetKey == currentTargetKey && expectedEpoch == currentEpoch
    }

    static func acceptsReady(
        targetKey: String,
        epoch: UInt64,
        revision: Int64,
        lastApplied: RemoteAuthorityScope?
    ) -> Bool {
        guard let lastApplied,
              lastApplied.targetKey == targetKey,
              lastApplied.epoch == epoch,
              lastApplied.revision > 0 else {
            return true
        }
        return revision > 0 && revision >= lastApplied.revision
    }

    static func updatedScope(
        targetKey: String,
        epoch: UInt64,
        revision: Int64,
        lastApplied: RemoteAuthorityScope?
    ) -> RemoteAuthorityScope? {
        guard revision > 0 else {
            if let lastApplied,
               lastApplied.targetKey == targetKey,
               lastApplied.epoch == epoch {
                return lastApplied
            }
            return nil
        }
        return RemoteAuthorityScope(targetKey: targetKey, epoch: epoch, revision: revision)
    }

    static func succeededIsAlreadyAuthoritative(
        targetKey: String,
        epoch: UInt64,
        commitRevision: Int64,
        confirmedSessionVisible: Bool,
        lastApplied: RemoteAuthorityScope?
    ) -> Bool {
        guard confirmedSessionVisible,
              commitRevision > 0,
              let lastApplied,
              lastApplied.targetKey == targetKey,
              lastApplied.epoch == epoch else {
            return false
        }
        return lastApplied.revision >= commitRevision
    }

    static func readyIncludesCommit(
        readyRevision: Int64,
        minimumAuthorityRevision: Int64,
        confirmedSessionVisible: Bool
    ) -> Bool {
        if minimumAuthorityRevision > 0 {
            return readyRevision >= minimumAuthorityRevision && confirmedSessionVisible
        }
        return confirmedSessionVisible
    }

    static func committedProjectionDecision(
        readyTargetKey: String,
        readyEpoch: UInt64,
        readyRevision: Int64,
        committedTargetKey: String?,
        committedEpoch: UInt64?,
        minimumAuthorityRevision: Int64?,
        confirmedSessionVisible: Bool
    ) -> RemoteCommittedProjectionDecision {
        guard let committedTargetKey,
              let committedEpoch,
              let minimumAuthorityRevision,
              committedTargetKey == readyTargetKey,
              committedEpoch == readyEpoch else {
            return RemoteCommittedProjectionDecision(
                retainMarker: false,
                protectCommittedRowAndSelection: false
            )
        }
        let authoritative = readyIncludesCommit(
            readyRevision: readyRevision,
            minimumAuthorityRevision: minimumAuthorityRevision,
            confirmedSessionVisible: confirmedSessionVisible
        )
        return RemoteCommittedProjectionDecision(
            retainMarker: !authoritative,
            protectCommittedRowAndSelection: !authoritative
        )
    }
}

enum ComposerSendSettlementPolicy {
    static func shouldRestore(
        sentSession: String, currentSession: String,
        acknowledged: Bool, draftIsEmpty: Bool, attachmentsAreEmpty: Bool, draftUnchanged: Bool
    ) -> Bool {
        !acknowledged && sentSession == currentSession && draftUnchanged && draftIsEmpty && attachmentsAreEmpty
    }
}

/// Whether a failed remote state ends the conversation or only interrupts it.
///
/// The shared store retries a transport-class failure without discarding its
/// transcript, and publishes `Failed` for those reasons only when it has no
/// ready snapshot to hand over yet. That is a cold open or a just-rebound
/// target, not a lost conversation, so the projection must survive the blip and
/// let the connection state alone report the interruption. A deterministic
/// failure — the session is gone, the host cannot stream, the command was
/// refused — still ends the projection.
enum RemoteSessionFailureProjectionPolicy {
    static func keepsVisibleConversation(reasonName: String) -> Bool {
        // Mirrors the retryable set in `RemoteSessionStore.handleFailure`,
        // which maps exactly these reasons to `ConnectionPhase.RECONNECTING`.
        switch reasonName {
        case "NETWORK", "TIMEOUT", "TRANSPORT": return true
        default: return false
        }
    }
}
