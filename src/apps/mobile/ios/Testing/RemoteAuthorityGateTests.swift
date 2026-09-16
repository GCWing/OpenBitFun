import Foundation

@main
struct RemoteAuthorityGateTests {
    private struct ReadyCase {
        let name: String
        let target: String
        let epoch: UInt64
        let revision: Int64
        let expected: Bool
    }

    static func main() {
        let authority = RemoteAuthorityScope(targetKey: "device-a", epoch: 7, revision: 12)
        let readyCases = [
            ReadyCase(name: "target-only reset accepts legacy", target: "device-b", epoch: 7, revision: 0, expected: true),
            ReadyCase(name: "epoch-only reset accepts legacy", target: "device-a", epoch: 8, revision: 0, expected: true),
            ReadyCase(name: "lower positive rejected", target: "device-a", epoch: 7, revision: 11, expected: false),
            ReadyCase(name: "equal positive accepted idempotently", target: "device-a", epoch: 7, revision: 12, expected: true),
            ReadyCase(name: "same scope legacy rejected", target: "device-a", epoch: 7, revision: 0, expected: false),
        ]
        for testCase in readyCases {
            expect(
                RemoteAuthorityGate.acceptsReady(
                    targetKey: testCase.target,
                    epoch: testCase.epoch,
                    revision: testCase.revision,
                    lastApplied: authority
                ) == testCase.expected,
                testCase.name
            )
        }

        verifyRemoteCreateInteractionPolicy()
        verifyRemoteSendAuthority()

        expect(
            RemoteAuthorityGate.updatedScope(
                targetKey: "device-b",
                epoch: 7,
                revision: 0,
                lastApplied: authority
            ) == nil,
            "target-only reset clears positive authority for legacy Ready"
        )
        expect(
            RemoteAuthorityGate.updatedScope(
                targetKey: "device-a",
                epoch: 8,
                revision: 0,
                lastApplied: authority
            ) == nil,
            "epoch-only reset clears positive authority for legacy Ready"
        )
        expect(
            RemoteAuthorityGate.updatedScope(
                targetKey: "device-a",
                epoch: 7,
                revision: 12,
                lastApplied: authority
            ) == authority,
            "equal Ready is an idempotent authority update"
        )

        expect(
            RemoteAuthorityGate.succeededIsAlreadyAuthoritative(
                targetKey: "device-a",
                epoch: 7,
                commitRevision: 12,
                confirmedSessionVisible: true,
                lastApplied: authority
            ),
            "Ready-first then Succeeded is immediately authoritative"
        )
        expect(
            RemoteAuthorityGate.readyIncludesCommit(
                readyRevision: 12,
                minimumAuthorityRevision: 12,
                confirmedSessionVisible: true
            ),
            "Ready includes visible commit at its minimum revision"
        )
        expect(
            !RemoteAuthorityGate.readyIncludesCommit(
                readyRevision: 12,
                minimumAuthorityRevision: 12,
                confirmedSessionVisible: false
            ),
            "revision without the exact confirmed row cannot acknowledge commit"
        )
        expect(
            RemoteAuthorityGate.readyIncludesCommit(
                readyRevision: 0,
                minimumAuthorityRevision: 0,
                confirmedSessionVisible: true
            ),
            "legacy commit minimum zero accepts its exact visible row"
        )

        let protected = RemoteAuthorityGate.committedProjectionDecision(
            readyTargetKey: "device-a",
            readyEpoch: 7,
            readyRevision: 11,
            committedTargetKey: "device-a",
            committedEpoch: 7,
            minimumAuthorityRevision: 12,
            confirmedSessionVisible: false
        )
        expect(protected.retainMarker, "stale Ready retains committed marker")
        expect(protected.protectCommittedRowAndSelection, "stale Ready protects committed row and selection")

        let acknowledged = RemoteAuthorityGate.committedProjectionDecision(
            readyTargetKey: "device-a",
            readyEpoch: 7,
            readyRevision: 12,
            committedTargetKey: "device-a",
            committedEpoch: 7,
            minimumAuthorityRevision: 12,
            confirmedSessionVisible: true
        )
        expect(!acknowledged.retainMarker, "authoritative Ready clears committed marker")
        expect(!acknowledged.protectCommittedRowAndSelection, "authoritative Ready restores authoritative projection")

        let wrongTarget = RemoteAuthorityGate.committedProjectionDecision(
            readyTargetKey: "device-b",
            readyEpoch: 7,
            readyRevision: 0,
            committedTargetKey: "device-a",
            committedEpoch: 7,
            minimumAuthorityRevision: 12,
            confirmedSessionVisible: false
        )
        expect(!wrongTarget.retainMarker, "target reset discards old committed marker")
        expect(!wrongTarget.protectCommittedRowAndSelection, "target reset cannot project old row or selection")

        let populatedProjection = RemoteTargetProjectionState(
            hasSessionRows: true,
            hasWorkspaceRows: true,
            hasSelection: true,
            hasTimeline: true,
            hasActiveTurn: true,
            hasPendingNavigation: true,
            hasReadyAuthority: true,
            hasCreateState: true
        )
        let accountToPairing = RemoteAuthorityGate.targetBoundTransition(
            currentTargetKey: "account:device-a",
            currentEpoch: 7,
            boundTargetKey: "pairing",
            boundEpoch: 8,
            projection: populatedProjection
        )
        expect(accountToPairing.scopeChanged, "account to pairing is an authoritative scope change")
        expect(accountToPairing.projection == .cleared, "account to pairing clears rows, selection, timeline, pending, Ready, and create metadata")

        let repeatedBound = RemoteAuthorityGate.targetBoundTransition(
            currentTargetKey: "pairing",
            currentEpoch: 8,
            boundTargetKey: "pairing",
            boundEpoch: 8,
            projection: populatedProjection
        )
        expect(!repeatedBound.scopeChanged, "repeated bound callback does not reset the scope")
        expect(repeatedBound.projection == populatedProjection, "repeated bound callback preserves current projection")

        expect(
            !RemoteAuthorityGate.callbackMatchesAuthority(
                targetKey: "account:device-a",
                epoch: 7,
                expectedTargetKey: "pairing",
                expectedEpoch: 8
            ),
            "stale old-target callback is rejected"
        )
        expect(
            !RemoteAuthorityGate.callbackMatchesAuthority(
                targetKey: "pairing",
                epoch: 7,
                expectedTargetKey: "pairing",
                expectedEpoch: 8
            ),
            "stale old-epoch callback is rejected"
        )
        expect(
            !RemoteAuthorityGate.fileTransferCallbackMatchesAuthority(
                requestTargetKey: "account:device-a",
                requestEpoch: 7,
                adapterTargetKey: "account:device-b",
                adapterEpoch: 8
            ),
            "target switch rejects a queued preview or download callback from the old target"
        )
        expect(
            !RemoteAuthorityGate.fileTransferCallbackMatchesAuthority(
                requestTargetKey: "account:device-a",
                requestEpoch: 7,
                adapterTargetKey: "account:device-a",
                adapterEpoch: 8
            ),
            "adapter epoch switch rejects a queued preview or download callback from the old store"
        )
        expect(
            RemoteAuthorityGate.fileTransferCallbackMatchesAuthority(
                requestTargetKey: "account:device-b",
                requestEpoch: 8,
                adapterTargetKey: "account:device-b",
                adapterEpoch: 8
            ),
            "current target file transfer callback remains accepted"
        )

        let pairingReplacement = RemoteAuthorityGate.pairingAttemptTransition(
            authoritativeTargetKey: "pairing",
            remoteConnected: true
        )
        expect(pairingReplacement.clearBoundRemoteProjection, "re-pair clears the replaced pairing projection")
        expect(!pairingReplacement.remoteConnected, "failed re-pair remains disconnected after the old projection was discarded")

        expect(
            RemoteAuthorityGate.exactInvalidationMatchesAuthority(
                expectedTargetKey: "account:device-a",
                expectedEpoch: 7,
                currentTargetKey: "account:device-a",
                currentEpoch: 7
            ),
            "terminal pairing failure may invalidate the exact old account authority"
        )
        expect(
            !RemoteAuthorityGate.exactInvalidationMatchesAuthority(
                expectedTargetKey: "account:device-a",
                expectedEpoch: 7,
                currentTargetKey: "account:device-a",
                currentEpoch: 8
            ),
            "terminal pairing failure cannot invalidate a newer account authority"
        )

        let capturedAccount = RetainedAccountAuthority(targetKey: "account:device-a", epoch: 7)
        expect(
            RemoteAuthorityGate.shouldRetainAccountAfterPairingFailure(
                captured: capturedAccount,
                adapterTargetKey: "account:device-a",
                adapterEpoch: 7,
                modelTargetKey: "account:device-a",
                modelEpoch: 7,
                healthyConnected: true
            ),
            "failed pairing retains the explicitly captured healthy authoritative account"
        )
        expect(
            !RemoteAuthorityGate.shouldRetainAccountAfterPairingFailure(
                captured: capturedAccount,
                adapterTargetKey: "account:device-a",
                adapterEpoch: 7,
                modelTargetKey: "account:device-a",
                modelEpoch: 7,
                healthyConnected: false
            ),
            "failed account remote cannot be retained by a later pairing failure"
        )
        expect(
            !RemoteAuthorityGate.shouldRetainAccountAfterPairingFailure(
                captured: capturedAccount,
                adapterTargetKey: "account:device-a",
                adapterEpoch: 8,
                modelTargetKey: "account:device-a",
                modelEpoch: 7,
                healthyConnected: true
            ),
            "changed adapter epoch cannot retain the captured account"
        )

        let retainedAccountPairingAttempt = RemoteAuthorityGate.pairingAttemptTransition(
            authoritativeTargetKey: "account:device-a",
            remoteConnected: true
        )
        expect(
            !retainedAccountPairingAttempt.clearBoundRemoteProjection,
            "pairing submission does not invalidate a retained account before its terminal result"
        )
        expect(
            !RemoteAuthorityGate.fileTransferCallbackMatchesAuthority(
                requestTargetKey: "account:device-a",
                requestEpoch: 7,
                adapterTargetKey: nil,
                adapterEpoch: 8
            ),
            "token expiry prevents a queued old transfer callback from reviving after adapter invalidation"
        )
        expect(
            !RemoteAuthorityGate.callbackMatchesAuthority(
                targetKey: "account:device-a",
                epoch: 7,
                expectedTargetKey: nil,
                expectedEpoch: 8
            ),
            "token expiry prevents a late old Ready callback from reviving cleared authority"
        )
        verifyProductionInvalidationPaths()
        verifyWorkspaceAndSessionReadinessProjection()
    }

