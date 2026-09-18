import OpenBitFunMobileCore
import SwiftUI
import WebKit
import UniformTypeIdentifiers
import OSLog

struct RemoteCreateSessionView: View {
    @ObservedObject var model: MobileAppModel
    let onBack: () -> Void
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @StateObject private var speech = SpeechInputController()
    @State private var instruction = ""
    @State private var harnessProfile = HarnessProfile.standard
    @Environment(\.scenePhase) private var scenePhase
    /// The workspace the draft targets, ID-first; nil is the plain chat (assistant) draft.
    @State private var selectedWorkspace: MobileWorkspaceScope?
    @State private var newWorkspacePath = ""
    @State private var directoryVisible = false
    @State private var directoryConnectionId: String?
    @State private var savedConnectionId = ""
    @State private var selectedModelID: String?
    @State private var pickerKind: RemoteCreateSelectionKind? = ProcessInfo.processInfo.arguments.contains(
        "--remote-create-workspace-picker"
    ) ? .workspace : nil
    private let log = Logger(subsystem: "com.openbitfun.mobile.ios", category: "remote-create-ui")

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 0) {
                    HStack {
                        Button(action: onBack) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 19, weight: .medium))
                                .foregroundStyle(OpenBitFunTheme.ink)
                                .frame(width: 44, height: 44)
                                .background(OpenBitFunTheme.card)
                                .clipShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(model.localized("返回"))
                        Spacer()
                    }
                    .frame(height: 78, alignment: .top)
                    .padding(.leading, 18)
                    .padding(.top, 14)

                    Spacer(minLength: 12)

                    if !model.remoteConnected {
                        createStatus(message: model.localized("连接不可用，请重新连接"), retryTitle: model.localized("重试"), action: model.verifyRemoteConnection)
                    } else if let error = model.remoteCreateError ?? model.remoteCreateDeviceError ??
                                (model.workspaceLoadFailed ? (model.coreErrorMessage ?? model.localized("工作区加载失败，请重试")) : nil) {
                        createStatus(message: error, retryTitle: model.localized("重试"), action: retryCreate)
                    }

                    contextButton(
                        kind: .device,
                        icon: "desktopcomputer",
                        label: deviceLabel,
                        automationIdentifier: selectedDeviceAutomationIdentifier
                    )
                    contextButton(
                        kind: .workspace,
                        icon: selectedWorkspacePath.isEmpty ? "message" : "folder",
                        label: model.remoteCreateWorkspacePhase == .loading
                            ? model.localized("正在加载工作区") : selectedWorkspaceName,
                        automationIdentifier: selectedWorkspaceAutomationIdentifier
                    )
                    createComposer
                }
                .frame(minHeight: geometry.size.height)
            }
        }
        .background(OpenBitFunTheme.page)
        .overlayPreferenceValue(RemoteCreateSelectionAnchorKey.self) { anchors in
            GeometryReader { proxy in
                if horizontalSizeClass == .regular,
                   let kind = pickerKind,
                   let anchor = anchors[kind] {
                    let frame = proxy[anchor]
                    ZStack(alignment: .topLeading) {
                        OpenBitFunTheme.transparent
                            .contentShape(Rectangle())
                            .onTapGesture { pickerKind = nil }
                        selectionContent(kind: kind, includeHeader: false)
                            .openBitFunPopoverSurface()
                            .fixedSize(horizontal: false, vertical: true)
                            .position(
                                x: min(
                                    max(MobileDesignGeometry.popoverWidth / 2 + 8, frame.midX),
                                    proxy.size.width - MobileDesignGeometry.popoverWidth / 2 - 8
                                ),
                                y: max(120, frame.minY - selectionHeight(kind) / 2 - 8)
                            )
                    }
                }
            }
        }
        .sheet(item: compactPicker) { kind in
            selectionContent(kind: kind, includeHeader: true)
                .presentationDetents([.height(selectionHeight(kind))])
                .presentationDragIndicator(.visible)
        }
        .onAppear {
            reconcileSelectedWorkspace()
            selectedModelID = model.modelOptions.first(where: \.selected)?.id ?? model.modelOptions.first?.id
        }
        .onDisappear { speech.stop() }
        .onChange(of: scenePhase) { if $0 != .active { speech.stop() } }
        .onChange(of: model.remoteTargetEpoch) { _ in
            speech.stop()
            selectedWorkspace = nil
        }
        .onChange(of: model.remoteWorkspaces) { _ in
            reconcileSelectedWorkspace()
        }
    }

    private var compactPicker: Binding<RemoteCreateSelectionKind?> {
        Binding(
            get: { horizontalSizeClass == .regular ? nil : pickerKind },
            set: { pickerKind = $0 }
        )
    }

    private var deviceLabel: String {
        if model.accountRefreshing || model.accountBusy { return model.localized("正在加载") }
        return model.accountDeviceName ?? model.localized("选择桌面设备")
    }

    private var selectedWorkspacePath: String { selectedWorkspace?.path ?? "" }

    private var selectedWorkspaceName: String {
        guard let selectedWorkspace else { return model.localized("对话") }
        return model.remoteWorkspaces.first(where: { $0.scope.refersTo(selectedWorkspace) })?.name
            ?? selectedWorkspace.path
    }

    private var selectedModel: ComposerModelOption? {
        model.modelOptions.first(where: { $0.id == selectedModelID }) ?? model.modelOptions.first
    }

    private var selectedDeviceAutomationIdentifier: String {
        guard let deviceID = model.accountSelectedDeviceID,
              !deviceID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return "remoteCreate.device.unselected"
        }
        return "remoteCreate.device.\(deviceID)"
    }

    private var selectedWorkspaceAutomationIdentifier: String {
        selectedWorkspacePath.isEmpty
            ? "remoteCreate.workspace.chat"
            : "remoteCreate.workspace.\(selectedWorkspacePath)"
    }

    private func contextButton(
        kind: RemoteCreateSelectionKind,
        icon: String,
        label: String,
        automationIdentifier: String
    ) -> some View {
        Button { pickerKind = kind } label: {
            HStack(spacing: 13) {
                Image(systemName: icon)
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(OpenBitFunTheme.muted)
                    .frame(width: 26, height: 26)
                Text(label)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(OpenBitFunTheme.ink)
                    .lineLimit(1)
                Image(systemName: pickerKind == kind ? "chevron.up" : "chevron.down")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(OpenBitFunTheme.muted)
                Spacer(minLength: 0)
            }
            .frame(height: 48)
            .padding(.horizontal, 28)
        }
        .buttonStyle(.plain)
        .disabled(kind == .device
            ? !model.remoteCreateInteraction.canOpenDevicePicker
            : !model.remoteCreateInteraction.canOpenWorkspacePicker)
        .accessibilityIdentifier(automationIdentifier)
        .accessibilityLabel(model.localized(kind.accessibilityLabelKey))
        .accessibilityValue(label)
        .accessibilityHint(model.localized(kind.accessibilityHintKey))
        .anchorPreference(key: RemoteCreateSelectionAnchorKey.self, value: .bounds) {
            [kind: $0]
        }
    }

    private var createComposer: some View {
        VStack(spacing: 2) {
            TextField(
                "",
                text: $instruction,
                prompt: Text(model.localized(speech.isListening ? "正在聆听" : "告诉 OpenBitFun 要做什么"))
                    .foregroundColor(speech.isListening ? OpenBitFunTheme.statusSuccess : OpenBitFunTheme.muted),
                axis: .vertical
            )
            .font(MobileDesignTypography.bodyLarge.font)
            .lineLimit(1...4)
            .accessibilityIdentifier("remoteCreate.composer.input")
            .padding(.horizontal, 6)
            .frame(minHeight: MobileDesignGeometry.composerExpandedInputRowHeight)

            HStack(spacing: 8) {
                if !selectedWorkspacePath.isEmpty,
                   HarnessProfilePolicy.shared.supported(capabilities: model.remoteHostCapabilities) {
                    Menu {
                        ForEach([HarnessProfile.minimal, .standard, .ultimate], id: \.name) { profile in
                            Button { harnessProfile = profile } label: {
                                HarnessProfileLabel(model: model, profile: profile)
                            }
                        }
                    } label: {
                        HarnessProfileLabel(model: model, profile: harnessProfile)
                    }
                    .disabled(model.remoteCreateSubmitting)
                }
                if let selectedModel {
                    Button { pickerKind = .model } label: {
                        HStack(spacing: 4) {
                            Text(selectedModel.primaryLabel)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(OpenBitFunTheme.ink)
                                .lineLimit(1)
                            Image(systemName: pickerKind == .model ? "chevron.up" : "chevron.down")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(OpenBitFunTheme.muted)
                        }
                        .frame(height: 34)
                    }
                    .buttonStyle(.plain)
                    .anchorPreference(key: RemoteCreateSelectionAnchorKey.self, value: .bounds) {
                        [.model: $0]
                    }
                    .accessibilityLabel(model.localized(RemoteCreateSelectionKind.model.accessibilityLabelKey))
                    .accessibilityValue(selectedModel.primaryLabel)
                    .accessibilityHint(model.localized(RemoteCreateSelectionKind.model.accessibilityHintKey))
                    .disabled(model.remoteCreateSubmitting || model.isSending)
                }
                Spacer(minLength: 0)
                Button(action: primaryAction) {
                    Group {
                        if model.remoteCreateSubmitting {
                            ProgressView()
                                .tint(OpenBitFunTheme.contentOnAction)
                        } else {
                            Image(systemName: speech.isListening ? "stop.fill" : (instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "mic.fill" : "arrow.up"))
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(canSubmit ? OpenBitFunTheme.contentOnAction : OpenBitFunTheme.ink)
                        }
                    }
                    .frame(
                        width: MobileDesignGeometry.composerActionSize,
                        height: MobileDesignGeometry.composerActionSize
                    )
                    .background(canSubmit ? OpenBitFunTheme.accent : OpenBitFunTheme.soft)
                    .clipShape(Circle())
                }
                .buttonStyle(.plain)
                // A session-list refresh is not an active turn and must not disable creation here.
                .disabled(model.remoteCreateSubmitting || !model.remoteConnected)
                .accessibilityLabel(model.localized(model.remoteCreateSubmitting ? "正在加载" : (speech.isListening ? "停止语音输入" : (instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "语音输入" : "发送"))))
            }
            .frame(height: MobileDesignGeometry.composerExpandedActionRowHeight)
        }
        .padding(.horizontal, 8)
        .padding(.top, 4)
        .padding(.bottom, 2)
        .frame(minHeight: MobileDesignGeometry.composerExpandedHeight)
        .background(OpenBitFunTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: MobileDesignGeometry.composerExpandedRadius))
        .shadow(color: OpenBitFunTheme.shadowSubtle, radius: 10, y: 2)
        .padding(.horizontal, MobileDesignGeometry.contentGutter)
        .padding(.top, 8)
        .padding(.bottom, 14)
    }

    private var canSubmit: Bool {
        !instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            model.remoteCreateInteraction.canSubmit
    }

    private func createStatus(message: String, retryTitle: String, action: @escaping () -> Void) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(OpenBitFunTheme.statusDanger)
            Text(message)
                .font(.system(size: 13))
                .foregroundStyle(OpenBitFunTheme.ink)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 4)
            Button(retryTitle, action: action)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(OpenBitFunTheme.accent)
                .disabled(model.remoteCreateSubmitting || model.accountBusy)
                .accessibilityLabel(retryTitle)
                .accessibilityHint(model.localized("选择"))
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .background(OpenBitFunTheme.soft)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(model.localized("状态")): \(message)")
    }

    private func retryCreate() {
        if model.remoteCreateError != nil {
            model.createRemoteSession(
                agentType: selectedWorkspacePath.isEmpty ? "Claw" : HarnessProfilePolicy.shared.creationAgent(profile: harnessProfile, capabilities: model.remoteHostCapabilities),
                title: "",
                instruction: instruction,
                modelID: selectedModelID,
                workspacePath: selectedWorkspace?.path,
                remoteConnectionId: selectedWorkspace?.remoteConnectionId,
                remoteSshHost: selectedWorkspace?.remoteSshHost,
                workspaceId: selectedWorkspace?.workspaceId
            )
        } else if model.workspaceLoadFailed {
            model.retryRemoteWorkspaces()
        } else {
            model.refreshRemoteDevices()
        }
    }

    private func primaryAction() {
        if speech.isListening { speech.stop(); return }
        let value = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        log.info("Remote create primary action invoked: hasInput=\(!value.isEmpty, privacy: .public) connected=\(model.remoteConnected, privacy: .public) busy=\(model.busy, privacy: .public) submitting=\(model.remoteCreateSubmitting, privacy: .public)")
        if !value.isEmpty {
            guard canSubmit else {
                log.error("Remote create primary action blocked by model state: connected=\(model.remoteConnected, privacy: .public) busy=\(model.busy, privacy: .public) submitting=\(model.remoteCreateSubmitting, privacy: .public)")
                return
            }
            model.createRemoteSession(
                agentType: selectedWorkspacePath.isEmpty ? "Claw" : HarnessProfilePolicy.shared.creationAgent(profile: harnessProfile, capabilities: model.remoteHostCapabilities),
                title: "",
                instruction: value,
                modelID: selectedModelID,
                workspacePath: selectedWorkspace?.path,
                remoteConnectionId: selectedWorkspace?.remoteConnectionId,
                remoteSshHost: selectedWorkspace?.remoteSshHost,
                workspaceId: selectedWorkspace?.workspaceId
            )
            return
        }
        if speech.isListening {
            speech.stop()
            return
        }
        speech.start(
            localeIdentifier: model.appLanguage == .simplifiedChinese ? "zh-CN" : "en-US",
            onPartial: { instruction = $0 },
            onFailure: { model.showToast(model.localized($0)) }
        )
    }

    @ViewBuilder
    private func selectionContent(kind: RemoteCreateSelectionKind, includeHeader: Bool) -> some View {
        VStack(spacing: 0) {
            if includeHeader {
                OpenBitFunSelectionHeader(title: model.localized(kind.titleKey), onClose: { pickerKind = nil })
            }
            ScrollView(showsIndicators: false) {
                VStack(spacing: 0) {
                    switch kind {
                    case .device:
                        ForEach(model.accountDevices) { device in
                            selectionRow(
                                kind: .device,
                                icon: "desktopcomputer",
                                title: device.name.isEmpty ? device.id : device.name,
                                subtitle: model.localized(device.online ? "在线" : "离线"),
                                selected: device.selected,
                                enabled: device.online || device.selected
                            ) {
                                pickerKind = nil
                                selectedWorkspace = nil
                                model.selectRemoteDevice(device)
                            }
                        }
                    case .workspace:
                        switch model.remoteCreateWorkspacePhase {
                        case .loading:
                            selectionStatusRow(
                                title: model.localized("正在加载工作区"),
                                showsProgress: true
                            )
                        case .failed:
                            selectionRetryRow()
                        case .unavailable:
                            selectionStatusRow(
                                title: model.localized("连接不可用，请重新连接"),
                                showsProgress: false
                            )
                        case .ready:
                            if model.workspaceSelectionBusy {
                                selectionStatusRow(
                                    title: model.localized("正在加载"),
                                    showsProgress: true
                                )
                            }
                            selectionRow(
                                kind: .workspace,
                                icon: "message",
                                title: model.localized("对话"),
                                subtitle: "",
                                selected: selectedWorkspace == nil,
                                enabled: model.remoteCreateInteraction.canSelectWorkspace
                            ) {
                                selectedWorkspace = nil
                                pickerKind = nil
                            }
                            VStack {
                                TextField(model.localized("受控设备上的路径"), text: $newWorkspacePath)
                                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                                Picker(model.localized("已保存的 SSH 连接"), selection: $savedConnectionId) {
                                    Text(model.localized("受控设备本机")).tag("")
                                    ForEach(model.savedRuntimeConnections, id: \.id) { connection in
                                        Text(connection.name).tag(connection.id)
                                    }
                                }
                                if model.savedRuntimeConnectionsFailed {
                                    Text(model.localized("无法加载已保存连接，请刷新重试。")).foregroundStyle(OpenBitFunTheme.muted)
                                }
                                Button(model.localized("Browse folders")) {
                                    directoryConnectionId = savedConnectionId.isEmpty ? nil : savedConnectionId
                                    model.browseRuntimeDirectories(newWorkspacePath.isEmpty ? "/" : newWorkspacePath, connectionId: directoryConnectionId)
                                    directoryVisible = true
                                }
                                Button(model.localized("打开工作区")) {
                                    model.openRemoteWorkspacePath(newWorkspacePath, connectionId: savedConnectionId.isEmpty ? nil : savedConnectionId)
                                    pickerKind = nil
                                }
                                .disabled(newWorkspacePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.remoteCreateInteraction.canSelectWorkspace)
                            }.padding()
                            ForEach(model.remoteWorkspaces) { workspace in
                                selectionRow(
                                    kind: .workspace,
                                    icon: "folder",
                                    title: workspace.name,
                                    subtitle: workspace.path,
                                    selected: selectedWorkspace.map { workspace.scope.refersTo($0) } ?? false,
                                    enabled: model.remoteCreateInteraction.canSelectWorkspace
                                ) {
                                    selectedWorkspace = workspace.scope
                                    pickerKind = nil
                                }
                            }
                        }
                    case .model:
                        if model.modelOptions.isEmpty {
                            Text(model.localized("暂无可用模型"))
                                .font(.system(size: 13))
                                .foregroundStyle(OpenBitFunTheme.muted)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(18)
                                .accessibilityElement()
                                .accessibilityLabel(model.localized("暂无可用模型"))
                        } else {
                            ForEach(model.modelOptions) { option in
                                selectionRow(
                                    kind: .model,
                                    icon: option.source == "LOCAL" ? "gearshape" : "cloud",
                                    title: option.primaryLabel,
                                    subtitle: option.secondaryLabel,
                                    selected: option.id == selectedModelID,
                                    enabled: true
                                ) {
                                    selectedModelID = option.id
                                    pickerKind = nil
                                }
                            }
                        }
                    }
                }
            }
        }
        .background(OpenBitFunTheme.card)
        .fullScreenCover(isPresented: $directoryVisible) {
            NavigationStack {
                VStack {
                    if let state = model.runtimeDirectoryPicker {
                        Text(state.directory).font(.caption).padding()
                        if state.busy { ProgressView() }
                        if state.failed { Text(state.errorDetail ?? model.localized("文件操作失败，请重试。")) }
                        List {
                            Button(model.localized("Parent folder")) { model.browseRuntimeDirectories((state.directory as NSString).deletingLastPathComponent.isEmpty ? "/" : (state.directory as NSString).deletingLastPathComponent, connectionId: directoryConnectionId) }.disabled(state.directory == "/" || state.busy)
                            ForEach(state.entries.filter { $0.directory }, id: \.path) { entry in
                                Button(entry.name) { model.browseRuntimeDirectories(entry.path, connectionId: directoryConnectionId) }.disabled(state.busy)
                            }
                            if state.hasMore { Button(model.localized("显示更多")) { model.browseRuntimeDirectories(state.directory, connectionId: directoryConnectionId, append: true) }.disabled(state.busy) }
                        }
                    }
                }.navigationTitle(model.localized("Browse folders"))
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button(model.localized("返回")) { directoryVisible = false } }
                        ToolbarItem(placement: .confirmationAction) { Button(model.localized("Choose this folder")) { newWorkspacePath = model.runtimeDirectoryPicker?.directory ?? ""; directoryVisible = false }.disabled(model.runtimeDirectoryPicker?.busy != false || model.runtimeDirectoryPicker?.failed == true) }
                    }
            }
        }

    }

    private func selectionRow(
        kind: RemoteCreateSelectionKind,
        icon: String,
        title: String,
        subtitle: String,
        selected: Bool,
        enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: selected ? "checkmark.circle" : "circle")
                    .font(.system(size: 19))
                    .foregroundStyle(selected ? OpenBitFunTheme.ink : OpenBitFunTheme.transparent)
                    .frame(width: 20)
                Image(systemName: icon)
                    .font(.system(size: 19, weight: .medium))
                    .foregroundStyle(OpenBitFunTheme.muted)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(OpenBitFunTheme.ink)
                        .lineLimit(1)
                    if !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.system(size: 11))
                            .foregroundStyle(OpenBitFunTheme.muted)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(minHeight: 58)
            .padding(.horizontal, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.55)
        .accessibilityLabel("\(model.localized(kind.accessibilityLabelKey)): \(title)")
        .accessibilityValue(subtitle)
        .accessibilityHint(model.localized(kind.accessibilityHintKey))
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func selectionStatusRow(title: String, showsProgress: Bool) -> some View {
        HStack(spacing: 10) {
            if showsProgress {
                ProgressView().controlSize(.small)
            }
            Text(title)
                .font(.system(size: 14))
                .foregroundStyle(OpenBitFunTheme.muted)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 18)
        .frame(minHeight: 52)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
    }

    private func selectionRetryRow() -> some View {
        Button {
            model.retryRemoteWorkspaces()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "arrow.clockwise")
                Text(model.localized("工作区加载失败，请重试"))
                    .font(.system(size: 14, weight: .medium))
                Spacer(minLength: 0)
            }
            .foregroundStyle(OpenBitFunTheme.accent)
            .padding(.horizontal, 18)
            .frame(minHeight: 52)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(model.localized("重试"))
    }

    private func reconcileSelectedWorkspace() {
        if let selected = model.remoteWorkspaces.first(where: \.selected) {
            selectedWorkspace = selected.scope
        } else if let current = selectedWorkspace,
                  !model.remoteWorkspaces.contains(where: { $0.scope.refersTo(current) }) {
            selectedWorkspace = nil
        }
    }

    private func selectionHeight(_ kind: RemoteCreateSelectionKind) -> CGFloat {
        let count: Int
        switch kind {
        case .device: count = max(1, model.accountDevices.count)
        case .workspace: count = max(1, model.remoteWorkspaces.count + 1)
        case .model: count = max(1, model.modelOptions.count)
        }
        let header: CGFloat = horizontalSizeClass == .regular ? 16 : MobileDesignGeometry.sheetHeaderHeight
        return min(440, header + CGFloat(count * 64) + 24)
    }
}

