import OpenBitFunMobileCore
import Foundation
import OSLog

/// Swift owns presentation state; this adapter owns the shared KMP feature seam.
@MainActor
final class MobileCoreAdapter {
    private let log = Logger(subsystem: "com.openbitfun.mobile.ios", category: "remote-create")
    private let accountLoginLog = Logger(subsystem: "com.openbitfun.mobile.ios", category: "account-login")
    let deviceID: String
    private let scope: any CoroutineScope
    private let account: AccountStore
    private let deviceDirectory: DeviceDirectoryStore
    private var foreground = true
    func setForeground(_ active: Bool) {
        foreground = active
        #if DEBUG
        log.info("Remote health lifecycle: foreground=\(active) bound=\(self.remoteSession != nil)")
        #endif
        remoteSession?.dispatch(intent: RemoteSessionIntentSetForeground(active: active))
    }
    private var remoteSession: RemoteSessionStore?
    private var remoteWorkspace: RemoteWorkspaceStore?
    private var remoteTargetKey: String?
    private var remoteTargetEpoch: UInt64 = 0
    private var desiredRemoteTarget: DesiredRemoteTarget?
    /** Fresh account login/restore stays directory-only until the user opens a target. */
    private var hydrateAccountTargetOnBind = false
    private var initialRemoteTargetSelectionOpen = true
    private var directoryGeneration: UInt64 = 0
    private var accountGeneration: UInt64 = 0
    private var observations: [Task<Void, Never>] = []
    private var accountObservation: Task<Void, Never>?
    private var directoryObservation: Task<Void, Never>?
    private var remoteObservations: [Task<Void, Never>] = []
    private var pendingDirectoryReconciles: [String: PendingDirectoryReconcile] = [:]

    private struct PendingDirectoryReconcile {
        let targetKey: String
        let remoteTargetEpoch: UInt64
        let key: DeviceDirectoryReconcileKey
    }

    private enum DesiredRemoteTarget: Equatable {
        case account(deviceID: String)
        case accountRestore
    }

    var onAccountState: ((AccountUiState, UInt64) -> Void)?
    var onRemoteTargetBound: ((String, UInt64, UInt64) -> Void)?
    var onRemoteState: ((RemoteSessionUiState, String, UInt64) -> Void)?
    var onRemoteConnectionPhase: ((OpenBitFunMobileCore.ConnectionPhase, String, UInt64) -> Void)?
    var onWorkspaceState: ((RemoteWorkspaceUiState, String, UInt64) -> Void)?
    var onDirectoryState: ((DeviceDirectoryUiState, UInt64) -> Void)?
    var onCreateOperation: ((CreateSessionOperationState, String) -> Void)?
    var onCreateUnavailable: ((String, String?) -> Void)?

    init(
        onAccountState: ((AccountUiState, UInt64) -> Void)? = nil,
        onRemoteTargetBound: ((String, UInt64, UInt64) -> Void)? = nil,
        onRemoteState: ((RemoteSessionUiState, String, UInt64) -> Void)? = nil,
        onRemoteConnectionPhase: ((OpenBitFunMobileCore.ConnectionPhase, String, UInt64) -> Void)? = nil,
        onWorkspaceState: ((RemoteWorkspaceUiState, String, UInt64) -> Void)? = nil,
        onDirectoryState: ((DeviceDirectoryUiState, UInt64) -> Void)? = nil,
        onCreateOperation: ((CreateSessionOperationState, String) -> Void)? = nil,
        onCreateUnavailable: ((String, String?) -> Void)? = nil
    ) {
        self.scope = MainScope()
        let defaults = UserDefaults.standard
        let installID: String
        if let stored = defaults.string(forKey: "openbitfun.mobile.install_id") {
            installID = stored
        } else {
            installID = UUID().uuidString
            defaults.set(installID, forKey: "openbitfun.mobile.install_id")
        }
        self.deviceID = installID
        self.account = AccountStore.companion.create(
            scope: scope,
            service: "com.openbitfun.mobile.account",
            deviceId: installID,
            deviceName: "OpenBitFun iPhone",
            log: MobileCoreLog()
        )
        self.deviceDirectory = DeviceDirectoryStore.companion.create(scope: scope, accountStore: account)
        self.onAccountState = onAccountState
        self.onRemoteTargetBound = onRemoteTargetBound
        self.onRemoteState = onRemoteState
        self.onRemoteConnectionPhase = onRemoteConnectionPhase
        self.onWorkspaceState = onWorkspaceState
        self.onDirectoryState = onDirectoryState
        self.onCreateOperation = onCreateOperation
        self.onCreateUnavailable = onCreateUnavailable

        rebindDirectoryObservation(generation: directoryGeneration)

        rebindAccountObservation()


        account.dispatch(intent: AccountIntentRestore.shared)
    }