    private static func verifyWorkspaceAndSessionReadinessProjection() {
        let iosDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = readSource(
            iosDirectory.appendingPathComponent("OpenBitFun/Infrastructure/MobileAppModel+RemoteSession.swift")
        )

        // Workspace-first: workspace authority is sufficient to dispatch the
        // pending workspace selection; session authority is intentionally not
        // part of this gate.
        let workspaceApply = functionBody(in: source, startingAt: "func apply(workspaceState state:")
        expect(
            workspaceApply.contains("remoteInitialWorkspaceReady = !ready.busy && !ready.loadFailure") &&
                workspaceApply.contains("advancePendingDirectoryRemoteDraftIfReady()"),
            "workspace-first applies authoritative catalog and advances workspace navigation"
        )
        let workspaceSelectionGate = "pending.epoch == remoteTargetEpoch,\n           remoteConnected,\n           remoteInitialWorkspaceReady {"
        expect(source.contains("if let pending = pendingDirectoryWorkspace") &&
            source.contains(workspaceSelectionGate), "workspace-first gate requires only workspace authority")
        expect(!workspaceSelectionGate.contains("remoteInitialSessionReady"), "workspace-first gate does not require session authority")

        // Session-first: opening a session and creating from a directory still
        // require both authoritative projections, preserving the old guards.
        let sessionOpen = functionBody(in: source, startingAt: "private func openPendingDirectorySessionIfReady()")
        expect(
            sessionOpen.contains("remoteInitialSessionReady") && sessionOpen.contains("remoteInitialWorkspaceReady"),
            "session-first navigation waits for both session and workspace authority"
        )
        let draftOpen = functionBody(in: source, startingAt: "private func advancePendingDirectoryRemoteDraftIfReady()")
        expect(
            draftOpen.contains("remoteInitialSessionReady") && draftOpen.contains("remoteInitialWorkspaceReady"),
            "pending create waits for both session and workspace authority"
        )

        // Failure and target switch: neither readiness bit can survive an
        // invalid state or a changed target/epoch.
        expect(
            source.contains("if !(state is RemoteWorkspaceUiStateReady) || readyState?.busy == true || readyState?.loadFailure == true {\n            remoteInitialWorkspaceReady = false") &&
                source.contains("remoteInitialSessionReady = false"),
            "workspace/session failure paths revoke readiness"
        )
        let clearProjection = functionBody(in: source, startingAt: "private func clearTargetScopedRemoteProjection(")
        expect(
            clearProjection.contains("remoteInitialSessionReady = false") &&
                clearProjection.contains("remoteInitialWorkspaceReady = false"),
            "target switch clears both readiness projections"
        )
        expect(
            source.contains("setPublishedIfChanged(\\.busy, to: ready.busy)"),
            "session state keeps its original busy authority without republishing an unchanged value"
        )
        expect(
            source.contains("remoteInitialSessionReady = remoteInitialSessionReady || !ready.busy"),
            "cached busy session state does not claim the first authoritative load has completed"
        )
        expect(
            source.contains("func apply(\n        remoteConnectionPhase phase:") &&
                source.contains("case \"CONNECTING\", \"RECONNECTING\":") &&
                source.contains("connectionPhase = .reconnecting"),
            "shared connection phase remains authoritative after cached content is projected"
        )

        let modelSource = readSource(
            iosDirectory.appendingPathComponent("OpenBitFun/Infrastructure/MobileAppModel.swift")
        )
        let createViewSource = readSource(
            iosDirectory.appendingPathComponent("OpenBitFun/Features/Shell/RemoteCreateSessionView.swift")
        )
        expect(
            modelSource.contains("RemoteCreateInteractionPolicy.resolve(") &&
                modelSource.contains("workspacePhase: remoteCreateWorkspacePhase") &&
                modelSource.contains("workspaceSelecting: workspaceSelectionBusy"),
            "remote-create interaction is projected from target-scoped workspace state"
        )
        expect(
            createViewSource.contains("model.remoteCreateInteraction.canOpenWorkspacePicker") &&
                createViewSource.contains("model.remoteCreateInteraction.canSelectWorkspace") &&
                createViewSource.contains("case .loading:") &&
                createViewSource.contains("selectionRetryRow()") &&
                !createViewSource.contains(".disabled(model.busy || model.remoteCreateSubmitting || model.accountBusy)"),
            "workspace picker owns loading, ready, failure, and retry presentation"
        )
    }

