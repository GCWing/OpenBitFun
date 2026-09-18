import Foundation
import OpenBitFunMobileCore
import OSLog

private let mobilePerformanceLog = Logger(
    subsystem: "com.openbitfun.mobile.ios",
    category: "performance"
)

extension MobileAppModel {
    func startQuestionInteraction(_ toolID: String) { coreAdapter?.startQuestionInteraction(toolID) }
    func respondPermission(_ requestID: String, approve: Bool, updatedInput: String?) {
        coreAdapter?.respondPermission(requestID, approve: approve, updatedInput: updatedInput)
    }
    func refreshPermissionMailbox() { coreAdapter?.refreshPermissionMailbox() }

    func apply(remoteTargetBound targetKey: String, epoch: UInt64, accountGeneration generation: UInt64) {
        guard generation == accountGeneration,
              !accountLoginPreview, !localActionPreview, !remoteCreatePreview else { return }
        let projection = RemoteTargetProjectionState(
            hasSessionRows: !remoteSessions.isEmpty,
            hasWorkspaceRows: !remoteWorkspaces.isEmpty || !workspaceCatalog.isEmpty,
            hasSelection: remoteSessionSelected,
            hasTimeline: (surface == .remote || remoteSessionSelected) &&
                (!timelineRows.isEmpty || !messages.isEmpty),
            hasActiveTurn: (surface == .remote || remoteSessionSelected) &&
                (activeTurnID != nil || isSending || busy),
            hasPendingNavigation: pendingDirectorySession != nil || pendingDirectoryWorkspace != nil ||
                pendingDirectoryRemoteDraft != nil,
            hasReadyAuthority: remoteInitialSessionReady || remoteInitialWorkspaceReady ||
                remoteLastAppliedAuthority != nil,
            hasCreateState: remoteCreateOpen || remoteCreateSubmitting || remoteCreateRequestID != nil ||
                committedRemoteCreate != nil
        )
        let transition = RemoteAuthorityGate.targetBoundTransition(
            currentTargetKey: remoteBoundTargetKey,
            currentEpoch: remoteBoundTargetEpoch,
            boundTargetKey: targetKey,
            boundEpoch: epoch,
            projection: projection
        )
        remoteBoundTargetKey = targetKey
        remoteBoundTargetEpoch = epoch
        remoteExpectedDeviceKey = targetKey
        remoteTargetEpoch = epoch
        guard transition.scopeChanged else { return }

        pairingRetainedAccountAuthority = nil
        clearTargetScopedRemoteProjection(boundTargetKey: targetKey, epoch: epoch)
    }

    func clearInvalidatedRemoteAuthorityProjection(adapterEpoch: UInt64) {
        clearTargetScopedRemoteProjection(boundTargetKey: "", epoch: adapterEpoch)
        remoteExpectedDeviceKey = nil
        remoteBoundTargetKey = nil
        remoteBoundTargetEpoch = nil
        remoteTargetEpoch = adapterEpoch
        pairingRetainedAccountAuthority = nil
    }

    private func clearTargetScopedRemoteProjection(boundTargetKey targetKey: String, epoch: UInt64) {
        resetRemoteConversationOpen()
        pendingComposerSend = nil
        invalidateTargetScopedFileTransfers()
        remoteOpenedSessionID = nil
        remoteInitialSessionReady = false
        remoteInitialWorkspaceReady = false
        remoteLastAppliedAuthority = nil
        remoteSessions = []
        remoteWorkspaces = []
        remoteAssistants = []
        workspaceCatalog = []
        remoteSidebarWorkspaceState = nil
        selectedRemoteWorkspaceKind = ""
        workspaceLoading = !targetKey.isEmpty
        workspaceLoadFailed = false
        workspaceSelectionBusy = false
        completionNotifier.reset()
        remoteHostCapabilities = []
        remoteCreateWorkspacePhase = targetKey.isEmpty ? .unavailable : .loading
        let clearingVisibleRemoteConversation = surface == .remote || remoteSessionSelected
        remoteSessionSelected = false
        sessionDetails = nil
        if clearingVisibleRemoteConversation {
            selectedSessionID = ""
            activeTurnID = nil
            isSending = false
            busy = false
            timelineRows = []
            messages = []
            composerImages = []
        }

        if let pending = pendingDirectorySession,
           pending.epoch != epoch || directoryTargetKey(forRawDeviceKey: pending.deviceKey) != targetKey {
            pendingDirectorySession = nil
        }
        routePendingDirectorySession()
        if let pending = pendingDirectoryWorkspace,
           pending.epoch != epoch || directoryTargetKey(forRawDeviceKey: pending.deviceKey) != targetKey {
            pendingDirectoryWorkspace = nil
        }
        if pendingDirectoryRemoteDraft?.targetKey != targetKey || pendingDirectoryRemoteDraft?.epoch != epoch {
            pendingDirectoryRemoteDraft = nil
        }
        pendingRemoteWorkspaceCreate = nil
        pendingRemoteSessionRefreshWorkspace = nil
        pendingRemoteAssistantCreate = false

        committedRemoteCreate = nil
        remoteCreateOpen = false
        remoteCreateSubmitting = false
        remoteCreateRequestID = nil
        remoteCreateRequestEpoch = 0
        remoteCreateRequestDeviceKey = nil
        remoteCreateError = nil
        remoteCreateDeviceError = nil

    }

    func apply(directoryState state: DeviceDirectoryUiState, generation: UInt64) {
        guard !accountLoginPreview, !localActionPreview, !remoteCreatePreview, !directoryFixturePreview,
              generation == accountDirectoryGeneration else { return }
        deviceDirectory = state.devices.map { entry in
            let deviceKey = entry.deviceId
            let sessions = entry.sessions.map { session in
                ChatSession(
                    id: session.id,
                    title: session.title.isEmpty ? localized("未命名会话") : session.title,
                    updatedLabel: session.updatedAt,
                    status: session.status,
                    agentType: session.agentType,
                    workspacePath: session.workspacePath,
                    workspaceName: session.workspaceName,
                    workspaceScope: session.workspaceIdentity.map(Self.workspaceScope(of:)),
                    deviceKey: deviceKey,
                    createdAt: session.createdAt,
                    messageCount: Int(session.messageCount)
                )
            }
            let workspaces = entry.workspaces.map { workspace in
                // ID-first: the directory entry and its sessions are looked up by the row's
                // identity, so two same-path workspaces never share state or sessions.
                let identity = RemoteWorkspaceIdentity(
                    path: workspace.path, remoteConnectionId: workspace.remoteConnectionId,
                    remoteSshHost: workspace.remoteSshHost, workspaceId: workspace.workspaceId
                )
                let directory = entry.workspace(workspace: identity)
                let ownedSessionIDs = Set(entry.sessionsForWorkspace(workspace: identity).map { $0.id })
                let rowScope = Self.workspaceScope(of: identity)
                return MobileWorkspaceGroup(
                    workspaceId: workspace.workspaceId,
                    path: workspace.path,
                    name: workspace.name.isEmpty ? workspace.path : workspace.displayName,
                    selected: remoteExpectedDeviceKey == deviceKey &&
                        workspaceCatalog.contains(where: { $0.selected && Self.workspaceScope(of: $0).refersTo(rowScope) }),
                    sessions: sessions.filter { ownedSessionIDs.contains($0.id) },
                    deviceKey: deviceKey,
                    directoryExpanded: directory?.expanded ?? false,
                    directoryStatus: directory?.status.name ?? "IDLE",
                    remoteConnectionId: workspace.remoteConnectionId,
                    remoteSshHost: workspace.remoteSshHost
                )
            }
            return MobileDeviceDirectoryEntry(
                id: deviceKey,
                name: entry.deviceName,
                online: entry.online,
                status: entry.status.name,
                error: entry.error?.name,
                workspaces: workspaces,
                sessions: sessions,
                catalogSource: entry.catalogSource?.name,
                recentWorkspaces: entry.recentWorkspaces.map { workspace in
                    MobileWorkspaceGroup(workspaceId: workspace.workspaceId, path: workspace.path, name: workspace.displayName,
                        selected: false, sessions: [], deviceKey: deviceKey,
                        remoteConnectionId: workspace.remoteConnectionId, remoteSshHost: workspace.remoteSshHost)
                }
            )
        }
    }