    private func rebindAccountObservation(emitCurrent: Bool = true) {
        accountObservation?.cancel()
        let flow = SkieSwiftStateFlow<AccountUiState>(account.state)
        let generation = accountGeneration
        if emitCurrent {
            logAccountFailure(flow.value, generation: generation)
            onAccountState?(flow.value, generation)
            if let ready = flow.value as? AccountUiStateReady {
                startAccountRemoteSessionIfNeeded(ready: ready, generation: generation)
            }
        }
        accountObservation = Task { [weak self] in
            for await state in flow {
                guard !Task.isCancelled else { return }
                self?.logAccountFailure(state, generation: generation)
                self?.onAccountState?(state, generation)
                if let ready = state as? AccountUiStateReady {
                    self?.startAccountRemoteSessionIfNeeded(ready: ready, generation: generation)
                }
            }
        }
    }

    private func logAccountFailure(_ state: AccountUiState, generation: UInt64) {
        guard let failed = state as? AccountUiStateFailed else { return }
        accountLoginLog.error(
            "Account login failed reason=\(failed.reason.name, privacy: .public) stage=\(failed.stage.name, privacy: .public) target_generation=\(generation, privacy: .public)"
        )
    }

    func resolveDeviceLink(url: String) -> AccountDeviceLinkResult {
        let result = AccountDeviceLinkKt.resolveAccountDeviceLink(
            url: url, state: SkieSwiftStateFlow<AccountUiState>(account.state).value
        )
        if result.status == .signInRequired, let relayUrl = result.relayUrl {
            account.dispatch(intent: AccountIntentSelectRelay(relayUrl: relayUrl))
        }
        return result
    }

    func beginAccountOperation() -> (accountGeneration: UInt64, remoteTargetEpoch: UInt64) {
        accountGeneration &+= 1
        desiredRemoteTarget = nil
        initialRemoteTargetSelectionOpen = false
        resetRemoteStores()
        remoteTargetEpoch &+= 1
        rebindAccountObservation(emitCurrent: false)
        return (accountGeneration, remoteTargetEpoch)
    }

    func loginAccount() {
        desiredRemoteTarget = .accountRestore
        hydrateAccountTargetOnBind = false
        initialRemoteTargetSelectionOpen = false
        account.dispatch(intent: AccountIntentLogin.shared)
    }

    func selectAccountDevice(id: String) {
        pendingDirectoryReconciles.removeAll()
        desiredRemoteTarget = .account(deviceID: id)
        hydrateAccountTargetOnBind = true
        initialRemoteTargetSelectionOpen = false
        account.dispatch(intent: AccountIntentSelectDevice(deviceId: id))
        let state = SkieSwiftStateFlow<AccountUiState>(account.state).value
        guard let ready = state as? AccountUiStateReady,
              ready.selectedDeviceId == id else { return }
        // Selecting a persisted target can leave StateFlow unchanged. Publish
        // the confirmed snapshot before binding stores so the UI exits switching
        // even when no asynchronous account event is emitted.
        onAccountState?(ready, accountGeneration)
        startAccountRemoteSessionIfNeeded(ready: ready, generation: accountGeneration)
    }

    private func rebindDirectoryObservation(generation: UInt64) {
        directoryObservation?.cancel()
        let flow = SkieSwiftStateFlow<DeviceDirectoryUiState>(deviceDirectory.state)
        let capturedGeneration = generation
        onDirectoryState?(flow.value, capturedGeneration)
        directoryObservation = Task { [weak self] in
            for await state in flow {
                guard !Task.isCancelled else { return }
                self?.onDirectoryState?(state, capturedGeneration)
            }
        }
    }

