import Foundation
import UIKit
import OpenBitFunMobileCore

extension MobileAppModel {
    private func invalidateTerminalAccountAuthority() {
        invalidateTargetScopedFileTransfers()
        if let targetKey = coreAdapter?.currentRemoteTargetKey,
           targetKey.hasPrefix("account:") {
            let epoch = coreAdapter?.currentRemoteTargetEpoch ?? remoteTargetEpoch
            _ = coreAdapter?.invalidateRemoteAuthority(ifTargetKey: targetKey, epoch: epoch)
        }
        clearInvalidatedRemoteAuthorityProjection(
            adapterEpoch: coreAdapter?.currentRemoteTargetEpoch ?? remoteTargetEpoch
        )
        remoteConnected = false
        connectionPhase = .disconnected
    }

    private func invalidateRemoteTarget(for operation: (accountGeneration: UInt64, remoteTargetEpoch: UInt64)) {
        committedRemoteCreate = nil
        remoteLastAppliedAuthority = nil
        accountGeneration = operation.accountGeneration
        remoteTargetEpoch = operation.remoteTargetEpoch
        remoteExpectedDeviceKey = nil
        remoteConnected = false
        pendingDirectorySession = nil
        pendingDirectoryWorkspace = nil
        pendingDirectoryRemoteDraft = nil
        remoteCreateSubmitting = false
        remoteCreateRequestID = nil
        remoteCreateRequestEpoch = remoteTargetEpoch
        remoteCreateRequestDeviceKey = nil
        pendingRemoteWorkspaceCreate = nil
        pendingRemoteSessionRefreshWorkspace = nil
        pendingRemoteAssistantCreate = false
        remoteSessionSelected = false
    }

    func selectRemoteDevice(_ device: MobileAccountDevice, preserveDrawer: Bool = false) {
        guard device.online else {
            showToast(localized("这台桌面设备当前离线"))
            return
        }
        surface = .remote
        if !preserveDrawer { drawerOpen = false }
        let targetKey = "account:\(device.id)"
        guard remoteExpectedDeviceKey != targetKey else { return }
        invalidateTargetScopedFileTransfers()
        remoteTargetEpoch &+= 1
        remoteExpectedDeviceKey = "account:\(device.id)"
        remoteInitialSessionReady = false
        remoteInitialWorkspaceReady = false
        remoteCreateWorkspacePhase = .loading
        workspaceLoading = true
        workspaceLoadFailed = false
        workspaceSelectionBusy = false
        pendingDirectorySession = pendingDirectorySession.map { ($0.deviceKey, $0.sessionID, remoteTargetEpoch) }
        remoteCreateSubmitting = false
        remoteCreateRequestID = nil
        remoteCreateError = nil
        committedRemoteCreate = nil
        remoteLastAppliedAuthority = nil
        accountBusy = true
        remoteSessionSelected = false
        remoteConnected = false
        remoteSessions = []
        remoteWorkspaces = []
        workspaceCatalog = []
        remoteSidebarWorkspaceState = nil
        pendingRemoteWorkspaceCreate = nil
        pendingRemoteSessionRefreshWorkspace = nil
        pendingRemoteAssistantCreate = false
        selectedRemoteWorkspaceKind = ""
        messages = []
        timelineRows = []
        coreAdapter?.selectAccountDevice(id: device.id)
    }

    func refreshRemoteDevices() {
        guard accountUser != nil else { return }
        coreAdapter?.refreshAccountDevices()
    }

    func logoutAccount() {
        completionNotifier.reset()

            invalidateTargetScopedFileTransfers()

        if let operation = coreAdapter?.beginAccountOperation() {
            invalidateRemoteTarget(for: operation)
        } else {
            accountGeneration &+= 1
            remoteTargetEpoch &+= 1
            committedRemoteCreate = nil
        remoteLastAppliedAuthority = nil
            remoteExpectedDeviceKey = nil
            remoteConnected = false
            pendingDirectorySession = nil
            pendingDirectoryWorkspace = nil
            pendingDirectoryRemoteDraft = nil
            remoteCreateSubmitting = false
            remoteCreateRequestID = nil
            remoteCreateRequestEpoch = remoteTargetEpoch
            remoteCreateRequestDeviceKey = nil
            pendingRemoteWorkspaceCreate = nil
            pendingRemoteAssistantCreate = false
            remoteSessionSelected = false
        }
        do {
            remoteExpectedDeviceKey = nil
            remoteConnected = false
            pendingDirectorySession = nil
            pendingDirectoryWorkspace = nil
            pendingDirectoryRemoteDraft = nil
        }
        accountDirectoryGeneration &+= 1
        coreAdapter?.logoutAccount()
        accountUser = nil
        accountUserID = nil
        accountDeviceName = nil
        accountDeviceCount = 0
        accountDevices = []
        accountSelectedDeviceID = nil
        coreAdapter?.syncDeviceDirectory([])
        do {
            remoteConnected = false
        }

            remoteSessionSelected = false
            remoteSessions = []
            remoteWorkspaces = []
            workspaceCatalog = []
            remoteSidebarWorkspaceState = nil
            workspaceSelectionBusy = false
            remoteCreateWorkspacePhase = .unavailable
            pendingRemoteWorkspaceCreate = nil
            pendingRemoteAssistantCreate = false
            selectedRemoteWorkspaceKind = ""
            surface = .local

    }