    func loadDeviceDirectory(_ device: MobileDeviceDirectoryEntry) {
        coreAdapter?.loadDeviceDirectory(device.id)
    }

    func retryDeviceDirectory(_ device: MobileDeviceDirectoryEntry) {

        coreAdapter?.retryDeviceDirectory(device.id)
    }

    func refreshDirectoryWorkspacesForPicker(_ device: MobileDeviceDirectoryEntry) {
        guard device.online else { return }
        coreAdapter?.retryDeviceDirectory(device.id)
    }

    func setDirectoryWorkspaceExpanded(
        device: MobileDeviceDirectoryEntry,
        workspace: MobileWorkspaceGroup,
        expanded: Bool
    ) {
        guard device.online else { return }
        coreAdapter?.setDirectoryWorkspaceExpanded(device.id, path: workspace.path, expanded: expanded, connectionId: workspace.remoteConnectionId, sshHost: workspace.remoteSshHost, workspaceId: workspace.workspaceId)
    }

    func retryDirectoryWorkspace(
        device: MobileDeviceDirectoryEntry,
        workspace: MobileWorkspaceGroup
    ) {
        guard device.online else { return }
        coreAdapter?.retryDirectoryWorkspace(device.id, path: workspace.path, connectionId: workspace.remoteConnectionId, sshHost: workspace.remoteSshHost, workspaceId: workspace.workspaceId)
    }

    private func directoryTargetKey(forRawDeviceKey rawDeviceKey: String) -> String {
        "account:\(rawDeviceKey)"
    }

    private var authoritativeDirectoryRawDeviceKey: String? {
        guard let targetKey = remoteExpectedDeviceKey else { return nil }

        let prefix = "account:"
        guard targetKey.hasPrefix(prefix) else { return nil }
        let rawDeviceKey = String(targetKey.dropFirst(prefix.count))
        return rawDeviceKey.isEmpty ? nil : rawDeviceKey
    }

    func openDirectoryRemoteDraft(
        device: MobileDeviceDirectoryEntry,
        workspace: MobileWorkspaceGroup,
        agentType: String = "code"
    ) {
        guard !remoteCreateSubmitting, remoteCreateRequestID == nil else {
            showToast(localized("远程会话当前不可创建，请重试"))
            return
        }
        guard let matched = accountDevices.first(where: { $0.id == device.id }),
              matched.online, device.online else {
            showToast(localized("这台桌面设备当前离线"))
            return
        }
        let targetKey = "account:\(matched.id)"
        let accountDevice = matched

        pendingDirectorySession = nil
        pendingDirectoryWorkspace = nil
        pendingRemoteWorkspaceCreate = nil
        pendingRemoteAssistantCreate = false
        remoteCreateOpen = false

        let targetIsCurrent = remoteExpectedDeviceKey == targetKey
        let epoch = targetIsCurrent ? remoteTargetEpoch : remoteTargetEpoch &+ 1
        pendingDirectoryRemoteDraft = PendingDirectoryRemoteDraft(
            targetKey: targetKey,
            rawDeviceKey: device.id,
            workspacePath: workspace.path,
            normalizedWorkspacePath: normalizedSessionWorkspacePath(workspace.path),
            remoteConnectionId: workspace.remoteConnectionId,
            remoteSshHost: workspace.remoteSshHost,
            workspaceId: workspace.workspaceId,
            agentType: agentType,
            epoch: epoch,
            selectionRequested: false
        )

        if targetIsCurrent {
            if connectionPhase == .disconnected {
                pendingDirectoryRemoteDraft = nil
                showToast(localized("远程会话连接已失效，请重新选择设备后重试"))
            } else if workspaceLoadFailed {
                pendingDirectoryRemoteDraft = nil
                showToast(localized("工作区加载失败，点按重试"))
            } else {
                advancePendingDirectoryRemoteDraftIfReady()
            }
            return
        }

        selectRemoteDevice(accountDevice)
    }

    func selectDirectoryWorkspace(_ workspace: MobileWorkspaceGroup) {
        pendingDirectoryRemoteDraft = nil
        guard let deviceKey = workspace.deviceKey else { return }
        let targetKey = directoryTargetKey(forRawDeviceKey: deviceKey)
        if remoteExpectedDeviceKey == targetKey {
            guard remoteConnected else {
                showToast(localized("远程会话连接已失效，请重新选择设备后重试"))
                return
            }
            selectRemoteWorkspace(workspace)
            return
        }
        pendingDirectoryWorkspace = (deviceKey, workspace.path, remoteTargetEpoch &+ 1, workspace.remoteConnectionId, workspace.remoteSshHost, workspace.workspaceId)
        guard targetKey != "pairing",
              let device = accountDevices.first(where: { $0.id == deviceKey }) else {
            pendingDirectoryWorkspace = nil
            showToast(localized("远程会话连接已失效，请重新选择设备后重试"))
            return
        }
        guard device.online else {
            pendingDirectoryWorkspace = nil
            showToast(localized("这台桌面设备当前离线"))
            return
        }
        selectRemoteDevice(device)
    }

    func selectDirectorySession(_ session: ChatSession) {
        pendingDirectoryRemoteDraft = nil
        guard let deviceKey = session.deviceKey else { return }
        let targetKey = directoryTargetKey(forRawDeviceKey: deviceKey)
        let targetIsCurrent = remoteExpectedDeviceKey == targetKey
        pendingDirectorySession = (
            deviceKey,
            session.id,
            remoteTargetEpoch &+ (targetIsCurrent ? 0 : 1)
        )
        if targetIsCurrent {
            guard remoteConnected || accountBusy || connectionPhase == .reconnecting else {
                pendingDirectorySession = nil
                showToast(localized("远程会话连接已失效，请重新选择设备后重试"))
                return
            }
            routePendingDirectorySession()
            openPendingDirectorySessionIfReady()
            return
        }
        guard targetKey != "pairing",
              let device = accountDevices.first(where: { $0.id == deviceKey }) else {
            pendingDirectorySession = nil
            showToast(localized("远程会话连接已失效，请重新选择设备后重试"))
            return
        }
        guard device.online else {
            pendingDirectorySession = nil
            showToast(localized("这台桌面设备当前离线"))
            return
        }
        selectRemoteDevice(device)
        routePendingDirectorySession()
        openPendingDirectorySessionIfReady()
    }

    // Navigation is immediate; authority readiness only gates the remote request.
    // Keep the same deferred skeleton gate as HarmonyOS, starting at the tap.
    private func routePendingDirectorySession() {
        guard let pending = pendingDirectorySession,
              pending.epoch == remoteTargetEpoch,
              remoteExpectedDeviceKey == directoryTargetKey(forRawDeviceKey: pending.deviceKey) else { return }
        surface = .remote
        drawerOpen = false
        remoteSessionSelected = true
        if remoteConversationOpeningSessionID != pending.sessionID {
            beginRemoteConversationOpen(sessionID: pending.sessionID)
        }
    }

    private func openPendingDirectorySessionIfReady() {
        guard let pending = pendingDirectorySession,
              pending.epoch == remoteTargetEpoch else { return }
        guard remoteExpectedDeviceKey == directoryTargetKey(forRawDeviceKey: pending.deviceKey) else {
            pendingDirectorySession = nil
            showToast(localized("远程会话连接已失效，请重新选择设备后重试"))
            return
        }
        guard remoteConnected,
              remoteInitialSessionReady,
              remoteInitialWorkspaceReady,
              !workspaceLoadFailed else { return }
        routePendingDirectorySession()
        pendingDirectorySession = nil
        selectedSessionID = pending.sessionID
        coreAdapter?.openRemoteSession(sessionID: pending.sessionID)
    }

    /// How long an open may be announced as a wait. Matched to HarmonyOS's
    /// `DeferredLoadingGate` cap and Android's `CONVERSATION_LOADING_MAX_VISIBLE_MS`.
    static let remoteConversationLoadingMaxVisibleNanoseconds: UInt64 = 20_000_000_000