enum RemoteCreateSelectionKind: String, Identifiable, Hashable {
    case device
    case workspace
    case model

    var id: String { rawValue }

    /// Stable localization keys owned by the mobile W3 catalog. The view is
    /// responsible for resolving them with the active app language.
    var titleKey: String {
        switch self {
        case .device: return "桌面设备"
        case .workspace: return "工作区"
        case .model: return "选择模型"
        }
    }

    var accessibilityLabelKey: String {
        switch self {
        case .device: return "桌面设备"
        case .workspace: return "工作区"
        case .model: return "选择模型"
        }
    }

    var accessibilityHintKey: String { "选择" }
}

struct RemoteCreateSelectionAnchorKey: PreferenceKey {
    static var defaultValue: [RemoteCreateSelectionKind: Anchor<CGRect>] = [:]

    static func reduce(
        value: inout [RemoteCreateSelectionKind: Anchor<CGRect>],
        nextValue: () -> [RemoteCreateSelectionKind: Anchor<CGRect>]
    ) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}

struct HarnessProfileLabel: View {
    @ObservedObject var model: MobileAppModel
    let profile: HarnessProfile
    private var density: Int { profile == .minimal ? 1 : (profile == .ultimate ? 3 : 2) }
    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 2) {
                ForEach(0..<density, id: \.self) { index in
                    RoundedRectangle(cornerRadius: 2).fill(OpenBitFunTheme.ink)
                        .frame(width: 4, height: CGFloat(8 + index * 5))
                }
            }.frame(width: 22, height: 22)
            Text(model.localized(profile == .minimal ? "极简" : (profile == .ultimate ? "极致" : "标准")))
                .font(MobileDesignTypography.titleSmall.font)
                .foregroundStyle(OpenBitFunTheme.ink)
        }
    }
}


