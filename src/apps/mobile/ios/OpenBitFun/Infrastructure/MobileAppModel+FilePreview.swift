import Foundation
import OpenBitFunMobileCore

private struct MobilePreviewRequestExpectation {
    let requestID: String
    let deviceKey: String?
    let previewDeviceKey: String?
    let adapterEpoch: UInt64
    let sessionID: String
    let path: String
    var controlTargetEpoch: Int32?
}

private var filePreviewRequestByModel: [ObjectIdentifier: MobilePreviewRequestExpectation] = [:]
private var downloadRetryableByModel: [ObjectIdentifier: Bool] = [:]
private var downloadRetryDeviceByModel: [ObjectIdentifier: String] = [:]
private var downloadRetryCallbackEpochByModel: [ObjectIdentifier: UInt64] = [:]
private var downloadRetryPathByModel: [ObjectIdentifier: String] = [:]

private extension MobileFilePreviewFailureKind {
    init(kind: FilePreviewFailureKind) {
        switch kind.name {
        case "NOT_FOUND": self = .notFound
        case "UNAVAILABLE": self = .unavailable
        case "ACCESS_DENIED": self = .accessDenied
        case "TOO_LARGE": self = .tooLarge
        case "CONNECTION": self = .connection
        default: self = .loadFailed
        }
    }
}

private func localizedFailureReason(_ localized: (String) -> String, kindName: String, operation: String) -> String {
    switch kindName {
    case "ACCESS_DENIED": return localized("没有权限访问此文件")
    case "NOT_FOUND": return localized("找不到此文件")
    case "TOO_LARGE": return localized(operation == "download" ? "文件过大，无法下载" : "文件过大，无法预览")
    case "CONNECTION", "UNAVAILABLE", "OFFLINE": return localized("远程设备当前离线")
    case "UNSUPPORTED": return localized("此文件类型暂不支持")
    default: return localized(operation == "download" ? "下载失败" : "无法预览")
    }
}

extension MobileAppModel {
    func invalidateTargetScopedFileTransfers() {
        runtimeDeviceTools = nil
        let modelID = ObjectIdentifier(self)
        filePreviewRequestByModel[modelID] = nil
        filePreview = nil
        filePreviewLoading = false

        pendingDownload = nil
        downloadExporterOpen = false
        downloadTargetPath = nil
        downloadStatusText = nil
        downloadPhase = .idle
        downloadRetryableByModel[modelID] = nil
        downloadRetryDeviceByModel[modelID] = nil
        downloadRetryCallbackEpochByModel[modelID] = nil
        downloadRetryPathByModel[modelID] = nil
    }

    func openRemoteFile(reference: String, label: String) {
        guard surface == .remote, remoteSessionSelected else {
            showToast(localized("仅远程工作区文件支持预览"))
            return
        }
        guard let adapter = coreAdapter, adapter.canOpenRemoteFile else {
            showToast(localized("连接不可用，请先重新连接"))
            return
        }
        filePreviewLoading = true
        let key = ObjectIdentifier(self)
        let requestID = UUID().uuidString
        // Register before dispatch: a store may publish Loading immediately.
        filePreviewRequestByModel[key] = MobilePreviewRequestExpectation(
            requestID: requestID,
            deviceKey: adapter.currentRemoteTargetKey,
            previewDeviceKey: adapter.currentFilePreviewDeviceKey,
            adapterEpoch: adapter.currentRemoteTargetEpoch,
            sessionID: selectedSessionID,
            path: normalizedRemotePath(reference),
            controlTargetEpoch: nil
        )
        adapter.openRemoteFile(
            reference: reference,
            label: label,
            sessionID: selectedSessionID,
            requestID: requestID
        )
    }

    func downloadWorkspaceFile(path: String, label: String) {
        beginRemoteDownload(reference: path, label: label, sessionID: "")
    }

    func downloadRemoteFile(reference: String, label: String) {
        guard remoteSessionSelected else { return }
        beginRemoteDownload(reference: reference, label: label, sessionID: selectedSessionID)
    }