    /// Mirrors HarmonyOS's deferred conversation-loading gate. Cached transcripts
    /// normally arrive inside the grace period; a relay fetch gets an explicit
    /// skeleton instead of leaving the previous session visible.
    func beginRemoteConversationOpen(sessionID: String) {
        remoteOpenedSessionID = nil
        remoteConversationLoadTask?.cancel()
        remoteConversationLoadGeneration &+= 1
        let generation = remoteConversationLoadGeneration
        remoteConversationOpeningSessionID = sessionID
        remoteConversationOpenStartedAt = ProcessInfo.processInfo.systemUptime
        mobilePerformanceLog.info("Remote session open started generation=\(generation, privacy: .public)")
        remoteConversationLoading = false
        selectedSessionID = sessionID
        timelineRows = []
        messages = []
        activeTurnID = nil
        isSending = false
        busy = true
        remoteHasMoreMessages = false
        remoteHistoryLoading = false
        remoteHistoryFailed = false
        remoteConversationLoadTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: 140_000_000)
            } catch {
                return
            }
            guard let self,
                  self.remoteConversationLoadGeneration == generation,
                  self.remoteConversationOpeningSessionID == sessionID else { return }
            self.remoteConversationLoading = true
            // What ends this wait is the transcript arriving. One that never
            // arrives would otherwise leave the skeleton standing for the rest
            // of the session, and a placeholder that outlives its subject reads
            // as a hang. Past the cap the pane stops saying "loading" and lets
            // whatever it does have speak for itself.
            do {
                try await Task.sleep(nanoseconds: Self.remoteConversationLoadingMaxVisibleNanoseconds)
            } catch {
                return
            }
            guard self.remoteConversationLoadGeneration == generation,
                  self.remoteConversationOpeningSessionID == sessionID else { return }
            self.remoteConversationLoading = false
        }
    }

    func finishRemoteConversationOpenIfReady(timelineSessionID: String) {
        guard remoteConversationOpeningSessionID == timelineSessionID else { return }
        if let startedAt = remoteConversationOpenStartedAt {
            let elapsedMS = Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1_000)
            mobilePerformanceLog.info(
                "Remote session timeline ready elapsed_ms=\(elapsedMS, privacy: .public) generation=\(self.remoteConversationLoadGeneration, privacy: .public)"
            )
        }
        resetRemoteConversationOpen()
    }

    func resetRemoteConversationOpen() {
        remoteConversationLoadTask?.cancel()
        remoteConversationLoadTask = nil
        remoteConversationLoadGeneration &+= 1
        remoteConversationOpeningSessionID = nil
        remoteConversationOpenStartedAt = nil
        remoteConversationLoading = false
    }

    private func advancePendingDirectoryRemoteDraftIfReady() {
        guard var pending = pendingDirectoryRemoteDraft,
              pending.targetKey == remoteExpectedDeviceKey,
              pending.epoch == remoteTargetEpoch,
              remoteConnected,
              remoteInitialSessionReady,
              remoteInitialWorkspaceReady,
              !workspaceLoadFailed else { return }

        guard authoritativeDirectoryRawDeviceKey == pending.rawDeviceKey else {
            pendingDirectoryRemoteDraft = nil
            showToast(localized("远程会话连接已失效，请重新选择设备后重试"))
            return
        }
        // ID-first: a pending draft that carries a workspace ID is satisfied only by that ID.
        let selectedScope = Self.workspaceScope(of: remoteSidebarWorkspaceState?.selected)
        if let selectedScope, selectedScope.refersTo(pending.scope) {
            guard remoteCreateInteraction.canSubmit else {
                mobilePerformanceLog.error("Directory create blocked connected=\(self.remoteConnected) switching=\(self.accountBusy) workspaceReady=\(self.remoteCreateWorkspacePhase == .ready) selecting=\(self.workspaceSelectionBusy) submitting=\(self.remoteCreateSubmitting) activeTurn=\(self.activeTurnID != nil) sending=\(self.isSending)")
                pendingDirectoryRemoteDraft = nil
                showToast(localized("远程会话当前不可创建，请重试"))
                return
            }
            pendingDirectoryRemoteDraft = nil
            surface = .remote
            drawerOpen = false
            createRemoteSession(
                agentType: pending.agentType, title: "", instruction: "",
                workspacePath: pending.workspacePath,
                remoteConnectionId: pending.remoteConnectionId, remoteSshHost: pending.remoteSshHost,
                workspaceId: pending.workspaceId
            )
            return
        }
        guard !pending.selectionRequested else { return }
        guard workspaceCatalog.contains(where: { Self.workspaceScope(of: $0).refersTo(pending.scope) }) else {
            pendingDirectoryRemoteDraft = nil
            showToast(localized("暂无可用工作区"))
            return
        }
        guard authoritativeDirectoryRawDeviceKey == pending.rawDeviceKey else {
            pendingDirectoryRemoteDraft = nil
            showToast(localized("远程会话连接已失效，请重新选择设备后重试"))
            return
        }
        pending.selectionRequested = true
        pendingDirectoryRemoteDraft = pending
        coreAdapter?.selectRemoteWorkspace(path: pending.workspacePath, remoteConnectionId: pending.remoteConnectionId, remoteSshHost: pending.remoteSshHost, workspaceId: pending.workspaceId)
    }

    func resizeRuntimeTerminal(cols: Int, rows: Int) { coreAdapter?.resizeRuntimeTerminal(cols: cols, rows: rows) }
    func openDeviceTools(connectionId: String? = nil) { coreAdapter?.openDeviceTools(connectionId: connectionId) }
    func selectDeviceToolsPanel(terminal: Bool) { coreAdapter?.selectDeviceToolsPanel(terminal: terminal) }
    func closeDeviceTools() { coreAdapter?.closeDeviceTools() }
    func startDeviceToolsTerminal() { coreAdapter?.startDeviceToolsTerminal() }
    func openDeviceFiles(_ path: String, connectionId: String?, workspaceId: String? = nil) { coreAdapter?.openDeviceFiles(path, connectionId: connectionId, workspaceId: workspaceId) }
    func openDeviceTerminal(_ path: String, connectionId: String?, workspaceId: String? = nil) { coreAdapter?.openDeviceTerminal(path, connectionId: connectionId, workspaceId: workspaceId) }
    func browseRuntimeDirectories(_ path: String, connectionId: String?, append: Bool = false) { coreAdapter?.browseRuntimeDirectories(path, connectionId: connectionId, append: append) }
    func sortRuntimeFiles(_ sort: RuntimeFileSort) { coreAdapter?.sortRuntimeFiles(sort) }
    func closeRuntimeFileEditor() { runtimeFileDraft.reset(); coreAdapter?.closeRuntimeFileEditor() }
    func browseRuntimeFiles(_ path: String, append: Bool = false) { coreAdapter?.browseRuntimeFiles(path, append: append) }
    func readRuntimeFile(_ path: String) { coreAdapter?.readRuntimeFile(path) }
    func saveRuntimeFile(_ content: String) { coreAdapter?.saveRuntimeFile(content) }
    func uploadRuntimeFile(_ path: String, url: URL) {
        do {
            let source = try IOSRuntimeUploadSource(url: url)
            guard let coreAdapter else { source.close(); return }
            coreAdapter.uploadRuntimeFile(path, source: source)
        } catch { showToast(localized("Could not read the selected file. Choose a local file and retry.")) }
    }
    func createRuntimeFileEntry(_ name: String, directory: Bool) { coreAdapter?.createRuntimeFileEntry(name, directory: directory) }
    func renameRuntimeFileEntry(_ path: String, name: String) { coreAdapter?.renameRuntimeFileEntry(path, name: name) }
    func deleteRuntimeFileEntry(_ path: String) { coreAdapter?.deleteRuntimeFileEntry(path) }
    func uploadRuntimeFileEntry(_ name: String, url: URL) -> Bool {
        do {
            let source = try IOSRuntimeUploadSource(url: url)
            guard let coreAdapter else { source.close(); return false }
            coreAdapter.uploadRuntimeFileEntry(name, source: source)
            return true
        } catch { showToast(localized("Could not read the selected file. Choose a local file and retry.")); return false }
    }
    func createRuntimeFile(_ path: String) { coreAdapter?.createRuntimeFile(path) }
    func renameRuntimeFile(_ path: String) { coreAdapter?.renameRuntimeFile(path) }
    func deleteRuntimeFile() { coreAdapter?.deleteRuntimeFile() }
    func createRuntimeDirectory(_ path: String) { coreAdapter?.createRuntimeDirectory(path) }
    func openRuntimeTerminal() { coreAdapter?.openRuntimeTerminal() }
    func reopenRuntimeTerminal() { coreAdapter?.reopenRuntimeTerminal() }
    func writeRuntimeTerminal(_ data: String) { coreAdapter?.writeRuntimeTerminal(data) }
    func closeRuntimeTerminal() { coreAdapter?.closeRuntimeTerminal() }

    func openRemoteWorkspacePath(_ path: String, connectionId: String?, sshHost: String? = nil) {
        let targetPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !targetPath.isEmpty, remoteConnected, remoteCreateInteraction.canSelectWorkspace else { return }
        pendingDirectoryRemoteDraft = nil
        surface = .remote
        workspaceSelectionBusy = true
        pendingRemoteSessionRefreshWorkspace = MobileWorkspaceScope(path: normalizedSessionWorkspacePath(targetPath), remoteConnectionId: connectionId, remoteSshHost: sshHost)
        coreAdapter?.selectRemoteWorkspace(path: targetPath, remoteConnectionId: connectionId, remoteSshHost: sshHost)
    }

    func selectRemoteWorkspace(_ workspace: MobileWorkspaceGroup) {
        pendingDirectoryRemoteDraft = nil
        guard remoteConnected, remoteCreateInteraction.canSelectWorkspace else {
            showToast(localized("请先连接桌面设备"))
            return
        }
        surface = .remote
        drawerOpen = false
        workspaceSelectionBusy = true
        pendingRemoteSessionRefreshWorkspace = MobileWorkspaceScope(path: normalizedSessionWorkspacePath(workspace.path), remoteConnectionId: workspace.remoteConnectionId, remoteSshHost: workspace.remoteSshHost, workspaceId: workspace.workspaceId)
        coreAdapter?.selectRemoteWorkspace(path: workspace.path, remoteConnectionId: workspace.remoteConnectionId, remoteSshHost: workspace.remoteSshHost, workspaceId: workspace.workspaceId)
    }

    func createRemoteSession(in workspace: MobileWorkspaceGroup, agentType: String) {
        pendingDirectoryRemoteDraft = nil
        guard remoteCreateInteraction.canSubmit else { return }
        drawerOpen = false
        surface = .remote
        createRemoteSession(
            agentType: agentType,
            title: "",
            instruction: "",
            workspacePath: workspace.path,
            remoteConnectionId: workspace.remoteConnectionId,
            remoteSshHost: workspace.remoteSshHost,
            workspaceId: workspace.workspaceId
        )
    }

    func createRemoteAssistantSession() {
        pendingDirectoryRemoteDraft = nil
        guard remoteCreateInteraction.canSubmit else { return }
        drawerOpen = false
        surface = .remote
        createRemoteSession(agentType: "Claw", title: "", instruction: "")
    }

    func createRemoteSessionFromHome(agentType: String = "code") {
        guard remoteCreateInteraction.canSubmit else {
            showToast(localized("远程会话当前不可创建，请重试"))
            return
        }
        if let workspace = remoteWorkspaces.first(where: \.selected) ?? remoteWorkspaces.first {
            createRemoteSession(in: workspace, agentType: agentType)
        } else {
            createRemoteAssistantSession()
        }
    }

    func selectRemoteAssistant(_ assistant: MobileAssistantOption) {
        guard remoteConnected, remoteCreateInteraction.canSelectWorkspace else { return }
        workspaceSelectionBusy = true
        // With an ID the shared store sends only `workspace_id`; the path is never a fallback.
        coreAdapter?.selectRemoteAssistant(path: assistant.path, workspaceId: assistant.workspaceId)
    }

    func createRemoteSession(
        agentType: String,
        title: String,
        instruction: String,
        modelID: String? = nil,
        workspacePath: String? = nil,
        remoteConnectionId: String? = nil,
        remoteSshHost: String? = nil,
        workspaceId: String? = nil
    ) {
        guard remoteCreateInteraction.canSubmit else {
            remoteCreateError = localized("远程会话当前不可创建，请重试")
            return
        }
        let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedInstruction = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        let selectedModel = modelID ?? modelOptions.first(where: \.selected)?.id
        let requestID = UUID().uuidString
        guard let deviceKey = remoteExpectedDeviceKey else {
            remoteCreateError = localized("未选择远程设备")
            return
        }
        guard coreAdapter != nil else {
            remoteCreateError = localized("远程连接尚未准备好，请重试")
            return
        }
        remoteCreateSubmitting = true
        remoteCreateError = nil
        remoteCreateRequestID = requestID
        remoteCreateRequestEpoch = remoteTargetEpoch
        remoteCreateRequestDeviceKey = deviceKey
        coreAdapter?.createRemoteSession(
            requestID: requestID,
            agentType: workspacePath == nil ? "Claw" : agentType,
            title: normalizedTitle,
            instruction: normalizedInstruction,
            modelID: selectedModel,
            workspacePath: workspacePath,
            remoteConnectionId: remoteConnectionId,
            remoteSshHost: remoteSshHost,
            workspaceId: workspacePath == nil ? nil : workspaceId
        )
        surface = .remote
    }

    private func clearRemoteCreateRequestMetadata() {
        remoteCreateRequestID = nil
        remoteCreateRequestEpoch = 0
        remoteCreateRequestDeviceKey = nil
    }

    func failRemoteCreate(requestID: String, targetKey: String?) {
        guard remoteCreateRequestID == requestID,
              remoteCreateRequestEpoch == remoteTargetEpoch,
              targetKey == nil || remoteCreateRequestDeviceKey == targetKey else { return }
        remoteCreateSubmitting = false
        clearRemoteCreateRequestMetadata()
        remoteCreateError = localized("远程会话连接已失效，请重新选择设备后重试")
    }

    func apply(createOperation state: CreateSessionOperationState, targetKey: String) {
        guard !remoteCreatePreview else { return }
        let operationRequestID: String?
        switch state {
        case let value as CreateSessionOperationStateInFlight: operationRequestID = value.requestId
        case let value as CreateSessionOperationStateSucceeded: operationRequestID = value.requestId
        case let value as CreateSessionOperationStateFailed: operationRequestID = value.requestId
        case let value as CreateSessionOperationStateCancelled: operationRequestID = value.requestId
        default: operationRequestID = nil
        }
        guard let requestID = remoteCreateRequestID,
              operationRequestID == requestID,
              remoteCreateRequestEpoch == remoteTargetEpoch,
              remoteCreateRequestDeviceKey == targetKey else {
            return
        }
        switch state {
        case is CreateSessionOperationStateInFlight:
            remoteCreateSubmitting = true
        case let succeeded as CreateSessionOperationStateSucceeded:
            guard let confirmed = succeeded.confirmedSession,
                  !succeeded.createdSessionId.isEmpty,
                  confirmed.id == succeeded.createdSessionId else {
                remoteCreateSubmitting = false
                remoteCreateRequestID = nil
                remoteCreateError = localized("远程会话创建结果无效，请刷新后重试")
                coreAdapter?.refreshRemoteSessions()
                return
            }
            let session = ChatSession(
                id: confirmed.id,
                title: confirmed.title.isEmpty ? localized("未命名会话") : confirmed.title,
                updatedLabel: confirmed.updatedAt,
                status: confirmed.status,
                agentType: confirmed.agentType,
                workspacePath: confirmed.workspacePath,
                workspaceName: confirmed.workspaceName,
                workspaceScope: confirmed.workspaceIdentity.map(Self.workspaceScope(of:)),
                createdAt: confirmed.createdAt,
                messageCount: Int(confirmed.messageCount)
            )
            let authorityAlreadyApplied = RemoteAuthorityGate.succeededIsAlreadyAuthoritative(
                targetKey: targetKey,
                epoch: remoteTargetEpoch,
                commitRevision: succeeded.commitRevision,
                confirmedSessionVisible: remoteSessions.contains { $0.id == session.id },
                lastApplied: remoteLastAppliedAuthority
            )
            committedRemoteCreate = authorityAlreadyApplied ? nil : CommittedRemoteCreate(
                targetKey: targetKey,
                epoch: remoteTargetEpoch,
                session: session,
                minimumAuthorityRevision: succeeded.commitRevision
            )
            remoteCreateSubmitting = false
            remoteCreateError = nil
            remoteCreateRequestID = nil
            remoteCreateOpen = false
            selectedSessionID = session.id
            remoteSessionSelected = true
            surface = .remote
            remoteSessions.removeAll { $0.id == session.id }
            remoteSessions.insert(session, at: 0)
            rebuildRemoteWorkspaceGroups()
        case let failed as CreateSessionOperationStateFailed:
            remoteCreateSubmitting = false
            remoteCreateError = failed.unsupported
                ? localized("桌面端不支持创建此类会话")
                : localized("创建远程会话失败，请重试")
            remoteCreateRequestID = nil
        case is CreateSessionOperationStateCancelled:
            remoteCreateSubmitting = false
            remoteCreateError = localized("创建远程会话已取消")
            remoteCreateRequestID = nil
        case is CreateSessionOperationStateIdle:
            if remoteCreateSubmitting {
                remoteCreateSubmitting = false
                remoteCreateError = localized("创建远程会话已结束，请重试")
                remoteCreateRequestID = nil
            }
        default:
            break
        }
        if !remoteCreateOpen, !remoteCreateSubmitting, let error = remoteCreateError {
            showToast(error)
        }
    }

    func deleteRemoteSession(_ session: ChatSession) {
        guard !busy else { return }
        coreAdapter?.deleteRemoteSession(sessionID: session.id)
        if selectedSessionID == session.id {
            remoteSessionSelected = false
            timelineRows = []
            messages = []
        }
    }

    func searchRemoteSessions(_ query: String) {
        remoteQuery = query
        guard remoteConnected else { return }
        coreAdapter?.searchRemoteSessions(query: query)
    }

    func loadMoreRemoteSessions() {
        guard remoteConnected, remoteHasMore, !busy else { return }
        coreAdapter?.loadMoreRemoteSessions()
    }

    func loadOlderRemoteMessages() {
        guard surface == .remote, remoteConnected, remoteHasMoreMessages, !busy else { return }
        coreAdapter?.loadOlderRemoteMessages()
    }

    func refreshRemoteSessions() {
        guard remoteConnected, !busy else { return }
        coreAdapter?.refreshRemoteSessions()
    }

    func retryRemoteConnection() {
        // Recovery must reach the shared stores even while the link is down.
        // The adapter owns the current target; stores preserve the transcript
        // and reject superseded work through their existing lifecycle fences.
        coreAdapter?.refreshRemoteSessions()
        coreAdapter?.loadRemoteWorkspaces()
    }

    func setRemoteAgentFilter(_ name: String) {
        let filter: SessionAgentFilter
        switch name {
        case "CODE": filter = .code
        case "COWORK": filter = .cowork
        default: filter = .all
        }
        remoteAgentFilter = name
        coreAdapter?.setRemoteAgentFilter(filter)
    }

    func refreshRemotePermissionMode() {
        guard remoteConnected else { return }
        coreAdapter?.refreshRemotePermissionMode()
    }

    func setRemotePermissionMode(_ name: String) {
        let mode: SessionPermissionMode
        switch name {
        case "AUTO": mode = .auto
        case "FULL_ACCESS": mode = .fullAccess
        default: mode = .ask
        }
        coreAdapter?.setRemotePermissionMode(mode)
    }

    func retryRemoteWorkspaces() {
        guard remoteExpectedDeviceKey != nil,
              remoteCreateWorkspacePhase != .loading,
              !workspaceSelectionBusy else { return }
        remoteCreateWorkspacePhase = .loading
        workspaceLoading = true
        workspaceLoadFailed = false
        coreAdapter?.loadRemoteWorkspaces()
    }

    var remoteSendSessionID: String? {
        guard coreAdapter != nil else { return nil }
        return RemoteAuthorityGate.sendSessionID(
            selectedSessionID: remoteSessionSelected ? selectedSessionID : nil,
            openedSessionID: remoteOpenedSessionID,
            connected: remoteConnected && connectionPhase == .connected,
            busy: busy,
            sending: false // An active remote turn accepts steering or legacy queued messages.
        )
    }

    @discardableResult
    func sendRemote() -> Bool {
        let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty || !composerImages.isEmpty,
              let sessionID = remoteSendSessionID,
              let coreAdapter else { return false }
        mobilePerformanceLog.info("Composer send accepted characters=\(value.count) rows=\(self.timelineRows.count) user_rows=\(self.timelineRows.filter { $0.kind == "USER" }.count) generation=\(self.composerSendGeneration)")
        let images = composerImages
        pendingComposerSend = PendingComposerSend(
            sessionID: sessionID, text: draft, images: images,
            previousAckID: lastAppliedRemoteSendID
        )
        draft = ""
        composerImages = []
        composerSendGeneration &+= 1
        isSending = true
        busy = true
        coreAdapter.sendRemote(sessionID: sessionID, content: value, images: images)
        return true
    }

    private func settleComposerSend(ack: SentChatMessage? = nil) {
        guard let pending = pendingComposerSend else { return }
        let succeeded = ack.map {
            $0.sessionId == pending.sessionID && $0.id != pending.previousAckID &&
                $0.content == pending.text.trimmingCharacters(in: .whitespacesAndNewlines)
        } ?? false
        pendingComposerSend = nil
        if ComposerSendSettlementPolicy.shouldRestore(
            sentSession: pending.sessionID, currentSession: selectedSessionID,
            acknowledged: succeeded, draftIsEmpty: draft.isEmpty,
            attachmentsAreEmpty: composerImages.isEmpty
        ) {
            draft = pending.text
            composerImages = pending.images
        }
    }

    func buildRemotePlan(path: String, name: String) {
        guard remoteHostCapabilities.contains("plan_build_v1"), !isSending,
              let sessionID = remoteSendSessionID, !path.isEmpty else { return }
        busy = true
        coreAdapter?.buildRemotePlan(sessionID: sessionID, path: path, name: name)
    }

    func approveTool(_ toolID: String, updatedInput: String? = nil) {
        guard surface == .remote, remoteSessionSelected, !toolID.isEmpty else { return }
        coreAdapter?.approveRemoteTool(sessionID: selectedSessionID, toolID: toolID, updatedInput: updatedInput)
    }

    func rejectTool(_ toolID: String) {
        guard surface == .remote, remoteSessionSelected, !toolID.isEmpty else { return }
        coreAdapter?.rejectRemoteTool(
            sessionID: selectedSessionID,
            toolID: toolID,
            reason: "Rejected from the iOS client"
        )
    }

    func cancelTool(_ toolID: String) {
        guard surface == .remote, remoteSessionSelected, !toolID.isEmpty else { return }
        coreAdapter?.cancelRemoteTool(
            sessionID: selectedSessionID,
            toolID: toolID,
            reason: "Cancelled from the iOS client"
        )
    }

    func answerTool(_ toolID: String, answer: String) {
        let normalized = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard surface == .remote,
              remoteSessionSelected,
              !toolID.isEmpty,
              !normalized.isEmpty else { return }
        coreAdapter?.answerRemoteTool(
            sessionID: selectedSessionID,
            toolID: toolID,
            answer: normalized
        )
    }

    func answerTool(_ toolID: String, answers: [QuestionAnswer]) {
        guard surface == .remote,
              remoteSessionSelected,
              !toolID.isEmpty,
              !answers.isEmpty else { return }
        coreAdapter?.answerRemoteToolStructured(
            sessionID: selectedSessionID,
            toolID: toolID,
            answers: answers
        )
    }

    func apply(remoteState state: RemoteSessionUiState, targetKey: String, epoch: UInt64) {
        guard !localActionPreview, !accountLoginPreview, !remoteCreatePreview else { return }
        guard RemoteAuthorityGate.callbackMatchesAuthority(
            targetKey: targetKey,
            epoch: epoch,
            expectedTargetKey: remoteExpectedDeviceKey,
            expectedEpoch: remoteTargetEpoch
        ) else { return }
        guard let ready = state as? RemoteSessionUiStateReady else {
            permissionMailbox = nil
            remoteOpenedSessionID = nil
            remoteInitialSessionReady = false
            if let failed = state as? RemoteSessionUiStateFailed {
                settleComposerSend()
                resetRemoteConversationOpen()
                let detail = failed.remoteMessage ?? failed.reason.name
                remoteConnected = false
                connectionPhase = .disconnected
                let clearingVisibleRemoteConversation = surface == .remote || remoteSessionSelected
                remoteSessionSelected = false
                if clearingVisibleRemoteConversation {
                    selectedSessionID = ""
                    activeTurnID = nil
                    isSending = false
                    busy = false
                    timelineRows = []
                    messages = []
                }
                pendingDirectorySession = nil
                pendingDirectoryWorkspace = nil
                if pendingDirectoryRemoteDraft?.targetKey == targetKey,
                   pendingDirectoryRemoteDraft?.epoch == epoch {
                    pendingDirectoryRemoteDraft = nil
                    showToast(localized("远程会话连接已失效，请重新选择设备后重试"))
                }
                coreErrorMessage = detail
                remoteCreateOpen = false
                remoteCreateSubmitting = false
                clearRemoteCreateRequestMetadata()
                remoteCreateError = detail

            }
            return
        }
        guard RemoteAuthorityGate.acceptsReady(
            targetKey: targetKey,
            epoch: epoch,
            revision: ready.revision,
            lastApplied: remoteLastAppliedAuthority
        ) else { return }
        setPublishedIfChanged(\.remoteOpenedSessionID, to: ready.timeline?.sessionId)
        permissionMailbox = ready.permissionMailbox
        completionNotifier.observe(state, target: "\(targetKey):\(epoch)")
        remoteLastAppliedAuthority = RemoteAuthorityGate.updatedScope(
            targetKey: targetKey,
            epoch: epoch,
            revision: ready.revision,
            lastApplied: remoteLastAppliedAuthority
        )
        remoteInitialSessionReady = remoteInitialSessionReady || !ready.busy
        setPublishedIfChanged(\.surface, to: .remote)
        let committed = committedRemoteCreate
        let projectionDecision = RemoteAuthorityGate.committedProjectionDecision(
            readyTargetKey: targetKey,
            readyEpoch: epoch,
            readyRevision: ready.revision,
            committedTargetKey: committed?.targetKey,
            committedEpoch: committed?.epoch,
            minimumAuthorityRevision: committed?.minimumAuthorityRevision,
            confirmedSessionVisible: committed.map { marker in
                ready.sessions.contains { $0.id == marker.session.id }
            } ?? false
        )
        if !projectionDecision.retainMarker {
            committedRemoteCreate = nil
        }
        var projectedSessions = ready.sessions.map { session in
            ChatSession(
                id: session.id,
                title: session.title.isEmpty ? localized("未命名会话") : session.title,
                updatedLabel: session.updatedAt,
                status: session.status,
                agentType: session.agentType,
                workspacePath: session.workspacePath,
                workspaceName: session.workspaceName,
                workspaceScope: session.workspaceIdentity.map(Self.workspaceScope(of:)),
                createdAt: session.createdAt,
                messageCount: Int(session.messageCount)
            )
        }
        if let committed, projectionDecision.protectCommittedRowAndSelection {
            projectedSessions.removeAll { $0.id == committed.session.id }
            projectedSessions.insert(committed.session, at: 0)
        }
        setPublishedIfChanged(\.remoteSessions, to: projectedSessions)
        rebuildRemoteWorkspaceGroups()
        if let protected = committedRemoteCreate,
           protected.targetKey == targetKey,
           protected.epoch == epoch {
            setPublishedIfChanged(\.selectedSessionID, to: protected.session.id)
            setPublishedIfChanged(\.remoteSessionSelected, to: true)
        } else {
            let openingSessionIsNotReady = remoteConversationOpeningSessionID.map { opening in
                ready.timeline?.sessionId != opening
            } ?? false
            if !openingSessionIsNotReady, let selected = ready.selectedSessionId {
                setPublishedIfChanged(\.selectedSessionID, to: selected)
            }
            setPublishedIfChanged(
                \.remoteSessionSelected,
                to: openingSessionIsNotReady || ready.selectedSessionId != nil
            )
        }
        setPublishedIfChanged(\.busy, to: ready.busy)
        if !ready.busy { settleComposerSend(ack: ready.lastSentMessage) }
        if let sent = ready.lastSentMessage,
           sent.sessionId == selectedSessionID,
           sent.id != lastAppliedRemoteSendID {
            lastAppliedRemoteSendID = sent.id
        }
        setPublishedIfChanged(\.remoteQuery, to: ready.query)
        setPublishedIfChanged(\.remoteAgentFilter, to: ready.agentFilter.name)
        setPublishedIfChanged(\.remoteHasMore, to: ready.hasMore)
        setPublishedIfChanged(\.remoteHasMoreMessages, to: ready.hasMoreMessages)
        setPublishedIfChanged(\.remoteHistoryLoading, to: ready.historyLoadState == .loading)
        setPublishedIfChanged(\.remoteHistoryFailed, to: ready.historyLoadState == .failed)
        setPublishedIfChanged(\.remotePermissionMode, to: ready.permissionMode?.name ?? remotePermissionMode)
        setPublishedIfChanged(\.remotePermissionFailure, to: ready.permissionModeFailure?.name)
        let acceptsTimeline = remoteConversationOpeningSessionID.map {
            ready.timeline?.sessionId == $0
        } ?? true
        activeTurnID = acceptsTimeline ? ready.timeline?.activeTurn?.turnId : nil
        setPublishedIfChanged(\.isSending, to: acceptsTimeline && ready.timeline?.activeTurn != nil)
        let projectedModelOptions = ready.createModelOptions(fallbackLabel: localized("模型")).map { option in
            ComposerModelOption(
                id: option.id,
                primaryLabel: option.primaryLabel,
                secondaryLabel: option.secondaryLabel,
                source: "REMOTE",
                selected: option.selected
            )
        }
        setPublishedIfChanged(\.modelOptions, to: projectedModelOptions)
        if acceptsTimeline, let timeline = ready.timeline {
            let projectedRows = MobileConversationRow.reconcile(
                timeline.conversationRows().map(Self.mapConversationRow), with: timelineRows)
            if timelineRows != projectedRows {
                let users = projectedRows.filter { $0.kind == "USER" }
                let previousUsers = timelineRows.filter { $0.kind == "USER" }
                let removedUsers = Set(previousUsers.map(\.id)).subtracting(users.map(\.id)).count
                mobilePerformanceLog.info("Timeline projection rows=\(projectedRows.count) user_rows=\(users.count) previous_user_rows=\(previousUsers.count) removed_user_ids=\(removedUsers) pending_users=\(users.filter(\.pending).count) live_rows=\(projectedRows.filter(\.live).count) blocks=\(projectedRows.reduce(0) { $0 + $1.blocks.count }) busy=\(ready.busy)")
                #if DEBUG
                if users.map(\.id) != previousUsers.map(\.id) {
                    let identities = timeline.persistedMessages.filter { $0.role == "user" }.map {
                        "id=\($0.id),turn=\($0.turnId ?? "none"),time=\($0.timestamp ?? "none"),chars=\($0.text.count)"
                    }.joined(separator: ";")
                    mobilePerformanceLog.info("Timeline user identities session=\(timeline.sessionId, privacy: .public) persisted=\(identities, privacy: .public) optimistic=\(timeline.optimisticMessages.count)")
                }
                #endif
                timelineRows = projectedRows
                messages = projectedRows.compactMap { row in
                    guard row.kind != "EMPTY" else { return nil }
                    return ChatMessage(
                        id: UUID(uuidString: row.id) ?? UUID(),
                        role: row.kind == "USER" ? .user : .assistant,
                        text: row.text
                    )
                }
            }
            finishRemoteConversationOpenIfReady(timelineSessionID: timeline.sessionId)
        } else {
            setPublishedIfChanged(\.timelineRows, to: [])
            setPublishedIfChanged(\.messages, to: [])
        }
        if let pending = pendingDirectoryWorkspace,
           remoteExpectedDeviceKey == directoryTargetKey(forRawDeviceKey: pending.deviceKey),
           pending.epoch == remoteTargetEpoch,
           remoteConnected,
           remoteInitialWorkspaceReady {
            pendingDirectoryWorkspace = nil
            pendingRemoteSessionRefreshWorkspace = MobileWorkspaceScope(path: normalizedSessionWorkspacePath(pending.path), remoteConnectionId: pending.remoteConnectionId, remoteSshHost: pending.remoteSshHost, workspaceId: pending.workspaceId)
            coreAdapter?.selectRemoteWorkspace(path: pending.path, remoteConnectionId: pending.remoteConnectionId, remoteSshHost: pending.remoteSshHost, workspaceId: pending.workspaceId)
        }
        openPendingDirectorySessionIfReady()
        advancePendingDirectoryRemoteDraftIfReady()
    }

    func apply(
        remoteConnectionPhase phase: OpenBitFunMobileCore.ConnectionPhase,
        targetKey: String,
        epoch: UInt64
    ) {
        #if DEBUG
        let targetMatches = targetKey == remoteExpectedDeviceKey
        mobilePerformanceLog.info("Remote health model: phase=\(phase.name, privacy: .public) epoch=\(epoch) expectedEpoch=\(self.remoteTargetEpoch) targetMatches=\(targetMatches) preview=\(self.localActionPreview || self.accountLoginPreview || self.remoteCreatePreview)")
        #endif
        guard !localActionPreview, !accountLoginPreview, !remoteCreatePreview,
              RemoteAuthorityGate.callbackMatchesAuthority(
                targetKey: targetKey,
                epoch: epoch,
                expectedTargetKey: remoteExpectedDeviceKey,
                expectedEpoch: remoteTargetEpoch
              ) else { return }
        switch phase.name {
        case "CONNECTED":
            remoteConnected = true
            connectionPhase = .connected
        case "CONNECTING", "RECONNECTING":
            remoteConnected = true
            connectionPhase = .reconnecting
        default:
            remoteConnected = false
            connectionPhase = .disconnected
        }
        if phase.name == "CONNECTED" || phase.name == "RECONNECTING" {
            promoteLiveAccountTargetPresence(targetKey: targetKey)
        }
    }

    func apply(workspaceState state: RemoteWorkspaceUiState, targetKey: String, epoch: UInt64) {
        guard !localActionPreview, !accountLoginPreview, !remoteCreatePreview,
              RemoteAuthorityGate.callbackMatchesAuthority(
                targetKey: targetKey,
                epoch: epoch,
                expectedTargetKey: remoteExpectedDeviceKey,
                expectedEpoch: remoteTargetEpoch
              ) else { return }
        let readyState = state as? RemoteWorkspaceUiStateReady
        if readyState == nil { savedRuntimeConnections = [] }
        workspaceLoading = state is RemoteWorkspaceUiStateLoading || readyState?.busy == true
        workspaceLoadFailed = state is RemoteWorkspaceUiStateFailed || readyState?.loadFailure == true
        workspaceSelectionBusy = (state as? RemoteWorkspaceUiStateReady)?.busy ?? false
        if state is RemoteWorkspaceUiStateLoading || readyState?.busy == true {
            remoteCreateWorkspacePhase = .loading
        } else if state is RemoteWorkspaceUiStateFailed || readyState?.loadFailure == true {
            remoteCreateWorkspacePhase = .failed
        }
        if !(state is RemoteWorkspaceUiStateReady) || readyState?.busy == true || readyState?.loadFailure == true {
            remoteInitialWorkspaceReady = false
        }
        if state is RemoteWorkspaceUiStateFailed || readyState?.loadFailure == true {
            if pendingDirectorySession != nil {
                pendingDirectorySession = nil
                resetRemoteConversationOpen()
                remoteSessionSelected = false
                busy = false
                showToast(localized("工作区加载失败，点按重试"))
            }
            pendingRemoteSessionRefreshWorkspace = nil
            if pendingRemoteWorkspaceCreate != nil || pendingRemoteAssistantCreate ||
                pendingDirectoryRemoteDraft != nil {
                pendingRemoteWorkspaceCreate = nil
                pendingDirectoryRemoteDraft = nil
                pendingRemoteAssistantCreate = false
                showToast(localized("工作区加载失败，点按重试"))
            }
            return
        }
        guard let ready = state as? RemoteWorkspaceUiStateReady else { return }

        runtimeDeviceTools = ready.deviceTools
        runtimeTerminal = ready.terminal
        runtimeFiles = ready.files
        if let file = ready.files.file {
            runtimeFileDraft.synchronize(
                identity: [remoteExpectedDeviceKey ?? "", ready.deviceTools.connectionId ?? "", file],
                savedContent: ready.files.content
            )
        }
        runtimeDirectoryPicker = ready.directoryPicker
        savedRuntimeConnections = ready.savedConnections
        savedRuntimeConnectionsFailed = ready.savedConnectionsFailure
        remoteHostCapabilities = ready.hostCapabilities
        workspaceLoading = ready.busy
        workspaceLoadFailed = ready.loadFailure
        workspaceSelectionBusy = ready.busy
        remoteCreateWorkspacePhase = ready.loadFailure ? .failed : (ready.busy ? .loading : .ready)
        remoteInitialWorkspaceReady = !ready.busy && !ready.loadFailure
        selectedRemoteWorkspaceKind = ready.selected?.kind ?? ""
        remoteSidebarWorkspaceState = ready
        workspaceCatalog = RemoteSidebarPresentation.shared.workspacesForSessions(
            workspaceState: ready, sessions: []
        ).map { ($0.path, $0.name, $0.selected, $0.remoteConnectionId, $0.remoteSshHost, $0.workspaceId) }
        remoteAssistants = ready.assistants.map {
            MobileAssistantOption(path: $0.path, name: $0.name, workspaceId: $0.workspaceId)
        }
        rebuildRemoteWorkspaceGroups()

        apply(filePreviewState: ready.preview)
        apply(downloadState: ready.download)
        if let pending = pendingRemoteWorkspaceCreate,
           ready.selected?.path == pending.path {
            pendingRemoteWorkspaceCreate = nil
            createRemoteSession(agentType: pending.agentType, title: "", instruction: "")
        }
        if pendingRemoteAssistantCreate,
           ready.selected?.kind.lowercased() == "assistant" {
            pendingRemoteAssistantCreate = false
            createRemoteSession(agentType: "Claw", title: "", instruction: "")
        }
        if !ready.busy, let pendingScope = pendingRemoteSessionRefreshWorkspace {
            pendingRemoteSessionRefreshWorkspace = nil
            if let selectedScope = Self.workspaceScope(of: ready.selected), selectedScope.refersTo(pendingScope) {
                coreAdapter?.refreshRemoteSessions()
            }
        }
        advancePendingDirectoryRemoteDraftIfReady()
    }

    func rebuildRemoteWorkspaceGroups() {
        let rows = RemoteSidebarPresentation.shared.workspacesForSessions(
            workspaceState: remoteSidebarWorkspaceState, sessions: sessionListCoreSessions
        )
        let projectedWorkspaces = rows.map { workspace in
            let ownedIDs = Set(workspace.sessions.map { $0.id })
            return MobileWorkspaceGroup(
                workspaceId: workspace.workspaceId,
                path: workspace.path,
                name: workspace.name.isEmpty ? workspace.path : workspace.name,
                selected: workspace.selected,
                sessions: remoteSessions.filter { ownedIDs.contains($0.id) },
                remoteConnectionId: workspace.remoteConnectionId,
                remoteSshHost: workspace.remoteSshHost
            )
        }
        setPublishedIfChanged(\.remoteWorkspaces, to: projectedWorkspaces)
    }

    static func workspaceScope(of identity: RemoteWorkspaceIdentity) -> MobileWorkspaceScope {
        MobileWorkspaceScope(path: identity.path, remoteConnectionId: identity.remoteConnectionId,
            remoteSshHost: identity.remoteSshHost, workspaceId: identity.workspaceId)
    }

    static func workspaceScope(of entry: WorkspaceCatalogEntry) -> MobileWorkspaceScope {
        MobileWorkspaceScope(path: entry.path, remoteConnectionId: entry.remoteConnectionId,
            remoteSshHost: entry.remoteSshHost, workspaceId: entry.workspaceId)
    }

    static func workspaceScope(of selected: SelectedWorkspace?) -> MobileWorkspaceScope? {
        guard let selected else { return nil }
        return MobileWorkspaceScope(path: selected.path, remoteConnectionId: selected.remoteConnectionId,
            remoteSshHost: selected.remoteSshHost, workspaceId: selected.workspaceId)
    }

    /// The selected workspace as the phone last saw it from the host catalog.
    var selectedWorkspaceScope: MobileWorkspaceScope? {
        workspaceCatalog.first(where: { $0.selected }).map(Self.workspaceScope(of:))
    }

    private func setPublishedIfChanged<Value: Equatable>(
        _ keyPath: ReferenceWritableKeyPath<MobileAppModel, Value>,
        to value: Value
    ) {
        guard self[keyPath: keyPath] != value else { return }
        self[keyPath: keyPath] = value
    }
}