private struct NativeRuntimeTerminalView: UIViewRepresentable {
    @Environment(\.colorScheme) private var colorScheme
    let state: RuntimeTerminalUiState
    let onInput: (String) -> Void
    let onResize: (Int, Int) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "openbitfunTerminal")
        #if DEBUG
        configuration.userContentController.addUserScript(WKUserScript(source: """
        for (const name of ['touchend', 'click', 'focusin', 'focusout']) {
          document.addEventListener(name, event => {
            const trusted = event.isTrusted;
            setTimeout(() => window.webkit.messageHandlers.openbitfunTerminal.postMessage({
              type: 'focus-diagnostic', event: name, trusted,
              documentFocused: document.hasFocus(),
              inputFocused: document.activeElement?.classList.contains('xterm-helper-textarea') === true
            }), 0);
          }, true);
        }
        """, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        #endif
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.scrollView.isScrollEnabled = false
        context.coordinator.view = view
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "generated") {
            view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) { context.coordinator.parent = self; context.coordinator.render(force: false) }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.disposed = true
        view.configuration.userContentController.removeScriptMessageHandler(forName: "openbitfunTerminal")
        view.stopLoading()
    }
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: NativeRuntimeTerminalView
        weak var view: WKWebView?
        var disposed = false
        var ready = false
        var epoch: String?
        var revision: Int64 = -1
        private var appliedTheme: String?
        init(_ parent: NativeRuntimeTerminalView) { self.parent = parent }
        private func renderTheme() {
            guard ready, !disposed, let view else { return }
            let traits = UITraitCollection(userInterfaceStyle: parent.colorScheme == .dark ? .dark : .light)
            func css(_ color: Color) -> String {
                var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
                UIColor(color).resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
                return String(format: "#%02X%02X%02X", Int((red * 255).rounded()), Int((green * 255).rounded()), Int((blue * 255).rounded()))
            }
            let theme = ["background": css(OpenBitFunTheme.page), "foreground": css(OpenBitFunTheme.ink), "cursor": css(OpenBitFunTheme.ink)]
            guard let data = try? JSONSerialization.data(withJSONObject: theme, options: .sortedKeys),
                  let json = String(data: data, encoding: .utf8), json != appliedTheme else { return }
            view.isOpaque = false
            view.backgroundColor = UIColor(OpenBitFunTheme.page).resolvedColor(with: traits)
            view.evaluateJavaScript("window.OpenBitFunTerminal.setTheme(\(json))")
            appliedTheme = json
        }
        func render(force: Bool) {
            renderTheme()
            let state = parent.state
            guard ready, !disposed, let id = state.sessionId else { return }
            guard force || epoch != id || revision != state.revision else { return }
            let reset = force || epoch != id || state.reset || state.revision != revision + 1
            let frame: [String: Any] = ["epoch": id, "revision": state.revision, "reset": reset, "data": reset ? state.output : state.chunk]
            guard let data = try? JSONSerialization.data(withJSONObject: frame), let json = String(data: data, encoding: .utf8) else { return }
            view?.evaluateJavaScript("window.OpenBitFunTerminal.accept(\(json))")
            epoch = id; revision = state.revision
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard !disposed, let event = message.body as? [String: Any], let type = event["type"] as? String else { return }
            switch type {
            #if DEBUG
            case "focus-diagnostic":
                let log = Logger(subsystem: "com.openbitfun.mobile.ios", category: "terminal-focus")
                let name = event["event"] as? String ?? "unknown"
                let trusted = event["trusted"] as? Bool ?? false
                let documentFocused = event["documentFocused"] as? Bool ?? false
                let inputFocused = event["inputFocused"] as? Bool ?? false
                let keyWindow = view?.window?.isKeyWindow ?? false
                let responder = view.map { Self.responderName($0) } ?? "detached"
                log.info("Terminal focus event=\(name, privacy: .public) trusted=\(trusted) document=\(documentFocused) input=\(inputFocused) keyWindow=\(keyWindow) responder=\(responder, privacy: .public)")
            #endif
            case "ready": ready = true; render(force: true)
            case "resync": render(force: true)
            case "input": if let data = event["data"] as? String { parent.onInput(data) }
            case "resize": if let cols = event["cols"] as? Int, let rows = event["rows"] as? Int, cols > 0, rows > 0 { parent.onResize(cols, rows) }
            default: break
            }
        }
        #if DEBUG
        private static func responderName(_ view: UIView) -> String {
            if view.isFirstResponder { return String(describing: type(of: view)) }
            for child in view.subviews {
                let name = responderName(child)
                if name != "none" { return name }
            }
            return "none"
        }
        #endif
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { webView.evaluateJavaScript("window.OpenBitFunTerminal.connect()") }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(navigationAction.request.url?.isFileURL == true ? .allow : .cancel)
        }
    }
}

