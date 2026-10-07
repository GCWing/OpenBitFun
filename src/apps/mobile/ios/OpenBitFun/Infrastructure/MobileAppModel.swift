import Foundation
import SwiftUI
import OpenBitFunMobileCore

@MainActor
final class MobileAppModel: ObservableObject {
    @Published var appLanguage: MobileLanguage = MobileLocalization.restoredLanguage()
    @Published var surface: MobileSurface = .remote
    @Published var sessions: [ChatSession]
    @Published var remoteSessions: [ChatSession] = []
    @Published var remoteQuery = ""
    @Published var remoteAgentFilter = "ALL"
    @Published var remoteViewAgentFilter = ""
    @Published var remoteGroupMode = "PROJECT"
    @Published var remoteWorkspaceFilter = ""
    @Published var remoteStatusFilter = ""
    @Published var remoteShowWorkspaceMetadata = false
    @Published var remoteShowUpdatedMetadata = false
    @Published var remoteShowStatusMetadata = false
    @Published var remoteViewSettingsOpen = false
    @Published var remoteHasMore = false
    @Published var remoteHasMoreMessages = false
    @Published var remoteHistoryLoading = false
    @Published var remoteHistoryFailed = false
    /// The rows on screen are this device's stored copy, not the host's
    /// transcript: a reopened session shows them at once, and the host has not
    /// answered for it yet. See `ChatTranscriptOrigin`.
    @Published var remoteTranscriptUnconfirmed = false
    @Published var permissionMailbox: PermissionMailboxUiState?
    @Published var remoteConversationLoading = false
    @Published var remotePermissionMode = "ASK"
    @Published var remotePermissionFailure: String?
    /// False until the desktop has reported its mode for this connection.
    @Published var remotePermissionModeLoaded = false
    @Published var remoteHostCapabilities: [String] = []
    @Published var accountAvatarURL: String?
    @Published var remoteAssistants: [MobileAssistantOption] = []
    @Published var remoteCreateOpen = false
    @Published var remoteCreateSubmitting = false
    @Published var remoteCreateError: String?
    @Published var remoteCreateDeviceError: String?
    @Published var selectedSessionID: String {
        didSet { if selectedSessionID != oldValue { composerDraftRevision &+= 1 } }
    }
    @Published var messages: [ChatMessage]
    @Published private var renderedTimelineRows: [MobileConversationRow] = []
    var timelineRows: [MobileConversationRow] {
        get { renderedTimelineRows }
        set {
            let next = MobileConversationRow.reconcile(newValue, with: renderedTimelineRows)
            if next != renderedTimelineRows { renderedTimelineRows = next }
        }
    }
    @Published var draft = "" {
        didSet { if draft != oldValue { composerDraftRevision &+= 1 } }
    }
    // Includes edits later erased and session round trips, not just current contents.
    var composerDraftRevision: UInt64 = 0
    var lastAppliedRemoteSendID: String?
    var pendingComposerSend: PendingComposerSend?
    @Published var composerSendGeneration: UInt64 = 0
    @Published var drawerOpen = false
    @Published var settingsOpen = false
    @Published var accountSheetOpen = false
    /// Number of visible sign-in steps (account sheet or the step embedded in
    /// settings); the authorization page auto-opens only while one is shown.
    var accountLoginSurfaces = 0
    @Published var languagePickerOpen = false
    @Published var connectionPhase: ConnectionPhase = .connected
    @Published var isSending = false
    @Published var busy = false
    @Published var composerImages: [ComposerAttachment] = [] {
        didSet { if composerImages != oldValue { composerDraftRevision &+= 1 } }
    }
    @Published var modelOptions: [ComposerModelOption] = []
    @Published var toastMessage: String?
    @Published var remoteConnected = false
    @Published var remoteSessionSelected = false
    @Published var remoteOpenedSessionID: String? = nil
    @Published var localSessionSelected = false
    /// Account device picker. Native apps connect only through the signed-in
    /// account's device list; QR and link pairing belong to mobile web.
    @Published var devicePickerOpen = false
    /// Session ids awaiting the authoritative delete result. The directory
    /// sidebar has its own cached projection, so it must be reconciled when a
    /// delete succeeds even if the deleted session was not the open one.
    var pendingRemoteSessionDeletions: Set<String> = []
    @Published var coreErrorMessage: String?
    @Published var launchAccountRestored: Bool? = nil
    @Published var accountUser: String?
    @Published var accountUserID: String?
    @Published var localDeviceID = ""
    @Published var accountBusy = false
    @Published var accountAuthorizationURL: URL?
    @Published var accountFailureStage: String?
    @Published var accountFailureCanRetry = false
    @Published var accountDeviceName: String?
    @Published var accountDeviceCount = 0
    @Published var accountDevices: [MobileAccountDevice] = []
    @Published var accountSelectedDeviceID: String?
    // The selected device the user disconnected from. The selection stays so the
    // settings card can offer it again, but account churn must not bind it back.
    var remoteReleasedDeviceID: String?
    @Published var accountDirectoryError: String?
    @Published var accountRefreshing = false
    @Published var deviceDirectory: [MobileDeviceDirectoryEntry] = []
    @Published var runtimeFiles: RuntimeFilesUiState?
    let runtimeFileDraft = RuntimeFileDraftState()
    @Published var runtimeDirectoryPicker: RuntimeFilesUiState?
    @Published var runtimeDeviceTools: DeviceToolsUiState?
    @Published var runtimeTerminal: RuntimeTerminalUiState?
    @Published var savedRuntimeConnections: [SavedRuntimeConnectionUiState] = []
    @Published var savedRuntimeConnectionsFailed = false
    @Published var remoteWorkspaces: [MobileWorkspaceGroup] = []
    @Published var workspaceLoading = false
    @Published var workspaceLoadFailed = false
    @Published var workspaceSelectionBusy = false
    @Published var remoteCreateWorkspacePhase: RemoteCreateWorkspacePhase = .unavailable
    @Published var filePreview: MobileFilePreview?
    @Published var sessionDetails: ChatSession? = nil
    @Published var filePreviewLoading = false
    @Published var pendingDownload: MobilePendingDownload?
    @Published var downloadExporterOpen = false
    @Published var downloadTargetPath: String?
    @Published var downloadStatusText: String?
    @Published var downloadPhase: MobileDownloadPhase = .idle
    var activeTurnID: String?
    var accountLoginPreview = false
    var localActionPreview = false
    var composerModelPickerPreview = false
    var designGalleryPreview = false
    var remoteCreatePreview = false
    var directoryFixturePreview = false
    var accountGeneration: UInt64 = 0
    var remoteTargetEpoch: UInt64 = 0
    @Published var remoteExpectedDeviceKey: String?
    var remoteBoundTargetKey: String?
    var remoteBoundTargetEpoch: UInt64?
    var accountDirectoryGeneration: UInt64 = 0
    var pendingDirectorySession: (deviceKey: String, sessionID: String, epoch: UInt64)?
    @Published var remoteInitialSessionReady = false
    var remoteInitialWorkspaceReady = false
    var remoteCreateRequestID: String?
    var remoteCreateRequestEpoch: UInt64 = 0
    var remoteCreateRequestDeviceKey: String?
    var committedRemoteCreate: CommittedRemoteCreate?
    var remoteLastAppliedAuthority: RemoteAuthorityScope?
    var remoteSidebarWorkspaceState: RemoteWorkspaceUiStateReady?
    typealias WorkspaceCatalogEntry = (path: String, name: String, selected: Bool, remoteConnectionId: String?, remoteSshHost: String?, workspaceId: String?)
    var workspaceCatalog: [WorkspaceCatalogEntry] = []
    var pendingRemoteWorkspaceCreate: (path: String, agentType: String)?
    var pendingRemoteSessionRefreshWorkspace: MobileWorkspaceScope?
    var pendingDirectoryWorkspace: (deviceKey: String, path: String, epoch: UInt64, remoteConnectionId: String?, remoteSshHost: String?, workspaceId: String?)?
    var pendingDirectoryRemoteDraft: PendingDirectoryRemoteDraft?
    var pendingRemoteAssistantCreate = false
    var selectedRemoteWorkspaceKind = ""
    var remoteConversationLoadTask: Task<Void, Never>?
    var remoteConversationLoadGeneration: UInt64 = 0
    var remoteConversationOpeningSessionID: String?
    var remoteConversationOpenStartedAt: TimeInterval?