    @discardableResult
    func syncDeviceDirectory(_ devices: [MobileAccountDevice]) -> UInt64 {
        directoryGeneration &+= 1
        let generation = directoryGeneration
        deviceDirectory.dispatch(intent: DeviceDirectoryIntentSync(devices: devices.map {
            DeviceDirectoryDevice(deviceId: $0.id, deviceName: $0.name, online: $0.online)
        }))
        rebindDirectoryObservation(generation: generation)
        return generation
    }

    func toggleDeviceDirectory(_ deviceID: String, expanded: Bool) {
        deviceDirectory.dispatch(intent: expanded
            ? DeviceDirectoryIntentExpand(deviceId: deviceID)
            : DeviceDirectoryIntentCollapse(deviceId: deviceID))
    }

    func retryDeviceDirectory(_ deviceID: String) {
        deviceDirectory.dispatch(intent: DeviceDirectoryIntentRetry(deviceId: deviceID))
    }

    func setDirectoryWorkspaceExpanded(_ deviceID: String, path: String, expanded: Bool, connectionId: String? = nil, sshHost: String? = nil) {
        deviceDirectory.dispatch(intent: DeviceDirectoryIntentSetWorkspaceExpanded(
            deviceId: deviceID,
            path: path,
            expanded: expanded, remoteConnectionId: connectionId, remoteSshHost: sshHost
        ))
    }

    func retryDirectoryWorkspace(_ deviceID: String, path: String, connectionId: String? = nil, sshHost: String? = nil) {
        deviceDirectory.dispatch(intent: DeviceDirectoryIntentRetryWorkspace(
            deviceId: deviceID,
            path: path, remoteConnectionId: connectionId, remoteSshHost: sshHost
        ))
    }

    func refreshAccountDevices() {
        account.dispatch(intent: AccountIntentRefreshDevices.shared)
    }

    func retryAccountFailure() {
        account.dispatch(intent: AccountIntentRetry.shared)
    }

    func logoutAccount() {
        pendingDirectoryReconciles.removeAll()
        desiredRemoteTarget = nil
        initialRemoteTargetSelectionOpen = false
        resetRemoteStores()
        deviceDirectory.dispatch(intent: DeviceDirectoryIntentStop.shared)
        account.dispatch(intent: AccountIntentLogout.shared)
    }

    func disconnect() {
        desiredRemoteTarget = nil
        initialRemoteTargetSelectionOpen = false
        resetRemoteStores()
    }

    func startQuestionInteraction(_ toolID: String) { remoteSession?.dispatch(intent: RemoteSessionIntentStartQuestionInteraction(toolId: toolID)) }
    func respondPermission(_ requestID: String, approve: Bool, updatedInput: String?) {
        remoteSession?.dispatch(intent: RemoteSessionIntentRespondPermission(requestId: requestID, approve: approve, updatedInput: updatedInput))
    }
    func refreshPermissionMailbox() {
        remoteSession?.dispatch(intent: RemoteSessionIntentRefreshPermissionMailbox.shared)
    }
    func sendRemote(sessionID: String, content: String, images: [ComposerAttachment]) {
        remoteSession?.dispatch(
            intent: RemoteSessionIntentSendMessage(
                sessionId: sessionID,
                content: content,
                images: images.isEmpty ? nil : images.map(\.coreImage)
            )
        )
    }

    func buildRemotePlan(sessionID: String, path: String, name: String) {
        remoteSession?.dispatch(intent: RemoteSessionIntentBuildPlan(sessionId: sessionID, path: path, name: name))
    }

    func cancelRemoteTurn(sessionID: String, turnID: String?) {
        remoteSession?.dispatch(
            intent: RemoteSessionIntentCancelTurn(sessionId: sessionID, turnId: turnID)
        )
    }