private struct NativeRuntimeFileEditor: View {
    @ObservedObject var model: MobileAppModel
    @ObservedObject private var draft: RuntimeFileDraftState
    private var content: String { draft.content }
    @State private var discard = false
    @State private var rename = false
    @State private var delete = false
    @State private var renamePath = ""
    private var dirty: Bool { content != (model.runtimeFiles?.content ?? "") }
    init(model: MobileAppModel) {
        self.model = model
        self.draft = model.runtimeFileDraft
    }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let files = model.runtimeFiles {
                    Text(files.file ?? "").font(.caption).frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    if files.failed { Text(files.saveConflict ? model.localized("File changed on the computer. Your draft is preserved. Copy it before reopening the file to load the latest version.") : files.errorDetail ?? model.localized("文件操作失败，请重试。")) }
                    NativeNumberedCodeEditor(text: $draft.content, enabled: !files.busy).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle(((model.runtimeFiles?.file ?? "") as NSString).lastPathComponent)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(model.localized("返回")) { if dirty { discard = true } else { model.closeRuntimeFileEditor() } }.disabled(model.runtimeFiles?.busy == true) }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button(model.localized("重命名打开的文件")) { renamePath = model.runtimeFiles?.file ?? ""; rename = true }
                        Button(model.localized("删除打开的文件"), role: .destructive) { delete = true }
                    } label: { Image(systemName: "ellipsis") }.disabled(dirty || model.runtimeFiles?.busy == true)
                }
                ToolbarItem(placement: .confirmationAction) { Button(model.localized("保存文件")) { model.saveRuntimeFile(content) }.disabled(!dirty || model.runtimeFiles?.busy == true) }
            }
            .alert(model.localized("重命名打开的文件"), isPresented: $rename) {
                TextField(model.localized("文件路径"), text: $renamePath).autocorrectionDisabled().textInputAutocapitalization(.never)
                Button(model.localized("重命名打开的文件")) { model.renameRuntimeFile(renamePath) }.disabled(renamePath.isEmpty)
                Button(model.localized("取消"), role: .cancel) { }
            }
            .confirmationDialog(model.localized("删除打开的文件"), isPresented: $delete, titleVisibility: .visible) {
                Button(model.localized("删除打开的文件"), role: .destructive) { model.deleteRuntimeFile() }
                Button(model.localized("取消"), role: .cancel) { }
            }
            .confirmationDialog(model.localized("Discard unsaved changes?"), isPresented: $discard, titleVisibility: .visible) {
                Button(model.localized("Discard"), role: .destructive) { model.closeRuntimeFileEditor() }
                Button(model.localized("取消"), role: .cancel) { }
            }
        }.interactiveDismissDisabled(dirty || model.runtimeFiles?.busy == true)
    }
}