    func loginAccount() {
        if accountAuthorizationURL != nil {
            openAccountAuthorization()
            return
        }
        guard !accountBusy else { return }

            invalidateTargetScopedFileTransfers()

        if let operation = coreAdapter?.beginAccountOperation() {
            invalidateRemoteTarget(for: operation)
        } else {
            accountGeneration &+= 1
            remoteTargetEpoch &+= 1
            committedRemoteCreate = nil
        remoteLastAppliedAuthority = nil
            remoteExpectedDeviceKey = nil
            remoteConnected = false
            pendingDirectorySession = nil
            pendingDirectoryWorkspace = nil
            pendingDirectoryRemoteDraft = nil
            remoteCreateSubmitting = false
            remoteCreateRequestID = nil
            remoteCreateRequestEpoch = remoteTargetEpoch
            remoteCreateRequestDeviceKey = nil
            pendingRemoteWorkspaceCreate = nil
            pendingRemoteAssistantCreate = false
            remoteSessionSelected = false
        }
        accountBusy = true
        accountFailureStage = nil
        accountFailureCanRetry = false
        coreErrorMessage = nil
        coreAdapter?.loginAccount()
    }

    func openAccountAuthorization() {
        guard let url = accountAuthorizationURL else { return }
        UIApplication.shared.open(url) { [weak self] opened in
            guard !opened else { return }
            Task { @MainActor [weak self] in
                guard let self, self.accountAuthorizationURL == url else { return }
                self.coreErrorMessage = self.localized("无法打开授权页面，请重试。")
            }
        }
    }

    func retryAccountFailure() {
        guard accountFailureStage == "DEVICE_LIST", accountFailureCanRetry, !accountBusy else { return }
        accountBusy = true
        coreAdapter?.retryAccountFailure()
    }