    func approveRemoteTool(sessionID: String, toolID: String, updatedInput: String? = nil) {
        remoteSession?.dispatch(
            intent: RemoteSessionIntentApproveTool(sessionId: sessionID, toolId: toolID, updatedInput: updatedInput)
        )
    }

    func rejectRemoteTool(sessionID: String, toolID: String, reason: String) {
        remoteSession?.dispatch(
            intent: RemoteSessionIntentRejectTool(sessionId: sessionID, toolId: toolID, reason: reason)
        )
    }

    func cancelRemoteTool(sessionID: String, toolID: String, reason: String) {
        remoteSession?.dispatch(
            intent: RemoteSessionIntentCancelTool(sessionId: sessionID, toolId: toolID, reason: reason)
        )
    }

    func answerRemoteTool(sessionID: String, toolID: String, answer: String) {
        remoteSession?.dispatch(
            intent: RemoteSessionIntentAnswerQuestion(sessionId: sessionID, toolId: toolID, answer: answer)
        )
    }

    func answerRemoteToolStructured(sessionID: String, toolID: String, answers: [QuestionAnswer]) {
        remoteSession?.dispatch(
            intent: RemoteSessionIntentAnswerStructuredQuestion(
                sessionId: sessionID,
                toolId: toolID,
                answers: answers
            )
        )
    }

    func renameRemoteSession(sessionID: String, title: String) {
        remoteSession?.dispatch(
            intent: RemoteSessionIntentRenameSession(sessionId: sessionID, title: title)
        )
    }

    func selectRemoteModel(sessionID: String, modelID: String) {
        remoteSession?.dispatch(
            intent: RemoteSessionIntentSelectModel(sessionId: sessionID, modelId: modelID)
        )
    }

    func openRemoteSession(sessionID: String) {
        remoteSession?.dispatch(intent: RemoteSessionIntentOpen(sessionId: sessionID))
    }

    func createRemoteSession(
        requestID: String,
        agentType: String,
        title: String,
        instruction: String,
        modelID: String?,
        workspacePath: String? = nil,
        remoteConnectionId: String? = nil,
        remoteSshHost: String? = nil
    ) {
        guard let remoteSession else {
            log.error("Remote create unavailable target_kind=\(self.remoteTargetKind(self.remoteTargetKey), privacy: .public)")
            onCreateUnavailable?(requestID, remoteTargetKey)
            return
        }
        log.info("Dispatching remote create target_kind=\(self.remoteTargetKind(self.remoteTargetKey), privacy: .public)")
        prepareDirectoryReconcile(requestID: requestID)
        remoteSession.dispatch(
            intent: RemoteSessionIntentCreateSessionOperation(
                requestId: requestID,
                agentType: agentType,
                title: title,
                instruction: instruction,
                modelId: modelID,
                workspacePath: workspacePath,
                remoteConnectionId: remoteConnectionId,
                remoteSshHost: remoteSshHost
            )
        )
    }

    func createRemoteAssistantSession(
        requestID: String,
        assistantPath: String,
        title: String,
        instruction: String,
        modelID: String?
    ) {
        guard let remoteSession else {
            log.error("Remote assistant create unavailable reason=remote-session-missing target_kind=\(self.remoteTargetKind(self.remoteTargetKey), privacy: .public)")
            onCreateUnavailable?(requestID, remoteTargetKey)
            return
        }
        guard let remoteWorkspace else {
            log.error("Remote assistant create unavailable reason=workspace-missing target_kind=\(self.remoteTargetKind(self.remoteTargetKey), privacy: .public)")
            onCreateUnavailable?(requestID, remoteTargetKey)
            return
        }
        prepareDirectoryReconcile(requestID: requestID)
        remoteSession.createAssistantSession(
            workspaceStore: remoteWorkspace,
            requestId: requestID,
            assistantPath: assistantPath,
            title: title,
            instruction: instruction,
            modelId: modelID
        )
    }

    func deleteRemoteSession(sessionID: String) {
        remoteSession?.dispatch(intent: RemoteSessionIntentDeleteSession(sessionId: sessionID))
    }

    func searchRemoteSessions(query: String) {
        remoteSession?.dispatch(intent: RemoteSessionIntentSearch(query: query))
    }