/// UIKit owns selection, keyboard editing and scroll offsets; the gutter is presentation only.
private struct NativeNumberedCodeEditor: UIViewRepresentable {
    @Binding var text: String
    let enabled: Bool
    func makeUIView(context: Context) -> NumberedCodeEditorView {
        let view = NumberedCodeEditorView()
        view.changed = { text = $0 }
        return view
    }
    func updateUIView(_ view: NumberedCodeEditorView, context: Context) {
        view.changed = { text = $0 }
        view.editor.isEditable = enabled
        if view.editor.text != text { view.setContent(text) }
    }
}

private final class NumberedCodeEditorView: UIView, UITextViewDelegate {
    let editor = UITextView()
    private let gutter = UITextView()
    var changed: ((String) -> Void)?
    private let codeFont = UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)
    private var lineCount = 0
    override init(frame: CGRect) {
        super.init(frame: frame)
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = 21; paragraph.maximumLineHeight = 21
        for view in [editor, gutter] {
            view.font = codeFont
            view.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
            view.textContainer.lineFragmentPadding = 0
            view.backgroundColor = UIColor(OpenBitFunTheme.card)
            view.textColor = UIColor(OpenBitFunTheme.ink)
            view.typingAttributes = [.font: codeFont, .paragraphStyle: paragraph]
            view.isScrollEnabled = true
            view.contentInsetAdjustmentBehavior = .never
            addSubview(view)
        }
        gutter.isEditable = false; gutter.isSelectable = false; gutter.isUserInteractionEnabled = false
        gutter.textColor = UIColor(OpenBitFunTheme.muted)
        gutter.showsVerticalScrollIndicator = false; gutter.showsHorizontalScrollIndicator = false
        editor.textContainer.widthTracksTextView = false
        editor.textContainer.heightTracksTextView = false
        editor.autocorrectionType = .no; editor.autocapitalizationType = .none
        editor.smartQuotesType = .no; editor.smartDashesType = .no; editor.smartInsertDeleteType = .no
        editor.delegate = self
        updateLines()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func layoutSubviews() {
        super.layoutSubviews()
        let gutterWidth = max(52, CGFloat(String(max(lineCount, 1)).count) * codeFont.pointSize + 24)
        gutter.frame = CGRect(x: 0, y: 0, width: gutterWidth, height: bounds.height)
        editor.frame = CGRect(x: gutterWidth, y: 0, width: max(0, bounds.width - gutterWidth), height: bounds.height)
        updateContainerWidth()
    }
    private func updateContainerWidth() {
        let longest = editor.text.components(separatedBy: "\n").map { ($0 as NSString).size(withAttributes: [.font: codeFont]).width }.max() ?? 0
        editor.textContainer.size = CGSize(width: max(editor.bounds.width - 24, longest + 32), height: .greatestFiniteMagnitude)
    }
    func setContent(_ content: String) {
        let paragraph = NSMutableParagraphStyle(); paragraph.minimumLineHeight = 21; paragraph.maximumLineHeight = 21
        editor.attributedText = NSAttributedString(string: content, attributes: [.font: codeFont, .paragraphStyle: paragraph, .foregroundColor: UIColor(OpenBitFunTheme.ink)])
        editor.typingAttributes = [.font: codeFont, .paragraphStyle: paragraph, .foregroundColor: UIColor(OpenBitFunTheme.ink)]
        updateLines()
    }
    func updateLines() {
        let count = editor.text.components(separatedBy: "\n").count
        if count != lineCount {
            lineCount = count
            let paragraph = NSMutableParagraphStyle(); paragraph.minimumLineHeight = 21; paragraph.maximumLineHeight = 21
            gutter.attributedText = NSAttributedString(string: (1...max(count, 1)).map(String.init).joined(separator: "\n"), attributes: [.font: codeFont, .paragraphStyle: paragraph, .foregroundColor: UIColor(OpenBitFunTheme.muted)])
        }
        updateContainerWidth(); setNeedsLayout()
    }
    func textViewDidChange(_ textView: UITextView) { updateLines(); changed?(textView.text) }
    func scrollViewDidScroll(_ scrollView: UIScrollView) { gutter.contentOffset = CGPoint(x: 0, y: editor.contentOffset.y) }
}