    let completionNotifier = TaskCompletionNotifier()
    var coreAdapter: MobileCoreAdapter?

    init(sessions: [ChatSession], selectedSessionID: String, messages: [ChatMessage], connectCore: Bool = true) {
        self.sessions = sessions
        self.selectedSessionID = selectedSessionID
        self.messages = messages
        self.timelineRows = messages.map(Self.simpleTimelineRow)
        self.coreAdapter = nil
        guard connectCore else { return }
        let adapter = MobileCoreAdapter(
            onAccountState: { [weak self] state, generation in
                self?.apply(accountState: state, generation: generation)
            },
            onRemoteTargetBound: { [weak self] targetKey, epoch, generation in
                self?.apply(remoteTargetBound: targetKey, epoch: epoch, accountGeneration: generation)
            },
            onRemoteState: { [weak self] state, targetKey, epoch in
                self?.apply(remoteState: state, targetKey: targetKey, epoch: epoch)
            },
            onRemoteConnectionPhase: { [weak self] phase, targetKey, epoch in
                self?.apply(remoteConnectionPhase: phase, targetKey: targetKey, epoch: epoch)
            },
            onWorkspaceState: { [weak self] state, targetKey, epoch in
                self?.apply(workspaceState: state, targetKey: targetKey, epoch: epoch)
            },
            onDirectoryState: { [weak self] state, generation in
                self?.apply(directoryState: state, generation: generation)
            },
            onCreateOperation: { [weak self] state, targetKey in
                self?.apply(createOperation: state, targetKey: targetKey)
            },
            onCreateUnavailable: { [weak self] requestID, targetKey in
                self?.failRemoteCreate(requestID: requestID, targetKey: targetKey)
            }
        )
        self.coreAdapter = adapter
        self.localDeviceID = adapter.deviceID
    }