extension MobileAppModel {
    var sessionListWorkspaceOptions: [MobileSessionWorkspaceOption] {
        SessionListPresentation.shared
            .workspaceOptions(sessions: sessionListCoreSessions, workspace: sessionListWorkspaceContext)
            .map {
                MobileSessionWorkspaceOption(
                    path: $0.path, name: $0.name, workspaceId: $0.workspaceId,
                    remoteConnectionId: $0.remoteConnectionId, remoteSshHost: $0.remoteSshHost, key: $0.key
                )
            }
    }

    var sessionListAgentGroups: [String] {
        SessionListPresentation.shared
            .agentGroups(sessions: sessionListCoreSessions, workspace: sessionListWorkspaceContext)
            .map(\.name)
    }

    var sessionListStatusOptions: [String] {
        SessionListPresentation.shared.statusOptions(sessions: sessionListCoreSessions)
    }

    var sessionListSections: [MobileSessionListSectionProjection] {
        let groupMode: SessionGroupMode = switch remoteGroupMode {
        case "TIME": .time
        case "CHAT": .chat
        default: .project
        }
        let agentFilter: SessionAgentGroup? = switch remoteViewAgentFilter {
        case "CHAT": .chat
        case "CODE": .code
        case "COWORK": .cowork
        default: nil
        }
        let view = SessionListPresentation.shared.view(
            sessions: sessionListCoreSessions,
            workspace: sessionListWorkspaceContext,
            options: SessionListOptions(
                groupMode: groupMode,
                query: "",
                workspaceFilter: remoteWorkspaceFilter,
                agentFilter: agentFilter,
                statusFilter: remoteStatusFilter
            ),
            nowMs: Int64(Date().timeIntervalSince1970 * 1_000)
        )
        let byID = Dictionary(uniqueKeysWithValues: remoteSessions.map { ($0.id, $0) })
        return view.sections.compactMap { section in
            switch onEnum(of: section) {
            case .chat(let value):
                return projection(id: "chat", kind: .chat, section: value, byID: byID)
            case .project(let value):
                // Keyed by `workspaceId ?: legacy triple`, so same-path workspaces stay separate sections.
                return MobileSessionListSectionProjection(
                    id: "project:\(value.key)",
                    kind: .project,
                    path: value.path,
                    name: value.name,
                    sessions: value.sessions.compactMap { byID[$0.id] },
                    workspaceScope: Self.workspaceScope(of: value.identity)
                )
            case .today(let value):
                return projection(id: "today", kind: .today, section: value, byID: byID)
            case .yesterday(let value):
                return projection(id: "yesterday", kind: .yesterday, section: value, byID: byID)
            case .earlier(let value):
                return projection(id: "earlier", kind: .earlier, section: value, byID: byID)
            }
        }
    }