struct NativeDeviceToolsView: View {
    @ObservedObject var model: MobileAppModel
    private var terminal: Bool { model.runtimeDeviceTools?.panel == .terminal }
    let rootPath: String
    let deviceKey: String?
    let onBack: () -> Void
    private func panelTab(_ title: String, isTerminal: Bool) -> some View {
        let selected = terminal == isTerminal
        return Button { model.selectDeviceToolsPanel(terminal: isTerminal) } label: {
            VStack(spacing: 0) {
                Text(title)
                    .fontWeight(selected ? .semibold : .regular)
                    .frame(maxWidth: .infinity, minHeight: 44)
                Rectangle().fill(OpenBitFunTheme.ink)
                    .frame(height: 2).opacity(selected ? 1 : 0)
            }
            .foregroundStyle(selected ? OpenBitFunTheme.ink : OpenBitFunTheme.muted)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(isTerminal ? "device.tools.panel.terminal" : "device.tools.panel.files")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Menu {
                    Button(model.localized("受控设备本机")) { model.openDeviceTools() }
                    ForEach(model.savedRuntimeConnections, id: \.id) { connection in
                        Button(connection.name) { model.openDeviceTools(connectionId: connection.id) }
                    }
                } label: {
                    HStack {
                        Image(systemName: "desktopcomputer")
                        Text(model.savedRuntimeConnections.first(where: { $0.id == model.runtimeDeviceTools?.connectionId })?.name ?? model.localized("受控设备本机"))
                        Image(systemName: "chevron.down")
                    }.frame(maxWidth: .infinity, alignment: .leading).padding()
                }.disabled(model.runtimeDeviceTools?.busy == true || model.runtimeFiles?.file != nil)
                HStack(spacing: 0) {
                    panelTab(model.localized("浏览文件"), isTerminal: false)
                    panelTab(model.localized("终端"), isTerminal: true)
                }.disabled(model.runtimeFiles?.file != nil)
                if model.runtimeDeviceTools?.busy == true {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if model.runtimeDeviceTools?.failed == true {
                    Button(model.localized("重试")) { model.openDeviceTools(connectionId: model.runtimeDeviceTools?.connectionId) }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if terminal {
                    if let state = model.runtimeTerminal {
                        if state.failed { Text(state.errorDetail ?? model.localized("终端请求失败。")) }
                        if state.busy { ProgressView() }
                        if state.sessionId != nil { NativeRuntimeTerminalView(state: state, onInput: model.writeRuntimeTerminal, onResize: model.resizeRuntimeTerminal).frame(maxWidth: .infinity, maxHeight: .infinity) }
                        else if !state.busy {
                            VStack(spacing: 20) {
                                Image(systemName: "terminal")
                                    .font(.system(size: 36))
                                    .foregroundStyle(OpenBitFunTheme.muted)
                                Button(model.localized("打开终端")) { model.startDeviceToolsTerminal() }
                                    .accessibilityIdentifier("device.tools.openTerminal")
                                    .buttonStyle(.bordered)
                                    .controlSize(.large)
                            }
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .padding(16)
                        }
                    }
                } else {
                    NativeRuntimeFileBrowser(model: model, deviceKey: deviceKey)

                }
            }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .navigationBarTitleDisplayMode(.inline)
                .tint(OpenBitFunTheme.ink)
                .navigationTitle(model.localized("Device tools"))
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(model.localized("返回"), action: onBack) }
                    ToolbarItemGroup(placement: .confirmationAction) {
                        if terminal, let state = model.runtimeTerminal, state.sessionId != nil {
                            Button(model.localized("停止")) { model.writeRuntimeTerminal("\u{03}") }
                                .disabled(state.busy)
                            Button(model.localized("关闭终端")) { model.closeRuntimeTerminal() }
                                .disabled(state.busy)
                        }
                    }
                }
                .onChange(of: model.remoteExpectedDeviceKey) { if $0 != deviceKey { onBack() } }
                .fullScreenCover(isPresented: Binding(get: { !terminal && model.runtimeFiles?.file != nil }, set: { if !$0 { model.closeRuntimeFileEditor() } })) { NativeRuntimeFileEditor(model: model) }
        }
        .modifier(RuntimeDownloadPresentation(model: model, enabled: model.runtimeDeviceTools?.visible == true))
    }
}