    var selectedSession: ChatSession? {
        guard remoteSessionSelected else {
            return nil
        }
        return visibleSessions.first { $0.id == selectedSessionID }
    }

    var visibleSessions: [ChatSession] {
        remoteSessions
    }

    var remoteCreateInteraction: RemoteCreateInteractionState {
        RemoteCreateInteractionPolicy.resolve(
            hasTarget: remoteExpectedDeviceKey != nil,
            remoteConnected: remoteConnected,
            accountSwitching: accountBusy,
            workspacePhase: remoteCreateWorkspacePhase,
            workspaceSelecting: workspaceSelectionBusy,
            createSubmitting: remoteCreateSubmitting,
            activeTurn: activeTurnID != nil || isSending
        )
    }

    func switchSurface(_ next: MobileSurface) {
        surface = next
        drawerOpen = false
    }

    func setLanguage(_ language: MobileLanguage) {
        UserDefaults.standard.set(language.rawValue, forKey: MobileLocalization.preferenceKey)
        guard appLanguage != language else {
            languagePickerOpen = false
            return
        }
        appLanguage = language
        languagePickerOpen = false
    }

    func localized(_ key: String) -> String {
        MobileLocalization.text(key, language: appLanguage)
    }

    func localizedFormat(_ key: String, _ arguments: CVarArg...) -> String {
        String(
            format: localized(key),
            locale: Locale(identifier: appLanguage.rawValue),
            arguments: arguments
        )
    }

    /// Connecting a desktop always goes through the account: signed-out users
    /// sign in first, signed-in users pick from the account device list.
    func connectRemote() {
        guard accountUser != nil else {
            accountSheetOpen = true
            return
        }
        refreshRemoteDevices()
        devicePickerOpen = true
    }

    /// Account entry points (welcome, sidebar, settings rows). Settings embed
    /// the signed-in account, so there is no standalone profile page.
    func openAccount() {
        if accountUser == nil || accountFailureStage == "DEVICE_LIST" {
            accountSheetOpen = true
        } else {
            settingsOpen = true
        }
    }

    func handleScenePhase(_ phase: ScenePhase) {
        if phase != .inactive {
            completionNotifier.setBackground(phase == .background)
            coreAdapter?.setForeground(phase == .active)
        }
        if phase == .active, accountUser != nil { coreAdapter?.resumeSessionStreams(); refreshRemoteDevices() }
    }

    func verifyRemoteConnection() {
        refreshRemoteDevices()
    }