    func apply(accountState state: AccountUiState, generation: UInt64) {
        guard !accountLoginPreview, !localActionPreview, !remoteCreatePreview,
              generation == accountGeneration else { return }
        accountGeneration = generation
        if let ready = state as? AccountUiStateReady, let failure = ready.refreshFailure {
            accountDirectoryError = accountErrorMessage(failure.name, stage: "DEVICE_LIST")
        } else {
            accountDirectoryError = nil
        }
        accountBusy = state is AccountUiStateSigningIn || state is AccountUiStateAuthorizing
        let previousAuthorizationURL = accountAuthorizationURL
        accountAuthorizationURL = (state as? AccountUiStateAuthorizing).flatMap { authorization in
            guard var components = URLComponents(string: authorization.authorizationUrl) else { return nil }
            if components.scheme == "https", components.host == "auth.openbitfun.com" {
                var items = (components.queryItems ?? []).filter { $0.name != "locale" }
                items.append(URLQueryItem(name: "locale", value: appLanguage.rawValue))
                components.queryItems = items
            }
            return components.url
        }
        if accountSheetOpen, let url = accountAuthorizationURL, url != previousAuthorizationURL {
            openAccountAuthorization()
        }
        if let ready = state as? AccountUiStateReady {
            let readyTargetKey = ready.selectedDeviceId.map { "account:\($0)" }
            if let adapterTargetKey = coreAdapter?.currentRemoteTargetKey,
               adapterTargetKey.hasPrefix("account:"),
               adapterTargetKey != readyTargetKey {
                invalidateTargetScopedFileTransfers()
            }
            accountBusy = false
            accountFailureStage = nil
            accountFailureCanRetry = false
            coreErrorMessage = nil
            accountUser = ready.username
            accountAvatarURL = ready.avatarUrl
            accountUserID = ready.userId
            accountDeviceName = ready.selectedDeviceName
            accountDeviceCount = ready.devices.count
            accountSelectedDeviceID = ready.selectedDeviceId
            accountRefreshing = ready.refreshing
            remoteCreateDeviceError = ready.refreshFailure != nil
                ? localized("设备列表加载失败，请稍后重试。") : nil
            accountDevices = ready.devices.map { device in
                let targetKey = "account:\(device.id)"
                return MobileAccountDevice(
                    id: device.id,
                    name: device.name,
                    online: device.online ||
                        (targetKey == remoteExpectedDeviceKey && remoteConnected && remoteInitialSessionReady),
                    selected: device.id == ready.selectedDeviceId
                )
            }
            accountDirectoryGeneration = coreAdapter?.syncDeviceDirectory(accountDevices) ?? (accountDirectoryGeneration &+ 1)
            if let link = pendingDeviceLink {
                pendingDeviceLink = nil
                submitPairing(url: link)
                if pairingError != nil { pairingSheetOpen = true }
                return
            }
            if ready.selectedDeviceId == nil,
               let target = ready.devices.first(where: { $0.online }) {
                accountBusy = true
                coreAdapter?.selectAccountDevice(id: target.id)
                return
            }
            let selectedTargetKey = ready.selectedDeviceId.map { "account:\($0)" }
            let retainsReachableAccountTarget = selectedTargetKey == remoteExpectedDeviceKey && remoteConnected
            if !retainsReachableAccountTarget {
                remoteConnected = false
                connectionPhase = ready.selectedDeviceId == nil ? .disconnected : .reconnecting
            }
            surface = .remote
        } else if let failed = state as? AccountUiStateFailed {
            accountBusy = false
            accountFailureStage = failed.stage.name
            accountFailureCanRetry = failed.canRetry
            coreErrorMessage = accountErrorMessage(failed.reason.name, stage: failed.stage.name)
            if pendingDirectoryRemoteDraft != nil {
                pendingDirectoryRemoteDraft = nil
                showToast(localized("远程会话连接已失效，请重新选择设备后重试"))
            }
            if remoteCreateOpen {
                remoteCreateDeviceError = coreErrorMessage
            }
            connectionPhase = .disconnected
            if failed.reason.name == "AUTHENTICATION" {
                accountUser = nil
                accountUserID = nil
                accountDevices = []
                accountSelectedDeviceID = nil
                accountDeviceName = nil
                accountDeviceCount = 0
                accountRefreshing = false
                pendingDirectorySession = nil
                pendingDirectoryWorkspace = nil

                    pendingDirectoryRemoteDraft = nil

                accountDirectoryGeneration = coreAdapter?.syncDeviceDirectory([]) ?? (accountDirectoryGeneration &+ 1)

                    invalidateTerminalAccountAuthority()

            }
        } else if state is AccountUiStateSignedOut {
            accountBusy = false
            accountFailureStage = nil
            accountFailureCanRetry = false
            coreErrorMessage = nil
            accountUser = nil
            accountUserID = nil
            accountDevices = []
            accountSelectedDeviceID = nil
            accountDeviceName = nil
            accountDeviceCount = 0
            accountRefreshing = false
            pendingDirectorySession = nil
            pendingDirectoryWorkspace = nil

                pendingDirectoryRemoteDraft = nil

            accountDirectoryGeneration = coreAdapter?.syncDeviceDirectory([]) ?? (accountDirectoryGeneration &+ 1)

                invalidateTerminalAccountAuthority()

        }
    }

    func promoteLiveAccountTargetPresence(targetKey: String) {
        let prefix = "account:"
        guard targetKey.hasPrefix(prefix), remoteConnected else { return }
        let deviceID = String(targetKey.dropFirst(prefix.count))
        guard let index = accountDevices.firstIndex(where: { $0.id == deviceID }),
              !accountDevices[index].online else { return }
        let device = accountDevices[index]
        accountDevices[index] = MobileAccountDevice(
            id: device.id,
            name: device.name,
            online: true,
            selected: device.selected
        )
        accountDirectoryGeneration = coreAdapter?.syncDeviceDirectory(accountDevices) ??
            (accountDirectoryGeneration &+ 1)
    }

    func accountErrorMessage(_ reason: String, stage: String? = nil) -> String {
        localized(AccountFailureCopy.localizationKey(reason: reason, stage: stage))
    }
}