private enum RuntimeFileListAction: String, Identifiable {
    case file, directory, rename, delete, upload
    var id: String { rawValue }
    var label: String {
        switch self {
        case .file: return "新建文件"
        case .directory: return "创建文件夹"
        case .rename: return "重命名"
        case .delete: return "删除"
        case .upload: return "Upload file"
        }
    }
}

private struct NativeRuntimeFileBrowser: View {
    @ObservedObject var model: MobileAppModel
    let deviceKey: String?
    @State private var action: RuntimeFileListAction?
    @State private var name = ""
    @State private var target = ""
    @State private var submittedRevision: Int64?
    @State private var uploadPicker = false
    private var busy: Bool { model.runtimeFiles?.busy == true }
    private func begin(_ value: RuntimeFileListAction, path: String = "", name: String = "") {
        self.action = value; self.target = path; self.name = name; submittedRevision = nil
    }
    var body: some View {
        VStack(spacing: 0) {
            if let files = model.runtimeFiles {
                VStack(alignment: .leading, spacing: 8) {
                    Text(files.directory).font(.caption).foregroundStyle(OpenBitFunTheme.muted).lineLimit(2)
                    HStack {
                        Button { model.browseRuntimeFiles((files.directory as NSString).deletingLastPathComponent.isEmpty ? "/" : (files.directory as NSString).deletingLastPathComponent) } label: { Image(systemName: "arrow.up").frame(width: 44, height: 44) }.accessibilityLabel(model.localized("Parent folder")).disabled(files.directory == "/")
                        Button { model.browseRuntimeFiles(files.directory) } label: { Image(systemName: "arrow.clockwise").frame(width: 44, height: 44) }.accessibilityLabel(model.localized("刷新"))
                        Menu {
                            Button(model.localized("Name: A–Z")) { model.sortRuntimeFiles(.nameAsc) }
                            Button(model.localized("Name: Z–A")) { model.sortRuntimeFiles(.nameDesc) }
                            Button(model.localized("Modified: newest first")) { model.sortRuntimeFiles(.modifiedDesc) }
                            Button(model.localized("Modified: oldest first")) { model.sortRuntimeFiles(.modifiedAsc) }
                        } label: {
                            Text(sortLabel(files.sort)).lineLimit(1).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        }.accessibilityLabel(model.localized("Sort files"))
                        Menu {
                            Button(model.localized("新建文件")) { begin(.file) }
                            Button(model.localized("创建文件夹")) { begin(.directory) }
                            Button(model.localized("Upload file")) { begin(.upload) }
                        } label: { Image(systemName: "plus").frame(width: 44, height: 44) }.accessibilityIdentifier("file.browser.create")
                    }

                }.padding(.horizontal, 16).disabled(busy)
                if busy { ProgressView().padding(8) }
                if files.failed && action == nil { Text(files.errorDetail ?? model.localized("文件操作失败，请重试。")).font(.caption).padding(8) }
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(files.entries, id: \.path) { entry in
                            HStack(spacing: 12) {
                                Button {
                                    if entry.directory { model.browseRuntimeFiles(entry.path) } else { model.readRuntimeFile(entry.path) }
                                } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: entry.directory ? "folder" : "doc").foregroundStyle(OpenBitFunTheme.muted).frame(width: 22)
                                        Text(entry.name).lineLimit(2).multilineTextAlignment(.leading)
                                        Spacer(minLength: 0)
                                    }.frame(minHeight: 52).contentShape(Rectangle())
                                }.buttonStyle(.plain)
                                Menu {
                                    if !entry.directory { Button(model.localized("下载")) { model.downloadWorkspaceFile(path: entry.path, label: entry.name) } }
                                    Button(model.localized("重命名")) { begin(.rename, path: entry.path, name: entry.name) }
                                    Button(model.localized("删除"), role: .destructive) { begin(.delete, path: entry.path, name: entry.name) }
                                } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
                                    .accessibilityIdentifier("file.browser.actions.\(entry.path)")
                            }.disabled(busy)
                            Divider()
                        }
                        if files.hasMore { Button(model.localized("显示更多")) { model.browseRuntimeFiles(files.directory, append: true) }.padding().disabled(busy) }
                    }.padding(.horizontal, 16)
                }
                .id("\(files.directory):\(files.sort.ordinal)")
            }
        }
        .sheet(item: $action) { value in
            VStack(spacing: 16) {
                HStack(spacing: 12) {
                    Button(model.localized("取消")) { action = nil }.frame(minHeight: 44)
                    Spacer(minLength: 0)
                    Text(model.localized(value.label)).font(.headline)
                    Spacer(minLength: 0)
                    Button(model.localized(value.label), role: value == .delete ? .destructive : nil) { submit(value) }
                        .accessibilityIdentifier("file.action.submit").buttonStyle(.borderedProminent)
                        .disabled(submittedRevision != nil || (value != .delete && name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }.disabled(busy)
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if value == .delete { Text(target).font(.callout).foregroundStyle(OpenBitFunTheme.muted) }
                        else { TextField(model.localized("File name"), text: $name).textFieldStyle(.roundedBorder).autocorrectionDisabled().textInputAutocapitalization(.never).disabled(busy).accessibilityIdentifier("file.action.name") }
                        if model.runtimeFiles?.failed == true { Text(model.runtimeFiles?.errorDetail ?? model.localized("文件操作失败，请重试。")).font(.caption) }
                        if busy { ProgressView() }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            }.padding(24)
                .presentationDetents([.height(240)]).background(OpenBitFunTheme.page)
                .presentationDragIndicator(.visible).interactiveDismissDisabled(busy)
                .tint(OpenBitFunTheme.ink)
                .fileImporter(isPresented: $uploadPicker, allowedContentTypes: [.data], allowsMultipleSelection: false) { result in
                    guard model.remoteExpectedDeviceKey == deviceKey else { return }
                    if case .success(let urls) = result, let url = urls.first {
                        submittedRevision = model.runtimeFiles?.completedOperation
                        if !model.uploadRuntimeFileEntry(name, url: url) { submittedRevision = nil }
                    } else if case .failure = result { model.showToast(model.localized("Could not read the selected file. Choose a local file and retry.")) }
                }
        }
        .onChange(of: model.runtimeFiles?.completedOperation) { revision in
            if let submittedRevision, let revision, revision > submittedRevision {
                if model.runtimeFiles?.failed != true { action = nil }
                self.submittedRevision = nil
            }
        }
    }
    private func sortLabel(_ sort: RuntimeFileSort) -> String {
        switch sort {
        case .nameDesc: return model.localized("Name: Z–A")
        case .modifiedDesc: return model.localized("Modified: newest first")
        case .modifiedAsc: return model.localized("Modified: oldest first")
        default: return model.localized("Name: A–Z")
        }
    }
    private func submit(_ value: RuntimeFileListAction) {
        if value == .upload { uploadPicker = true; return }
        submittedRevision = model.runtimeFiles?.completedOperation
        switch value {
        case .file: model.createRuntimeFileEntry(name, directory: false)
        case .directory: model.createRuntimeFileEntry(name, directory: true)
        case .rename: model.renameRuntimeFileEntry(target, name: name)
        case .delete: model.deleteRuntimeFileEntry(target)
        case .upload: break
        }
    }
}