    private func beginRemoteDownload(reference: String, label: String, sessionID: String) {
        guard surface == .remote, remoteConnected else { return }
        downloadExporterOpen = false
        pendingDownload = nil
        let modelID = ObjectIdentifier(self)
        downloadRetryableByModel[modelID] = false
        downloadRetryDeviceByModel[modelID] = coreAdapter?.currentRemoteTargetKey
        downloadRetryCallbackEpochByModel[modelID] = coreAdapter?.currentRemoteTargetEpoch ?? 0
        let path = normalizedRemotePath(reference)
        downloadRetryPathByModel[modelID] = path
        downloadTargetPath = path
        downloadPhase = .preparing
        downloadStatusText = localized("正在准备下载")
        coreAdapter?.downloadRemoteFile(
            reference: reference,
            label: label,
            sessionID: sessionID
        )
    }

    func finishDownloadExport(success: Bool) {
        guard let download = pendingDownload else { return }
        if success {
            coreAdapter?.remoteDownloadSaved(reference: download.reference)
            downloadPhase = .saved
            downloadStatusText = localized("已下载")
            showToast(localizedFormat("已保存 %@", download.name))
        } else {
            coreAdapter?.remoteDownloadSaveFailed(reference: download.reference)
            downloadPhase = .failed
            downloadStatusText = localized("保存失败")
            showToast(localized("文件保存失败"))
        }
        pendingDownload = nil
        downloadExporterOpen = false
    }

    func downloadStatus(for remotePath: String) -> String? {
        guard downloadTargetPath == remotePath else { return nil }
        return downloadStatusText
    }

    func dismissFilePreview() {
        let key = ObjectIdentifier(self)
        filePreviewRequestByModel[key] = nil
        filePreview = nil
        filePreviewLoading = false
        coreAdapter?.dismissRemoteFilePreview()
    }

    func apply(downloadState state: RemoteFileDownloadUiState) {
        if state is RemoteFileDownloadUiStateNone { return }
        let modelID = ObjectIdentifier(self)
        guard RemoteAuthorityGate.fileTransferCallbackMatchesAuthority(
            requestTargetKey: downloadRetryDeviceByModel[modelID],
            requestEpoch: downloadRetryCallbackEpochByModel[modelID],
            adapterTargetKey: coreAdapter?.currentRemoteTargetKey,
            adapterEpoch: coreAdapter?.currentRemoteTargetEpoch ?? 0
        ) else { return }
        if let loading = state as? RemoteFileDownloadUiStateLoading {
            downloadTargetPath = loading.target.remotePath
            downloadPhase = .downloading
            if loading.totalBytes > 0 {
                downloadStatusText = localizedFormat(
                    "正在下载 %@ / %@",
                    FilePreviewFormat.shared.bytes(value: loading.downloadedBytes),
                    FilePreviewFormat.shared.bytes(value: loading.totalBytes)
                )
            } else {
                downloadStatusText = localized("正在下载")
            }
        } else if let awaiting = state as? RemoteFileDownloadUiStateAwaitingSave {
            let reference = awaiting.target.path
            downloadTargetPath = awaiting.target.remotePath
            downloadPhase = .saving
            downloadStatusText = localized("正在保存")
            if pendingDownload?.reference != reference {
                pendingDownload = MobilePendingDownload(
                    reference: reference,
                    remotePath: awaiting.target.remotePath,
                    name: awaiting.name,
                    mimeType: awaiting.mimeType,
                    localURL: URL(fileURLWithPath: awaiting.localReference),
                    sessionID: awaiting.target.sessionId,
                    controlTargetEpoch: awaiting.target.controlTargetEpoch
                )
                downloadExporterOpen = true
            }
        } else if let saved = state as? RemoteFileDownloadUiStateSaved {
            downloadTargetPath = saved.target.remotePath
            downloadPhase = .saved
            downloadStatusText = localized("已下载")
        } else if let failed = state as? RemoteFileDownloadUiStateFailed {
            downloadTargetPath = failed.target.remotePath
            downloadPhase = .failed
            let modelID = ObjectIdentifier(self)
            downloadRetryableByModel[modelID] = failed.retryable
            downloadRetryDeviceByModel[modelID] = coreAdapter?.currentRemoteTargetKey
            downloadRetryCallbackEpochByModel[modelID] = coreAdapter?.currentRemoteTargetEpoch ?? 0
            downloadRetryPathByModel[modelID] = failed.target.remotePath
            downloadStatusText = localizedFailureReason(localized, kindName: failed.kind.name, operation: "download")
            pendingDownload = nil
            downloadExporterOpen = false
        }
    }