    func loadMoreRemoteSessions() {
        remoteSession?.dispatch(intent: RemoteSessionIntentLoadMore.shared)
    }

    func loadOlderRemoteMessages() {
        remoteSession?.dispatch(intent: RemoteSessionIntentLoadOlderMessages.shared)
    }

    func refreshRemoteSessions() {
        remoteSession?.dispatch(intent: RemoteSessionIntentRefresh.shared)
    }

    func setRemoteAgentFilter(_ filter: SessionAgentFilter) {
        remoteSession?.dispatch(intent: RemoteSessionIntentSetAgentFilter(filter: filter))
    }

    func refreshRemotePermissionMode() {
        remoteSession?.dispatch(intent: RemoteSessionIntentRefreshPermissionMode.shared)
    }

    func setRemotePermissionMode(_ mode: SessionPermissionMode) {
        remoteSession?.dispatch(intent: RemoteSessionIntentSetPermissionMode(mode: mode))
    }

    func resizeRuntimeTerminal(cols: Int, rows: Int) { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentResizeTerminal(cols: Int32(cols), rows: Int32(rows))) }
    func openDeviceTools(connectionId: String?) { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentOpenDeviceTools(path: "", connectionId: connectionId)) }
    func selectDeviceToolsPanel(terminal: Bool) { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentSelectDeviceToolsPanel(panel: terminal ? .terminal : .files)) }
    func closeDeviceTools() { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentCloseDeviceTools.shared) }
    func startDeviceToolsTerminal() { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentStartDeviceToolsTerminal.shared) }
    func openDeviceFiles(_ path: String, connectionId: String?) { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentOpenDeviceFiles(path: path, remoteConnectionId: connectionId)) }
    func openDeviceTerminal(_ path: String, connectionId: String?) { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentOpenDeviceTerminal(path: path, remoteConnectionId: connectionId)) }
    func browseRuntimeDirectories(_ path: String, connectionId: String?, append: Bool) { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentBrowseWorkspaceDirectories(path: path, remoteConnectionId: connectionId, append: append)) }
    func sortRuntimeFiles(_ sort: RuntimeFileSort) { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentSortFiles(sort: sort)) }
    func closeRuntimeFileEditor() { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentCloseFileEditor.shared) }
    func browseRuntimeFiles(_ path: String, append: Bool) { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentBrowseFiles(path: path, append: append)) }
    func readRuntimeFile(_ path: String) { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentReadFile(path: path)) }
    func saveRuntimeFile(_ content: String) { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentSaveFile(content: content)) }
    func uploadRuntimeFile(_ path: String, source: RuntimeUploadSource) { guard let remoteWorkspace else { source.close(); return }; remoteWorkspace.dispatch(intent: RemoteWorkspaceIntentUploadFile(path: path, source: source)) }
    func createRuntimeFileEntry(_ name: String, directory: Bool) { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentCreateFileEntry(name: name, directory: directory)) }
    func renameRuntimeFileEntry(_ path: String, name: String) { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentRenameFileEntry(path: path, name: name)) }
    func deleteRuntimeFileEntry(_ path: String) { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentDeleteFileEntry(path: path)) }
    func uploadRuntimeFileEntry(_ name: String, source: RuntimeUploadSource) { guard let remoteWorkspace else { source.close(); return }; remoteWorkspace.dispatch(intent: RemoteWorkspaceIntentUploadFileEntry(name: name, source: source)) }
    func createRuntimeFile(_ path: String) { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentCreateFile(path: path)) }
    func renameRuntimeFile(_ path: String) { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentRenameFile(path: path)) }
    func deleteRuntimeFile() { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentDeleteFile.shared) }
    func createRuntimeDirectory(_ path: String) { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentCreateDirectory(path: path)) }
    func resumeSessionStreams() { account.resumeSessionStreams() }
    func openRuntimeTerminal() { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentOpenTerminal.shared) }
    func reopenRuntimeTerminal() { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentReopenTerminal.shared) }
    func writeRuntimeTerminal(_ data: String) { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentWriteTerminal(data: data)) }
    func closeRuntimeTerminal() { remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentCloseTerminal.shared) }

    func selectRemoteWorkspace(path: String, remoteConnectionId: String? = nil, remoteSshHost: String? = nil) {
        remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentSelectWorkspace(path: path, remoteConnectionId: remoteConnectionId, remoteSshHost: remoteSshHost))
    }

    func selectRemoteAssistant(path: String) {
        remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentSelectAssistant(path: path))
    }

    func loadRemoteWorkspaces() {
        remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentLoad.shared)
    }

    var currentRemoteTargetKey: String? { remoteTargetKey }
    var currentRemoteTargetEpoch: UInt64 { remoteTargetEpoch }

    @discardableResult
    func invalidateRemoteAuthority(
        ifTargetKey targetKey: String,
        epoch: UInt64
    ) -> RemoteAuthorityInvalidationResult {
        guard RemoteAuthorityGate.exactInvalidationMatchesAuthority(
            expectedTargetKey: targetKey,
            expectedEpoch: epoch,
            currentTargetKey: remoteTargetKey,
            currentEpoch: remoteTargetEpoch
        ) else {
            return .notMatched(currentTargetKey: remoteTargetKey, currentEpoch: remoteTargetEpoch)
        }
        desiredRemoteTarget = nil
        initialRemoteTargetSelectionOpen = false
        resetRemoteStores()
        remoteTargetEpoch &+= 1
        return .invalidated(newEpoch: remoteTargetEpoch)
    }

    // Workspace-store identities use the raw device ID, not the adapter's
    // namespaced account/pairing target key.
    var currentFilePreviewDeviceKey: String? { remoteWorkspace?.deviceKey }
    var canOpenRemoteFile: Bool { remoteWorkspace != nil }

    @discardableResult
    func openRemoteFile(reference: String, label: String, sessionID: String, requestID: String) -> String? {
        remoteWorkspace?.dispatch(
            intent: RemoteWorkspaceIntentOpenFile(
                reference: reference,
                label: label,
                sessionId: sessionID,
                requestId: requestID
            )
        )
        return remoteTargetKey
    }

    func downloadRemoteFile(reference: String, label: String, sessionID: String) {
        remoteWorkspace?.dispatch(
            intent: RemoteWorkspaceIntentDownloadFile(
                reference: reference,
                label: label,
                sessionId: sessionID
            )
        )
    }

    func retryRemoteDownload() {
        remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentRetryDownload.shared)
    }

    func remoteDownloadSaved(reference: String) {
        remoteWorkspace?.dispatch(
            intent: RemoteWorkspaceIntentDownloadSaved(reference: reference)
        )
    }

    func remoteDownloadSaveFailed(reference: String) {
        remoteWorkspace?.dispatch(
            intent: RemoteWorkspaceIntentDownloadSaveFailed(reference: reference)
        )
    }

    func dismissRemoteFilePreview() {
        remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentDismissPreview.shared)
    }

    private func startAccountRemoteSessionIfNeeded(ready: AccountUiStateReady, generation: UInt64) {
        guard generation == accountGeneration,
              hydrateAccountTargetOnBind,
              let deviceID = ready.selectedDeviceId else { return }
        let desiredTarget = DesiredRemoteTarget.account(deviceID: deviceID)
        let targetKey = "account:\(deviceID)"
        guard remoteTargetIsDesired(desiredTarget),
              remoteTargetKey != targetKey,
              let sessionStore = account.createSessionStore(scope: scope) else { return }
        commitInitialRemoteTargetIfNeeded(desiredTarget)
        bindRemoteStores(
            targetKey: targetKey,
            sessionStore: sessionStore,
            workspaceStore: account.createWorkspaceStore(scope: scope)
        )
    }

    private func remoteTargetIsDesired(_ candidate: DesiredRemoteTarget) -> Bool {
        switch desiredRemoteTarget {
        case let .account(deviceID):
            return candidate == .account(deviceID: deviceID)
        case .accountRestore:
            if case .account = candidate { return true }
            return false
        case nil:
            return initialRemoteTargetSelectionOpen && remoteTargetKey == nil
        }
    }

    private func commitInitialRemoteTargetIfNeeded(_ target: DesiredRemoteTarget) {
        if desiredRemoteTarget == nil || desiredRemoteTarget == .accountRestore {
            desiredRemoteTarget = target
        }
        initialRemoteTargetSelectionOpen = false
    }

    private func prepareDirectoryReconcile(requestID: String) {
        pendingDirectoryReconciles.removeValue(forKey: requestID)
        guard let targetKey = remoteTargetKey else { return }

        let prefix = "account:"
        guard targetKey.hasPrefix(prefix) else { return }
        let deviceID = String(targetKey.dropFirst(prefix.count))
        guard !deviceID.isEmpty,
              let key = deviceDirectory.reconcileKey(deviceId: deviceID) else { return }
        pendingDirectoryReconciles[requestID] = PendingDirectoryReconcile(
            targetKey: targetKey,
            remoteTargetEpoch: remoteTargetEpoch,
            key: key
        )
    }

    private func remoteTargetKind(_ targetKey: String?) -> String {
        guard let targetKey else { return "none" }
        if targetKey.hasPrefix("account:") { return "account" }
        return "other"
    }

    private func handleCreateOperation(
        _ state: CreateSessionOperationState,
        targetKey: String,
        epoch: UInt64
    ) {
        log.info("Remote create state=\(String(describing: type(of: state)), privacy: .public) target_kind=\(self.remoteTargetKind(targetKey), privacy: .public)")
        switch state {
        case let succeeded as CreateSessionOperationStateSucceeded:
            if let pending = pendingDirectoryReconciles.removeValue(forKey: succeeded.requestId),
               pending.targetKey == targetKey,
               pending.remoteTargetEpoch == epoch,
               remoteTargetKey == targetKey,
               remoteTargetEpoch == epoch,
               let confirmedSession = succeeded.confirmedSession {
                _ = deviceDirectory.reconcileCreatedSession(key: pending.key, session: confirmedSession)
            }
        case let failed as CreateSessionOperationStateFailed:
            pendingDirectoryReconciles.removeValue(forKey: failed.requestId)
        case let cancelled as CreateSessionOperationStateCancelled:
            pendingDirectoryReconciles.removeValue(forKey: cancelled.requestId)
        case is CreateSessionOperationStateIdle:
            pendingDirectoryReconciles = pendingDirectoryReconciles.filter {
                $0.value.targetKey != targetKey || $0.value.remoteTargetEpoch != epoch
            }
        default:
            break
        }
        onCreateOperation?(state, targetKey)
    }

    private func bindRemoteStores(
        targetKey: String,
        sessionStore: RemoteSessionStore,
        workspaceStore: RemoteWorkspaceStore?
    ) {
        resetRemoteStores()
        remoteTargetEpoch &+= 1
        let boundEpoch = remoteTargetEpoch
        remoteTargetKey = targetKey
        remoteSession = sessionStore
        remoteWorkspace = workspaceStore
        onRemoteTargetBound?(targetKey, boundEpoch, accountGeneration)

        let sessionFlow = SkieSwiftStateFlow<RemoteSessionUiState>(sessionStore.state)
        onRemoteState?(sessionFlow.value, targetKey, boundEpoch)
        remoteObservations.append(Task { [weak self] in
            var lastHealthSignature = ""
            for await state in sessionFlow {
                guard !Task.isCancelled else { return }
                #if DEBUG
                let ready = state as? RemoteSessionUiStateReady
                let signature = "ready=\(ready != nil) busy=\(ready?.busy ?? false) timeline=\(ready?.timeline != nil)"
                if signature != lastHealthSignature {
                    self?.log.info("Remote health eligibility: \(signature, privacy: .public) epoch=\(boundEpoch)")
                    lastHealthSignature = signature
                }
                #endif
                self?.onRemoteState?(state, targetKey, boundEpoch)
            }
        })

        let connectionFlow = SkieSwiftStateFlow<OpenBitFunMobileCore.ConnectionPhase>(sessionStore.connectionPhase)
        onRemoteConnectionPhase?(connectionFlow.value, targetKey, boundEpoch)
        remoteObservations.append(Task { [weak self] in
            for await phase in connectionFlow {
                guard !Task.isCancelled else { return }
                #if DEBUG
                self?.log.info("Remote health phase: \(phase.name, privacy: .public) epoch=\(boundEpoch)")
                #endif
                self?.onRemoteConnectionPhase?(phase, targetKey, boundEpoch)
            }
        })

        sessionStore.dispatch(intent: RemoteSessionIntentLoad.shared)
        sessionStore.dispatch(intent: RemoteSessionIntentSetForeground(active: foreground))

        let createFlow = SkieSwiftStateFlow<CreateSessionOperationState>(sessionStore.createOperation)
        handleCreateOperation(createFlow.value, targetKey: targetKey, epoch: boundEpoch)
        remoteObservations.append(Task { [weak self] in
            for await state in createFlow {
                guard !Task.isCancelled else { return }
                self?.handleCreateOperation(state, targetKey: targetKey, epoch: boundEpoch)
            }
        })

        if let workspaceStore {
            let workspaceFlow = SkieSwiftStateFlow<RemoteWorkspaceUiState>(workspaceStore.state)
            onWorkspaceState?(workspaceFlow.value, targetKey, boundEpoch)
            workspaceStore.dispatch(intent: RemoteWorkspaceIntentLoad.shared)
            remoteObservations.append(Task { [weak self] in
                for await state in workspaceFlow {
                    guard !Task.isCancelled else { return }
                    self?.onWorkspaceState?(state, targetKey, boundEpoch)
                }
            })
        }
    }

    private func resetRemoteStores() {
        pendingDirectoryReconciles.removeAll()
        remoteObservations.forEach { $0.cancel() }
        remoteObservations.removeAll()
        remoteSession?.dispatch(intent: RemoteSessionIntentStop.shared)
        remoteWorkspace?.dispatch(intent: RemoteWorkspaceIntentStop.shared)
        remoteSession = nil
        remoteWorkspace = nil
        remoteTargetKey = nil
    }

    func stop() {
        desiredRemoteTarget = nil
        initialRemoteTargetSelectionOpen = false
        accountObservation?.cancel()
        accountObservation = nil
        observations.forEach { $0.cancel() }
        observations.removeAll()
        directoryObservation?.cancel()
        directoryObservation = nil
        resetRemoteStores()
        deviceDirectory.dispatch(intent: DeviceDirectoryIntentStop.shared)
        account.stop()
    }
}