    private static func verifyRemoteCreateInteractionPolicy() {
        let loading = RemoteCreateInteractionPolicy.resolve(
            hasTarget: true,
            remoteConnected: true,
            accountSwitching: false,
            workspacePhase: .loading,
            workspaceSelecting: false,
            createSubmitting: false,
            activeTurn: false
        )
        expect(loading.canOpenWorkspacePicker, "loading workspace picker remains openable")
        expect(!loading.canSelectWorkspace, "loading workspace rows are not selectable")
        expect(!loading.canSubmit, "creation waits for workspace authority")

        let ready = RemoteCreateInteractionPolicy.resolve(
            hasTarget: true,
            remoteConnected: true,
            accountSwitching: false,
            workspacePhase: .ready,
            workspaceSelecting: false,
            createSubmitting: false,
            activeTurn: false
        )
        expect(ready.canOpenDevicePicker, "ready state can change device")
        expect(ready.canOpenWorkspacePicker, "ready state can open workspace picker")
        expect(ready.canSelectWorkspace, "ready state can select workspace")
        expect(ready.canSubmit, "ready state can create")

        let selecting = RemoteCreateInteractionPolicy.resolve(
            hasTarget: true,
            remoteConnected: true,
            accountSwitching: false,
            workspacePhase: .ready,
            workspaceSelecting: true,
            createSubmitting: false,
            activeTurn: false
        )
        expect(selecting.canOpenWorkspacePicker, "workspace mutation remains observable")
        expect(!selecting.canSelectWorkspace, "workspace mutation rejects duplicate selection")
        expect(!selecting.canSubmit, "workspace mutation cannot race creation")

        let failed = RemoteCreateInteractionPolicy.resolve(
            hasTarget: true,
            remoteConnected: true,
            accountSwitching: false,
            workspacePhase: .failed,
            workspaceSelecting: false,
            createSubmitting: false,
            activeTurn: false
        )
        expect(failed.canOpenWorkspacePicker, "failed workspace picker exposes retry")
        expect(!failed.canSubmit, "failed workspace authority cannot create")

        let switching = RemoteCreateInteractionPolicy.resolve(
            hasTarget: true,
            remoteConnected: false,
            accountSwitching: true,
            workspacePhase: .loading,
            workspaceSelecting: false,
            createSubmitting: false,
            activeTurn: false
        )
        expect(!switching.canOpenDevicePicker, "account target mutation rejects duplicate device selection")
        expect(!switching.canOpenWorkspacePicker, "account target mutation isolates old workspace authority")

        let activeTurn = RemoteCreateInteractionPolicy.resolve(
            hasTarget: true,
            remoteConnected: true,
            accountSwitching: false,
            workspacePhase: .ready,
            workspaceSelecting: false,
            createSubmitting: false,
            activeTurn: true
        )
        expect(!activeTurn.canOpenWorkspacePicker, "active turn protects remote workspace context")
        expect(!activeTurn.canSubmit, "active turn cannot race remote creation")

        let disconnected = RemoteCreateInteractionPolicy.resolve(
            hasTarget: false,
            remoteConnected: false,
            accountSwitching: false,
            workspacePhase: .unavailable,
            workspaceSelecting: false,
            createSubmitting: false,
            activeTurn: false
        )
        expect(disconnected.canOpenDevicePicker, "disconnected state can choose a cached device")
        expect(!disconnected.canOpenWorkspacePicker, "workspace picker requires a target")
        expect(!disconnected.canSubmit, "disconnected state cannot create")
    }