    var canRetryRemoteDownload: Bool {
        downloadRetryableByModel[ObjectIdentifier(self)] == true
    }

    func retryRemoteDownload() {
        let modelID = ObjectIdentifier(self)
        guard downloadRetryableByModel[modelID] == true,
              let path = downloadRetryPathByModel[modelID],
              downloadTargetPath == path,
              downloadRetryDeviceByModel[modelID] == coreAdapter?.currentRemoteTargetKey,
              downloadRetryCallbackEpochByModel[modelID] == coreAdapter?.currentRemoteTargetEpoch else {
            downloadPhase = .failed
            downloadStatusText = localized("下载目标已变化，请重新打开文件")
            return
        }
        coreAdapter?.retryRemoteDownload()
    }

    func apply(filePreviewState state: RemoteFilePreviewUiState) {
        let key = ObjectIdentifier(self)
        if !(state is RemoteFilePreviewUiStateNone) {
            guard var expected = filePreviewRequestByModel[key],
                  let identity = stateRequestIdentity(state),
                  RemoteAuthorityGate.filePreviewCallbackMatchesAuthority(
                      requestTargetKey: expected.deviceKey,
                      requestEpoch: expected.adapterEpoch,
                      adapterTargetKey: coreAdapter?.currentRemoteTargetKey,
                      adapterEpoch: coreAdapter?.currentRemoteTargetEpoch ?? 0,
                      expectedStoreDeviceKey: expected.previewDeviceKey,
                      callbackDeviceKey: identity.deviceKey
                  ),
                  let target = stateTarget(state),
                  identity.requestId == expected.requestID,
                  identity.sessionId == expected.sessionID,
                  normalizedRemotePath(identity.path) == expected.path,
                  target.sessionId == expected.sessionID,
                  normalizedRemotePath(target.remotePath) == expected.path else { return }
            if let epoch = expected.controlTargetEpoch {
                guard target.controlTargetEpoch == epoch else { return }
            } else {
                expected.controlTargetEpoch = target.controlTargetEpoch
                filePreviewRequestByModel[key] = expected
            }
        }
        if let loading = state as? RemoteFilePreviewUiStateLoading {
            filePreviewLoading = true
            filePreview = MobileFilePreview(id: loading.target.remotePath, sessionID: loading.target.sessionId,
                controlTargetEpoch: loading.target.controlTargetEpoch, name: loading.target.displayName,
                content: "", mimeType: "", imageData: nil, truncated: false, loadedBytes: 0,
                sizeBytes: 0, markdown: false, lineStart: loading.target.lineStart, failure: nil,
                failureKind: nil, retryable: false, unsupported: false)
            return
        }
        filePreviewLoading = false
        if state is RemoteFilePreviewUiStateNone {
            filePreview = nil
        } else if let text = state as? RemoteFilePreviewUiStateText {
            filePreview = MobileFilePreview(id: text.target.remotePath, sessionID: text.target.sessionId,
                controlTargetEpoch: text.target.controlTargetEpoch, name: text.name,
                content: text.content, mimeType: text.mimeType, imageData: nil, truncated: text.truncated,
                loadedBytes: text.loadedBytes, sizeBytes: text.sizeBytes, markdown: text.markdown,
                lineStart: text.target.lineStart, lineEnd: text.target.lineEnd, failure: nil, failureKind: nil, retryable: false, unsupported: false)
        } else if let image = state as? RemoteFilePreviewUiStateImage {
            filePreview = MobileFilePreview(id: image.target.remotePath, sessionID: image.target.sessionId,
                controlTargetEpoch: image.target.controlTargetEpoch, name: image.name,
                content: "", mimeType: image.mimeType, imageData: Self.data(from: image.bytes), truncated: false,
                loadedBytes: image.sizeBytes, sizeBytes: image.sizeBytes, markdown: false,
                lineStart: image.target.lineStart, failure: nil, failureKind: nil, retryable: false, unsupported: false)
        } else if let unsupported = state as? RemoteFilePreviewUiStateUnsupported {
            filePreview = MobileFilePreview(id: unsupported.target.remotePath, sessionID: unsupported.target.sessionId,
                controlTargetEpoch: unsupported.target.controlTargetEpoch, name: unsupported.target.displayName,
                content: "", mimeType: unsupported.mimeType, imageData: nil, truncated: false,
                loadedBytes: 0, sizeBytes: unsupported.sizeBytes, markdown: false,
                lineStart: unsupported.target.lineStart, failure: localized("此文件类型暂不支持预览"),
                failureKind: nil, retryable: false, unsupported: true)
        } else if let failed = state as? RemoteFilePreviewUiStateFailed {
            let kind = MobileFilePreviewFailureKind(kind: failed.kind)
            filePreview = MobileFilePreview(id: failed.target.remotePath, sessionID: failed.target.sessionId,
                controlTargetEpoch: failed.target.controlTargetEpoch, name: failed.target.displayName,
                content: "", mimeType: failed.mimeType, imageData: nil, truncated: false,
                loadedBytes: 0, sizeBytes: failed.sizeBytes, markdown: false, lineStart: failed.target.lineStart,
                failure: localizedFailureReason(localized, kindName: failed.kind.name, operation: "preview"), failureKind: kind,
                retryable: failed.retryable, unsupported: false)
        }
    }