private extension ComposerAttachment {
    var coreImage: ComposerImage {
        ComposerImage(id: id, dataUrl: dataURL, mimeType: mimeType)
    }
}


final class IOSRuntimeUploadSource: RuntimeUploadSource {
    private let url: URL
    private let scoped: Bool
    private let handle: FileHandle
    let size: Int64
    init(url: URL) throws {
        self.url = url
        scoped = url.startAccessingSecurityScopedResource()
        do {
            handle = try FileHandle(forReadingFrom: url)
            size = Int64(try handle.seekToEnd())
        } catch {
            if scoped { url.stopAccessingSecurityScopedResource() }
            throw error
        }
    }
    func read(offset: Int64, length: Int32) throws -> KotlinByteArray {
        try handle.seek(toOffset: UInt64(offset))
        let data = try handle.read(upToCount: Int(length)) ?? Data()
        let bytes = KotlinByteArray(size: Int32(data.count))
        for (index, byte) in data.enumerated() { bytes.set(index: Int32(index), value: Int8(bitPattern: byte)) }
        return bytes
    }
    func close() { try? handle.close(); if scoped { url.stopAccessingSecurityScopedResource() } }
}

/// CoreLog's contract excludes credentials and message bodies; the native sink
/// makes request/stream failure categories available in device diagnostics.
private final class MobileCoreLog: NSObject, CoreLog {
    private let logger = Logger(subsystem: "com.openbitfun.mobile.ios", category: "remote-core")
    func info(message: String) { logger.info("\(message, privacy: .public)") }
    func warn(message: String) { logger.warning("\(message, privacy: .public)") }
    func error(message: String) { logger.error("\(message, privacy: .public)") }
}