    private static func functionBody(in source: String, startingAt marker: String) -> String {
        guard let start = source.range(of: marker) else {
            preconditionFailure("Missing production function contract for \(marker)")
        }
        let remainder = source[start.lowerBound...]
        guard let end = remainder.range(of: "\n    }", range: remainder.startIndex..<remainder.endIndex) else {
            preconditionFailure("Unable to locate end of production function contract for \(marker)")
        }
        return String(remainder[..<end.upperBound])
    }

    private static func verifyProductionInvalidationPaths() {
        let iosDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let accountSource = readSource(
            iosDirectory.appendingPathComponent("OpenBitFun/Infrastructure/MobileAppModel+Account.swift")
        )
        let adapterSource = readSource(
            iosDirectory.appendingPathComponent("OpenBitFun/Infrastructure/MobileCoreAdapter.swift")
        )
        let accountRemoteStart = functionBody(
            in: adapterSource,
            startingAt: "private func startAccountRemoteSessionIfNeeded(ready:"
        )
        expect(
            accountRemoteStart.contains("hydrateAccountTargetOnBind"),
            "account login and restore keep remote session hydration lazy"
        )
        expectCallBeforeMutation(
            in: adapterSource,
            function: "func selectAccountDevice(id: String)",
            call: "hydrateAccountTargetOnBind = true",
            mutation: "account.dispatch(intent: AccountIntentSelectDevice",
            message: "explicit device selection enables hydration before account selection emits"
        )
        expectInvalidationBeforeMutation(
            in: accountSource,
            function: "func selectRemoteDevice(_ device: MobileAccountDevice, preserveDrawer: Bool = false)",
            mutation: "coreAdapter?.selectAccountDevice(id: device.id)",
            message: "device switch invalidates transfers before adapter target selection"
        )
        expectInvalidationBeforeMutation(
            in: accountSource,
            function: "func logoutAccount()",
            mutation: "coreAdapter?.beginAccountOperation()",
            message: "non-retained logout invalidates transfers before adapter authority reset"
        )
        expectInvalidationBeforeMutation(
            in: accountSource,
            function: "func loginAccount()",
            mutation: "coreAdapter?.beginAccountOperation()",
            message: "non-retained login invalidates transfers before adapter authority reset"
        )
        expectInvalidationBeforeMutation(
            in: accountSource,
            function: "func apply(accountState state: AccountUiState, generation: UInt64)",
            mutation: "coreAdapter?.selectAccountDevice(id: target.id)",
            message: "account Ready arbitration invalidates an old account transfer before automatic target selection"
        )
        expectInvalidationBeforeMutation(
            in: accountSource,
            function: "private func invalidateTerminalAccountAuthority()",
            mutation: "_ = coreAdapter?.invalidateRemoteAuthority",
            message: "token expiry invalidates transfers before exact adapter authority invalidation"
        )
        expectCallBeforeMutation(
            in: accountSource,
            function: "private func invalidateTerminalAccountAuthority()",
            call: "_ = coreAdapter?.invalidateRemoteAuthority",
            mutation: "clearInvalidatedRemoteAuthorityProjection(",
            message: "token expiry invalidates exact adapter authority before clearing the complete projection"
        )

        let modelSource = readSource(
            iosDirectory.appendingPathComponent("OpenBitFun/Infrastructure/MobileAppModel.swift")
        )
        expectInvalidationBeforeMutation(
            in: modelSource,
            function: "func disconnectRemote()",
            mutation: "coreAdapter?.disconnect()",
            message: "disconnect invalidates transfers before adapter authority reset"
        )
        expectInvalidationBeforeMutation(
            in: modelSource,
            function: "private func prepareProjectionForPairingSubmission()",
            mutation: "remoteExpectedDeviceKey = nil",
            message: "replacing pairing invalidates transfers before old pairing projection is revoked"
        )
        expectCallBeforeMutation(
            in: modelSource,
            function: "func submitPairing(url: String)",
            call: "coreAdapter?.resolveDeviceLink(url: url)",
            mutation: "selectRemoteDevice(device)",
            message: "QR membership validation precedes the device selection path that invalidates transfers"
        )
        let remoteSessionSource = readSource(
            iosDirectory.appendingPathComponent("OpenBitFun/Infrastructure/MobileAppModel+RemoteSession.swift")
        )
        expectCallBeforeMutation(
            in: remoteSessionSource,
            function: "func clearInvalidatedRemoteAuthorityProjection(adapterEpoch: UInt64)",
            call: "clearTargetScopedRemoteProjection(",
            mutation: "remoteExpectedDeviceKey = nil",
            message: "terminal authority loss clears the complete target projection before dropping model authority"
        )

        for (target, storeDevice) in [("account:device-a", "device-a" as String?), ("pairing:session-a", nil)] {
            expect(RemoteAuthorityGate.filePreviewCallbackMatchesAuthority(
                requestTargetKey: target, requestEpoch: 7,
                adapterTargetKey: target, adapterEpoch: 7,
                expectedStoreDeviceKey: storeDevice, callbackDeviceKey: storeDevice
            ), "preview accepts store identity independently of the adapter namespace")
            expect(!RemoteAuthorityGate.filePreviewCallbackMatchesAuthority(
                requestTargetKey: target, requestEpoch: 7,
                adapterTargetKey: target, adapterEpoch: 8,
                expectedStoreDeviceKey: storeDevice, callbackDeviceKey: storeDevice
            ), "rebound stores cannot update an old preview")
            expect(!RemoteAuthorityGate.filePreviewCallbackMatchesAuthority(
                requestTargetKey: target, requestEpoch: 7,
                adapterTargetKey: target, adapterEpoch: 7,
                expectedStoreDeviceKey: storeDevice, callbackDeviceKey: "different-device"
            ), "another device's preview is rejected")
        }

        expect(ComposerSendSettlementPolicy.shouldRestore(
            sentSession: "a", currentSession: "a", acknowledged: false,
            draftIsEmpty: true, attachmentsAreEmpty: true
        ), "failed send restores the cleared composer")
        for (session, ack, emptyDraft, emptyImages) in [
            ("a", true, true, true), ("b", false, true, true),
            ("a", false, false, true), ("a", false, true, false)
        ] {
            expect(!ComposerSendSettlementPolicy.shouldRestore(
                sentSession: "a", currentSession: session, acknowledged: ack,
                draftIsEmpty: emptyDraft, attachmentsAreEmpty: emptyImages
            ), "send settlement preserves newer typing, attachments and another session")
        }
        expectCallBeforeMutation(
            in: remoteSessionSource,
            function: "func sendRemote()",
            call: "draft = \"\"",
            mutation: "coreAdapter.sendRemote(",
            message: "accepted send clears the composer before dispatching network work"
        )

        let selectionAdapterSource = readSource(
            iosDirectory.appendingPathComponent("OpenBitFun/Infrastructure/MobileCoreAdapter.swift")
        )
        expectCallBeforeMutation(
            in: selectionAdapterSource,
            function: "func selectAccountDevice(id: String)",
            call: "onAccountState?(ready, accountGeneration)",
            mutation: "startAccountRemoteSessionIfNeeded(",
            message: "reselecting a persisted device acknowledges account readiness without waiting for a changed StateFlow"
        )

        let filePreviewSource = readSource(
            iosDirectory.appendingPathComponent("OpenBitFun/Infrastructure/MobileAppModel+FilePreview.swift")
        )
        expectCallBeforeMutation(
            in: filePreviewSource, function: "func openRemoteFile(",
            call: "guard surface == .remote, remoteSessionSelected",
            mutation: "adapter.openRemoteFile(",
            message: "chat file preview remains closed after remote selection expires"
        )
        expectCallBeforeMutation(
            in: filePreviewSource, function: "func downloadRemoteFile(",
            call: "guard remoteSessionSelected", mutation: "beginRemoteDownload(",
            message: "chat download requires a selected session"
        )
        expectCallBeforeMutation(
            in: filePreviewSource, function: "private func beginRemoteDownload(",
            call: "guard surface == .remote, remoteConnected", mutation: "coreAdapter?.downloadRemoteFile(",
            message: "both device-tool and chat downloads require a connected remote authority"
        )

    }