    private var sessionListCoreSessions: [RemoteSession] {
        remoteSessions.map { session in
            RemoteSession(
                id: session.id,
                title: session.title,
                agentType: session.agentType,
                status: session.status,
                updatedAt: session.updatedLabel,
                createdAt: session.createdAt,
                messageCount: Int32(session.messageCount),
                workspacePath: session.workspacePath,
                workspaceName: session.workspaceName,
                workspaceIdentity: session.workspaceScope.map {
                    RemoteWorkspaceIdentity(path: $0.path, remoteConnectionId: $0.remoteConnectionId, remoteSshHost: $0.remoteSshHost, workspaceId: $0.workspaceId)
                },
                // These rows are already past the visibility filter, so they
                // have no parent left to declare.
                parentSessionId: nil,
                relationshipKind: nil
            )
        }
    }

    /// The catalog the shared projection groups sessions with. Rows keep their
    /// workspace IDs and host-declared kinds; assistants are recognised through
    /// their catalog row (ID-first), never through a set of paths.
    private var sessionListWorkspaceContext: SessionWorkspaceContext {
        if let ready = remoteSidebarWorkspaceState {
            let recent = ready.catalog?.workspaces ?? (ready.assistants.map {
                RecentWorkspace(path: $0.path, name: $0.name, lastOpened: "", kind: "assistant", remoteSshHost: nil, remoteConnectionId: nil, workspaceId: $0.workspaceId)
            } + ready.workspaces)
            let selected = ready.selected
            return SessionWorkspaceContext(
                selectedPath: selected?.path ?? "",
                selectedName: selected?.name ?? "",
                selectedKind: selected?.kind ?? "",
                recent: recent,
                selectedWorkspaceId: selected?.workspaceId,
                selectedRemoteConnectionId: selected?.remoteConnectionId,
                selectedRemoteSshHost: selected?.remoteSshHost
            )
        }
        // No host catalog yet (cached or preview rows): the projected groups are all there is.
        let selected = remoteWorkspaces.first(where: \.selected)
        func isAssistant(_ workspace: MobileWorkspaceGroup) -> Bool {
            remoteAssistants.contains { assistant in
                MobileWorkspaceScope(path: assistant.path, remoteConnectionId: nil, remoteSshHost: nil, workspaceId: assistant.workspaceId)
                    .refersTo(workspace.scope)
            }
        }
        let recent = remoteWorkspaces.map { workspace in
            RecentWorkspace(
                path: workspace.path,
                name: workspace.name,
                lastOpened: "",
                kind: isAssistant(workspace) ? "assistant" : "normal",
                remoteSshHost: workspace.remoteSshHost,
                remoteConnectionId: workspace.remoteConnectionId,
                workspaceId: workspace.workspaceId
            )
        }
        return SessionWorkspaceContext(
            selectedPath: selected?.path ?? "",
            selectedName: selected?.name ?? "",
            selectedKind: selected.map { isAssistant($0) ? "assistant" : "normal" } ?? "",
            recent: recent,
            selectedWorkspaceId: selected?.workspaceId,
            selectedRemoteConnectionId: selected?.remoteConnectionId,
            selectedRemoteSshHost: selected?.remoteSshHost
        )
    }

    private func projection(
        id: String,
        kind: MobileSessionListSectionKind,
        section: any SessionListSection,
        byID: [String: ChatSession]
    ) -> MobileSessionListSectionProjection {
        MobileSessionListSectionProjection(
            id: id,
            kind: kind,
            path: "",
            name: "",
            sessions: section.sessions.compactMap { byID[$0.id] }
        )
    }

    private func normalizedSessionWorkspacePath(_ path: String) -> String {
        var result = path.trimmingCharacters(in: .whitespacesAndNewlines)
        while result.count > 1 && (result.hasSuffix("/") || result.hasSuffix("\\")) {
            result.removeLast()
        }
        return result
    }
}