    /// Mirrors FileTargetResolver: remove the optional source range before the URI scheme.
    /// This is intentionally POSIX-only; the result is never joined with local paths.
    private func normalizedRemotePath(_ reference: String) -> String {
        var raw = reference.trimmingCharacters(in: .whitespacesAndNewlines)
        while let last = raw.last, ".,;:)".contains(last) { raw.removeLast() }
        if let hash = raw.lastIndex(of: "#"), hash > raw.startIndex {
            let marker = String(raw[raw.index(after: hash)...])
            if isLineMarker(marker) { raw = String(raw[..<hash]) }
        } else if let colon = raw.lastIndex(of: ":"), colon > raw.startIndex {
            let marker = String(raw[raw.index(after: colon)...])
            if isLineRange(marker) { raw = String(raw[..<colon]) }
        }
        if raw.lowercased().hasPrefix("computer://") { raw.removeFirst("computer://".count) }
        if raw.lowercased().hasPrefix("file://") { raw.removeFirst("file://".count) }
        return raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func isLineMarker(_ marker: String) -> Bool {
        guard marker.hasPrefix("L") else { return false }
        let parts = marker.dropFirst().split(separator: "-", omittingEmptySubsequences: false)
        return (parts.count == 1 || parts.count == 2)
            && parts.allSatisfy { $0.hasPrefix("L") ? $0.dropFirst().allSatisfy(\.isNumber) : $0.allSatisfy(\.isNumber) }
            && parts.allSatisfy { !$0.isEmpty && ($0 == "L" ? false : true) }
    }

    private func isLineRange(_ marker: String) -> Bool {
        let parts = marker.split(separator: "-", omittingEmptySubsequences: false)
        return (parts.count == 1 || parts.count == 2) && parts.allSatisfy { $0.allSatisfy(\.isNumber) && !$0.isEmpty }
    }

    private func stateTarget(_ state: RemoteFilePreviewUiState) -> FilePreviewTarget? {
        if let value = state as? RemoteFilePreviewUiStateLoading { return value.target }
        if let value = state as? RemoteFilePreviewUiStateText { return value.target }
        if let value = state as? RemoteFilePreviewUiStateImage { return value.target }
        if let value = state as? RemoteFilePreviewUiStateUnsupported { return value.target }
        if let value = state as? RemoteFilePreviewUiStateFailed { return value.target }
        return nil
    }

    private func stateRequestIdentity(_ state: RemoteFilePreviewUiState) -> PreviewRequestIdentity? {
        if let value = state as? RemoteFilePreviewUiStateLoading { return value.identity }
        if let value = state as? RemoteFilePreviewUiStateText { return value.identity }
        if let value = state as? RemoteFilePreviewUiStateImage { return value.identity }
        if let value = state as? RemoteFilePreviewUiStateUnsupported { return value.identity }
        if let value = state as? RemoteFilePreviewUiStateFailed { return value.identity }
        return nil
    }

    static func data(from bytes: KotlinByteArray) -> Data {
        Data((0..<Int(bytes.size)).map { index in
            UInt8(bitPattern: bytes.get(index: Int32(index)))
        })
    }
}