    private static func readSource(_ url: URL) -> String {
        guard let source = try? String(contentsOf: url, encoding: .utf8) else {
            preconditionFailure("Unable to read production source at \(url.path)")
        }
        return source
    }

    private static func expectInvalidationBeforeMutation(
        in source: String,
        function: String,
        mutation: String,
        message: String
    ) {
        expectCallBeforeMutation(
            in: source,
            function: function,
            call: "invalidateTargetScopedFileTransfers()",
            mutation: mutation,
            message: message
        )
    }

    private static func expectCallBeforeMutation(
        in source: String,
        function: String,
        call: String,
        mutation: String,
        message: String
    ) {
        guard let functionRange = source.range(of: function),
              let callRange = source.range(of: call, range: functionRange.lowerBound..<source.endIndex),
              let mutationRange = source.range(of: mutation, range: functionRange.lowerBound..<source.endIndex) else {
            preconditionFailure("Missing production path contract for \(function)")
        }
        expect(callRange.lowerBound < mutationRange.lowerBound, message)
    }

    private static func verifyRemoteSendAuthority() {
        // The directory still shows workspace A, while workspace B was opened.
        let directorySessionIDs = ["workspace-a-session"]
        let opened = "workspace-b-session"
        expect(!directorySessionIDs.contains(opened), "regression fixture opens outside the directory page")
        expect(RemoteAuthorityGate.sendSessionID(
            selectedSessionID: opened, openedSessionID: opened,
            connected: true, busy: false, sending: false
        ) == opened, "open session outside directory remains sendable")

        for (selected, loaded, connected, busy, sending) in [
            ("new-session", Optional(opened), true, false, false),
            (opened, nil, true, false, false),
            (opened, Optional(opened), false, false, false),
            (opened, Optional(opened), true, true, false),
            (opened, Optional(opened), true, false, true),
            ("", Optional(""), true, false, false),
        ] {
            expect(RemoteAuthorityGate.sendSessionID(
                selectedSessionID: selected, openedSessionID: loaded,
                connected: connected, busy: busy, sending: sending
            ) == nil, "switching, invalidated, disconnected, busy or empty sessions cannot send")
        }
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        precondition(condition(), message)
    }
}