    /// Same rule as Android and HarmonyOS: a released selection is bound again,
    /// a dropped link is retried on the target that is still bound.
    func reconnectRemote() {
        guard let releasedID = remoteReleasedDeviceID else {
            retryRemoteConnection()
            return
        }
        guard let device = accountDevices.first(where: { $0.id == releasedID }) else {
            refreshRemoteDevices()
            return
        }
        selectRemoteDevice(device, preserveDrawer: true)
    }

    func disconnectRemote() {
        remoteReleasedDeviceID = accountSelectedDeviceID
        remoteExpectedDeviceKey = nil
        completionNotifier.reset()
        resetRemoteConversationOpen()
        invalidateTargetScopedFileTransfers()
        committedRemoteCreate = nil
        remoteLastAppliedAuthority = nil
        coreAdapter?.disconnect()
        remoteConnected = false
        remoteSessionSelected = false
        remoteSessions = []
        remoteWorkspaces = []
        workspaceCatalog = []
        remoteSidebarWorkspaceState = nil
        remoteInitialSessionReady = false
        remoteInitialWorkspaceReady = false
        workspaceLoading = false
        workspaceLoadFailed = false
        workspaceSelectionBusy = false
        remoteCreateWorkspacePhase = .unavailable
        pendingRemoteWorkspaceCreate = nil
        pendingRemoteSessionRefreshWorkspace = nil
        pendingDirectoryRemoteDraft = nil
        pendingRemoteAssistantCreate = false
        selectedRemoteWorkspaceKind = ""
        selectedSessionID = ""
        timelineRows = []
        messages = []
        surface = .remote
        connectionPhase = .disconnected
    }

    func openRemoteSurface() {
        surface = .remote
        drawerOpen = false
    }

    func showSessionDetails(_ session: ChatSession) {
        sessionDetails = session
    }

    func dismissSessionDetails() {
        sessionDetails = nil
    }

    func stopSending() {
        guard remoteSessionSelected, remoteConnected, connectionPhase == .connected else { return }
        coreAdapter?.cancelRemoteTurn(sessionID: selectedSessionID, turnID: activeTurnID)
    }

    func retryMessage(_ text: String, images: [MobileTimelineImage] = []) {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty || !images.isEmpty, !busy, !isSending else { return }
        let attachments = images.compactMap { image -> ComposerAttachment? in
            if let retained = composerImages.first(where: { $0.dataURL == image.dataURL }) { return retained }
            guard let comma = image.dataURL.firstIndex(of: ","),
                  let data = Data(base64Encoded: String(image.dataURL[image.dataURL.index(after: comma)...])) else { return nil }
            let mime = image.dataURL.prefix(upTo: comma).dropFirst(5).split(separator: ";").first.map(String.init) ?? "image/jpeg"
            return ComposerAttachment(id: UUID().uuidString, data: data, mimeType: mime)
        }
        guard attachments.count == images.count else {
            showToast(localized("无法读取所选图片"))
            return
        }
        guard let sessionID = remoteSendSessionID, let coreAdapter else { return }
        composerSendGeneration &+= 1
        isSending = true
        busy = true
        coreAdapter.sendRemote(sessionID: sessionID, content: normalized, images: attachments)
    }

    func renameSelectedSession(_ title: String) {
        let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, selectedSession != nil else { return }
        if surface == .remote {
            coreAdapter?.renameRemoteSession(sessionID: selectedSessionID, title: normalized)
        }
    }

    func showUploadedFiles() {
        let count = composerImages.count
        showToast(
            count == 0
                ? localized("当前会话暂无已上传文件")
                : localizedFormat("当前会话已上传 %lld 个文件", Int64(count))
        )
    }

    func showToast(_ message: String) {
        toastMessage = message
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard self?.toastMessage == message else { return }
            self?.toastMessage = nil
        }
    }

}

/// Presentation draft outlives temporary sheet reconstruction and scene transitions.
@MainActor
final class RuntimeFileDraftState: ObservableObject {
    @Published var content = ""
    private var identity: [String]?
    private var savedContent: String?

    func synchronize(identity: [String], savedContent: String) {
        guard self.identity != identity || self.savedContent != savedContent else { return }
        self.identity = identity
        self.savedContent = savedContent
        content = savedContent
    }

    func reset() {
        identity = nil
        savedContent = nil
        content = ""
    }
}
