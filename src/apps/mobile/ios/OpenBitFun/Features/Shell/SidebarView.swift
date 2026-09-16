import OpenBitFunMobileCore
import SwiftUI

private func normalizedDeviceKey(_ key: String?) -> String? {
    guard let key else { return nil }
    if key == "pairing" { return key }
    return key.hasPrefix("account:") ? String(key.dropFirst("account:".count)) : key
}

struct SidebarSessionActionsAnchorKey: PreferenceKey {
    static var defaultValue: [String: Anchor<CGRect>] = [:]

    static func reduce(
        value: inout [String: Anchor<CGRect>],
        nextValue: () -> [String: Anchor<CGRect>]
    ) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}

struct SidebarWorkspaceCreateAnchorKey: PreferenceKey {
    static var defaultValue: [String: Anchor<CGRect>] = [:]

    static func reduce(
        value: inout [String: Anchor<CGRect>],
        nextValue: () -> [String: Anchor<CGRect>]
    ) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}

struct SidebarView: View {
    @ObservedObject var model: MobileAppModel
    var permanent = false
    var onCollapse: (() -> Void)? = nil
    var onPermanentActions: ((ChatSession) -> Void)? = nil
    @State private var search = ""
    @State private var searchVisible = false
    @State private var expandedWorkspacePaths: Set<String> = []
    @State private var visibleDeviceWorkspaceCounts: [String: Int] = [:]
    @State private var compactActionSession: ChatSession?
    @State private var workspacePickerDevice: MobileDeviceDirectoryEntry?
    @State private var workspaceCreateTarget: MobileWorkspaceGroup?
    @State private var pendingWorkspaceCreate: NativeWorkspaceCreateTarget?
    @State private var workspaceCreatePath: String?
    @State private var remoteChatsCollapsed = false

    private var hasActiveRemoteViewFilter: Bool {
        !model.remoteWorkspaceFilter.isEmpty ||
            !model.remoteViewAgentFilter.isEmpty ||
            !model.remoteStatusFilter.isEmpty
    }

    private var directoryEntries: [MobileDeviceDirectoryEntry] { model.deviceDirectory }

    private var selectedDirectoryEntry: MobileDeviceDirectoryEntry? {
        directoryEntries.first(where: \.expanded)
    }

    private var showsPrimaryNavigation: Bool {
        model.accountUser != nil || model.remoteExpectedDeviceKey != nil || model.remoteConnected
    }

    var body: some View {
        GeometryReader { proxy in
            VStack(alignment: .leading, spacing: 0) {
                if showsPrimaryNavigation { authenticatedHeader } else { signedOutHeader }
                if searchVisible {
                    searchField
                }
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 0) {
                        MiniAppsButton(model: model, sidebar: true)
                        workspaceSection
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.bottom, 12)
                    }
                }
                .frame(minHeight: 0, maxHeight: .infinity)
                .layoutPriority(-1)
                .clipped()
                .accessibilityIdentifier("sidebar.workspaces")
                footer.background(OpenBitFunTheme.page)
            }
            .padding(.horizontal, 20)
            .padding(.top, 4)
            .padding(.bottom, 16)
            .frame(
                width: proxy.size.width,
                height: proxy.size.height,
                alignment: .topLeading
            )
            .background(OpenBitFunTheme.page)
        }
        .sheet(item: $compactActionSession) { session in
            let detentHeight: CGFloat = model.surface == .local ? 330 : 230
            let surface = SessionActionSurface(
                model: model,
                session: session,
                presentation: .bottomSheet,
                canViewDetails: true,
                canArchive: false,
                canExport: false,
                canDelete: true,
                onViewDetails: { openDetails(afterClosing: session) },
                onArchive: {},
                onExport: {},
                onDelete: {
                    model.deleteRemoteSession(session)
                },
                onClose: { compactActionSession = nil }
            )
            .frame(maxHeight: .infinity, alignment: .top)
            .presentationDetents([.height(detentHeight)])
            .presentationDragIndicator(.visible)
            if #available(iOS 16.4, *) {
                surface.presentationCornerRadius(MobileDesignGeometry.popoverRadius)
            } else {
                surface
            }
        }
        .onChange(of: model.remoteWorkspaces) { _ in finishWorkspaceCreateWhenReady() }
        .onChange(of: model.remoteCreateInteraction.canSubmit) { _ in finishWorkspaceCreateWhenReady() }
        .fullScreenCover(isPresented: Binding(get: { model.runtimeDeviceTools?.visible == true }, set: { if !$0 { model.closeDeviceTools() } })) {
            NativeDeviceToolsView(model: model, rootPath: model.runtimeDeviceTools?.path ?? "", deviceKey: model.remoteExpectedDeviceKey) { model.closeDeviceTools() }
        }
        .sheet(item: $workspacePickerDevice) { requestedDevice in
            let device = directoryEntries.first(where: { $0.id == requestedDevice.id }) ?? requestedDevice
            SidebarWorkspacePickerSheet(
                device: device,
                onClose: { workspacePickerDevice = nil },
                onSelect: { workspace in
                    workspacePickerDevice = nil
                    model.selectDirectoryWorkspace(workspace)
                }
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.hidden)
        }
        .overlayPreferenceValue(SidebarWorkspaceCreateAnchorKey.self) { anchors in
            GeometryReader { proxy in
                if let path = workspaceCreatePath,
                   let workspace = workspaceCreateTarget ?? model.remoteWorkspaces.first(where: { ($0.path + ":" + ($0.remoteConnectionId ?? "")) == path }),
                   let anchor = anchors[path] {
                    let frame = proxy[anchor]
                    let menuHeight = HarnessProfilePolicy.shared.supported(capabilities: model.remoteHostCapabilities)
                        ? 46 * 3 + 16
                        : MobileDesignGeometry.compactPopoverActionHeight + 16
                    ZStack(alignment: .topLeading) {
                        OpenBitFunTheme.transparent
                            .contentShape(Rectangle())
                            .onTapGesture { workspaceCreatePath = nil }
                        workspaceCreateMenu(workspace)
                            .position(
                                x: min(
                                    max(MobileDesignGeometry.compactPopoverWidth / 2 + 8, frame.midX),
                                    proxy.size.width - MobileDesignGeometry.compactPopoverWidth / 2 - 8
                                ),
                                y: max(menuHeight / 2 + 8, frame.minY - menuHeight / 2 - 6)
                            )
                    }
                }
            }
        }
        .task {
            if ProcessInfo.processInfo.arguments.contains("--workspace-picker"),
               workspacePickerDevice == nil,
               let device = selectedDirectoryEntry {
                try? await Task.sleep(nanoseconds: 450_000_000)
                workspacePickerDevice = device
            } else if ProcessInfo.processInfo.arguments.contains("--project-create-menu"),
               workspaceCreatePath == nil,
               let workspace = model.remoteWorkspaces.first {
                try? await Task.sleep(nanoseconds: 450_000_000)
                workspaceCreatePath = workspace.path + ":" + (workspace.remoteConnectionId ?? "")
            } else if ProcessInfo.processInfo.arguments.contains("--sidebar-actions"),
                      compactActionSession == nil,
                      let session = model.sessionListSections.flatMap(\.sessions).first {
                try? await Task.sleep(nanoseconds: 450_000_000)
                if permanent { onPermanentActions?(session) }
                else { compactActionSession = session }
            }
        }
    }

    private var authenticatedHeader: some View {
        HStack(spacing: 6) {
            Text(verbatim: "OpenBitFun")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(OpenBitFunTheme.ink)
            Spacer(minLength: 0)
            if let onCollapse {
                Button(action: onCollapse) {
                    Image(systemName: "sidebar.left")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(OpenBitFunTheme.muted)
                        .frame(width: 38, height: 38)
                        .background(OpenBitFunTheme.card)
                        .overlay(Circle().stroke(OpenBitFunTheme.line, lineWidth: 1))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(model.localized("收起侧栏")))
            }
            Button {
                withAnimation(.easeOut(duration: 0.18)) { searchVisible.toggle() }
                if !searchVisible { search = "" }
            } label: {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 18, weight: .regular))
                    .frame(width: 22, height: 22)
                    .frame(width: 44, height: 44)
                    .background(OpenBitFunTheme.card)
                    .overlay(Circle().stroke(OpenBitFunTheme.line, lineWidth: 0.5))
                    .clipShape(Circle())
                    .shadow(color: MobileDesignColors.shadowFaint, radius: 9, y: 3)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(model.localized("搜索")))
        }
        .frame(height: 50)
    }

    private var signedOutHeader: some View {
        HStack(spacing: 8) {
            Button { model.connectRemote() } label: {
                HStack(spacing: 8) {
                    Image(systemName: "folder.badge.gearshape")
                        .font(.system(size: 17, weight: .medium))
                    Text(model.localized("连接桌面端"))
                        .font(.system(size: 15, weight: .medium))
                }
                .foregroundStyle(OpenBitFunTheme.ink)
                .frame(height: 42)
            }
            .buttonStyle(.plain)
            Spacer(minLength: 0)
            if let onCollapse {
                Button(action: onCollapse) {
                    Image(systemName: "sidebar.left")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(OpenBitFunTheme.muted)
                        .frame(width: 38, height: 38)
                        .background(OpenBitFunTheme.card)
                        .overlay(Circle().stroke(OpenBitFunTheme.line, lineWidth: 1))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(model.localized("收起侧栏")))
            }
        }
        .frame(height: 50)
    }

    private var searchField: some View {
        TextField(model.localized("搜索对话"), text: $search)
            .font(.system(size: 14))
            .foregroundStyle(OpenBitFunTheme.ink)
            .padding(.horizontal, 14)
            .frame(height: 42)
            .background(OpenBitFunTheme.soft)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .padding(.top, 12)
            .onChange(of: search) { value in
                if model.surface == .remote { model.searchRemoteSessions(value) }
            }
    }

    private func openDetails(afterClosing session: ChatSession) {
        compactActionSession = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.24) {
            model.showSessionDetails(session)
        }
    }

    private var workspaceSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(model.localized("设备"))
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(OpenBitFunTheme.muted)
                Spacer()
                if model.accountUser != nil {
                    Button { model.refreshRemoteDevices() } label: {
                        if model.accountRefreshing {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(OpenBitFunTheme.muted)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text(model.localized("刷新设备")))
                }

            }
            .frame(height: 38)
            .padding(.top, 18)

            if let error = model.accountDirectoryError {
                Button { model.refreshRemoteDevices() } label: {
                    Text(error)
                        .font(.system(size: 12))
                        .foregroundStyle(OpenBitFunTheme.statusDanger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                .disabled(model.accountRefreshing)
                .accessibilityHint(Text(model.localized("刷新设备")))
            }

            if directoryEntries.isEmpty {
                Text(model.localized("尚未连接桌面设备"))
                    .font(.system(size: 13))
                    .foregroundStyle(OpenBitFunTheme.muted)
                    .padding(.horizontal, 10)
                    .frame(height: 42, alignment: .leading)
            }

            ForEach(directoryEntries) { device in
                directoryDeviceSelector(device)
                if isCurrentDevice(device), model.connectionPhase != .connected {
                    HStack {
                        Text(activeConnectionLabel)
                            .font(MobileDesignTypography.labelSmall.font)
                            .foregroundStyle(OpenBitFunTheme.muted)
                        Spacer(minLength: 0)
                        Button {
                            model.retryRemoteConnection()
                        } label: {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(OpenBitFunTheme.muted)
                                .frame(width: 44, height: 44)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text(model.localized("重试")))
                        .accessibilityIdentifier("sidebar.retryConnection")
                    }
                    .padding(.leading, 10)
                }
            }

            if let selectedDirectoryEntry {
                HStack {
                    Text(model.localized("工作区"))
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(OpenBitFunTheme.muted)
                    Spacer(minLength: 0)
                    Button {
                        workspacePickerDevice = selectedDirectoryEntry
                        model.refreshDirectoryWorkspacesForPicker(selectedDirectoryEntry)
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 18, weight: .regular))
                            .foregroundStyle(selectedDirectoryEntry.online ? OpenBitFunTheme.ink : OpenBitFunTheme.muted)
                            .frame(width: 34, height: 34)
                    }
                    .buttonStyle(.plain)
                    .disabled(!selectedDirectoryEntry.online)
                    .opacity(selectedDirectoryEntry.online ? 1 : 0.38)
                    .accessibilityLabel(Text(model.localized("添加工作区")))
                }
                .frame(height: 48)
                .padding(.top, 16)

                directoryDeviceBody(selectedDirectoryEntry)
            }
        }
    }

    @ViewBuilder
    private func directoryDeviceSelector(_ device: MobileDeviceDirectoryEntry) -> some View {
        let expanded = selectedDirectoryEntry?.id == device.id
        let current = isCurrentDevice(device)
        Button { selectDirectoryDevice(device) } label: {
            HStack(spacing: 8) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 18, weight: .regular))
                    .frame(width: 24, height: 20)
                Text(device.name)
                    .font(.system(size: 14, weight: current ? .bold : .regular))
                    .foregroundStyle(device.online ? OpenBitFunTheme.ink : OpenBitFunTheme.muted)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if device.status == "LOADING" {
                    ProgressView().controlSize(.small)
                } else {
                    Circle()
                        .fill(current ? activeConnectionColor : (device.online ? OpenBitFunTheme.statusSuccess : OpenBitFunTheme.muted))
                        .frame(width: 8, height: 8)
                }
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(device.online ? OpenBitFunTheme.ink : OpenBitFunTheme.muted)
                    .frame(width: 20, height: 24)
            }
            .padding(.leading, 8)
            .padding(.trailing, 4)
            .frame(height: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!device.online)
        .opacity(device.online ? 1 : 0.58)
        .accessibilityIdentifier("sidebar.device.\(device.id)")
        .accessibilityLabel(Text(device.name))
        .accessibilityValue(Text(current ? activeConnectionLabel : (device.online ? model.localized("在线") : model.localized("离线"))))
    }

    private func isCurrentDevice(_ device: MobileDeviceDirectoryEntry) -> Bool {
        device.id == (model.accountSelectedDeviceID ?? normalizedDeviceKey(model.remoteExpectedDeviceKey))
    }

    private var activeConnectionLabel: String {
        switch model.connectionPhase {
        case .connected: return model.localized("已连接")
        case .reconnecting: return model.localized("正在恢复连接")
        case .disconnected: return model.localized("已断开")
        }
    }

    private var activeConnectionColor: Color {
        switch model.connectionPhase {
        case .connected: return OpenBitFunTheme.statusSuccess
        case .reconnecting: return OpenBitFunTheme.muted
        case .disconnected: return OpenBitFunTheme.statusDanger
        }
    }

    private func selectDirectoryDevice(_ device: MobileDeviceDirectoryEntry) {
        guard device.online else { return }
        if device.expanded {
            model.toggleDeviceDirectory(device)
            return
        }
        if let selected = selectedDirectoryEntry, selected.id != device.id {
            model.toggleDeviceDirectory(selected)
        }
        model.toggleDeviceDirectory(device)
        guard let accountDevice = model.accountDevices.first(where: { $0.id == device.id }) else { return }
        model.selectRemoteDevice(accountDevice, preserveDrawer: true)
    }

    @ViewBuilder
    private func directoryDeviceBody(_ device: MobileDeviceDirectoryEntry) -> some View {
        if device.catalogSource == "RECENT" {
            Text(model.localized("旧版设备：显示最近访问的工作区"))
                .font(.system(size: 12))
                .foregroundStyle(OpenBitFunTheme.muted)
                .padding(.horizontal, 10)
        }
        if device.status == "LOADING" && device.workspaces.isEmpty && device.sessions.isEmpty {
            HStack(spacing: 8) { ProgressView().controlSize(.small); Text(model.localized("正在加载工作区")).font(.system(size: 13)).foregroundStyle(OpenBitFunTheme.muted) }
                .padding(.horizontal, 18).frame(height: 42)
        } else if device.status == "FAILED" {
            Button { model.retryDeviceDirectory(device) } label: {
                Text(model.localized("工作区加载失败，点按重试")).font(.system(size: 13)).foregroundStyle(OpenBitFunTheme.statusDanger)
                    .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading).padding(.leading, 18)
            }.buttonStyle(.plain)
        } else if device.status == "READY" && device.online && device.workspaces.isEmpty && device.sessions.isEmpty {
            Text(model.localized("这台电脑还没有工作区"))
                .font(.system(size: 13))
                .foregroundStyle(OpenBitFunTheme.muted)
                .padding(.horizontal, 18)
                .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
                .accessibilityIdentifier("sidebar.emptyWorkspaces")
        }
        let visibleWorkspaceCount = visibleDeviceWorkspaceCounts[device.id] ?? 3
        ForEach(device.workspaces.prefix(visibleWorkspaceCount)) { workspace in
            let scopedWorkspace = MobileWorkspaceGroup(
                path: workspace.path,
                name: workspace.name,
                selected: workspace.selected,
                sessions: workspace.sessions.map { session in
                    var scopedSession = session
                    scopedSession.deviceKey = device.id
                    return scopedSession
                },
                deviceKey: device.id,
                directoryExpanded: workspace.directoryExpanded,
                directoryStatus: workspace.directoryStatus,
                remoteConnectionId: workspace.remoteConnectionId,
                remoteSshHost: workspace.remoteSshHost
            )
            SidebarWorkspaceRow(
                workspace: scopedWorkspace,
                expanded: workspace.directoryExpanded,
                selectedSessionID: model.surface == .remote ? model.selectedSessionID : nil,
                metadata: { _ in nil },
                onToggle: {
                    model.setDirectoryWorkspaceExpanded(
                        device: device,
                        workspace: scopedWorkspace,
                        expanded: !workspace.directoryExpanded
                    )
                },
                onToggleCreate: {
                    workspaceCreateTarget = scopedWorkspace
                    workspaceCreatePath = scopedWorkspace.path + ":" + (scopedWorkspace.remoteConnectionId ?? "")
                },
                onOpenWorkspace: { model.selectDirectoryWorkspace(scopedWorkspace) },
                onOpenSession: { model.selectDirectorySession($0) }, onActions: { session in
                    if permanent { onPermanentActions?(session) } else { compactActionSession = session }
                },
                selectedDeviceKey: model.accountSelectedDeviceID,
                selectedWorkspacePath: model.workspaceCatalog.first(where: { $0.selected })?.path,
                directoryLoadStatus: workspace.directoryStatus,
                onRetryDirectoryLoad: {
                    model.retryDirectoryWorkspace(device: device, workspace: scopedWorkspace)
                },
                createMenu: directoryCreateMenu(device: device, workspace: scopedWorkspace)
            )
        }
        if device.workspaces.count > visibleWorkspaceCount {
            Button {
                visibleDeviceWorkspaceCounts[device.id] = min(
                    device.workspaces.count,
                    visibleWorkspaceCount + 3
                )
            } label: {
                Text(model.localizedFormat(
                    "还有 %lld 个工作区",
                    Int64(device.workspaces.count - visibleWorkspaceCount)
                ))
                    .font(.system(size: 13)).foregroundStyle(OpenBitFunTheme.muted).padding(.leading, 42).frame(height: 36, alignment: .leading)
            }.buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private var activeRemoteDeviceBody: some View {
        if model.workspaceLoading && model.remoteWorkspaces.isEmpty {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(model.localized("正在加载工作区"))
                        .font(.system(size: 13))
                        .foregroundStyle(OpenBitFunTheme.muted)
                }
                .padding(.horizontal, 10)
                .frame(height: 42)
        } else if model.workspaceLoadFailed && model.remoteWorkspaces.isEmpty {
                Button { model.retryRemoteWorkspaces() } label: {
                    Text(model.localized("工作区加载失败，点按重试"))
                        .font(.system(size: 13))
                        .foregroundStyle(OpenBitFunTheme.statusDanger)
                        .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
                        .padding(.horizontal, 10)
                }
                .buttonStyle(.plain)
        }

        if model.remoteConnected {
            remoteGroupedSessionSections(model.sessionListSections)
        }
        if model.remoteHasMore {
            Button { model.loadMoreRemoteSessions() } label: {
                Text(model.localized(model.busy ? "正在加载" : "加载更多会话"))
                    .font(.system(size: 13)).foregroundStyle(OpenBitFunTheme.muted)
                    .frame(maxWidth: .infinity, minHeight: 42)
            }
            .buttonStyle(.plain).disabled(model.busy)
        }
    }

    @ViewBuilder
    private func remoteGroupedSessionSections(
        _ sections: [MobileSessionListSectionProjection]
    ) -> some View {
        let visibleSessions = sections.flatMap(\.sessions)
        let chatSessions = sections.first(where: { $0.kind == .chat })?.sessions ?? []
        if visibleSessions.isEmpty && !model.workspaceLoading {
            Text(model.localized(hasActiveRemoteViewFilter ? "没有匹配的会话" : "暂无远程会话"))
                .font(.system(size: 13))
                .foregroundStyle(OpenBitFunTheme.muted)
                .padding(.horizontal, 10)
                .frame(height: 42, alignment: .leading)
        } else {
            switch model.remoteGroupMode {
            case "TIME":
                remoteTimeSections(sections)
            case "CHAT":
                if !chatSessions.isEmpty { remoteChatSection(chatSessions) }
                remoteProjectSections(sections)
            default:
                remoteProjectSections(sections)
                if !chatSessions.isEmpty { remoteChatSection(chatSessions) }
            }
        }
    }

    private func remoteProjectSections(
        _ sections: [MobileSessionListSectionProjection]
    ) -> some View {
        let workspaces = sections.flatMap { section -> [MobileWorkspaceGroup] in
            guard section.kind == .project else { return [] }
            let sources = model.remoteWorkspaces.filter { normalizedWorkspacePath($0.path) == normalizedWorkspacePath(section.path) }
            if sources.isEmpty { return [] }
            return sources.map { source in
                MobileWorkspaceGroup(path: source.path, name: source.name, selected: source.selected,
                    sessions: section.sessions, deviceKey: normalizedDeviceKey(model.remoteExpectedDeviceKey),
                    remoteConnectionId: source.remoteConnectionId, remoteSshHost: source.remoteSshHost)
            }
        }
        return ForEach(workspaces) { workspace in
            SidebarWorkspaceRow(
                workspace: workspace,
                expanded: expandedWorkspacePaths.contains(workspace.path) || workspace.selected,
                selectedSessionID: model.surface == .remote ? model.selectedSessionID : nil,
                metadata: remoteSessionMetadata,
                onToggle: {
                    if expandedWorkspacePaths.contains(workspace.path) {
                        expandedWorkspacePaths.remove(workspace.path)
                    } else {
                        expandedWorkspacePaths.insert(workspace.path)
                    }
                },
                onToggleCreate: {
                    if HarnessProfilePolicy.shared.supported(capabilities: model.remoteHostCapabilities) {
                        workspaceCreatePath = workspaceCreatePath == workspace.path + ":" + (workspace.remoteConnectionId ?? "") ? nil : workspace.path + ":" + (workspace.remoteConnectionId ?? "")
                    } else {
                        model.createRemoteSession(in: workspace, agentType: "code")
                    }
                },
                onOpenWorkspace: { model.selectRemoteWorkspace(workspace) },
                onOpenSession: { model.surface = .remote; model.select($0) },
                onActions: { session in
                    model.surface = .remote
                    if permanent { onPermanentActions?(session) }
                    else { compactActionSession = session }
                },
                selectedDeviceKey: normalizedDeviceKey(model.remoteExpectedDeviceKey),
                selectedWorkspacePath: model.workspaceCatalog.first(where: { $0.selected })?.path
            )
        }
    }

    private func remoteTimeSections(
        _ sections: [MobileSessionListSectionProjection]
    ) -> some View {
        let buckets = sections.compactMap { section -> RemoteTimeBucket? in
            switch section.kind {
            case .today: return RemoteTimeBucket(id: section.id, title: "sidebar.time.today", sessions: section.sessions)
            case .yesterday: return RemoteTimeBucket(id: section.id, title: "sidebar.time.yesterday", sessions: section.sessions)
            case .earlier: return RemoteTimeBucket(id: section.id, title: "sidebar.time.older", sessions: section.sessions)
            default: return nil
            }
        }
        return ForEach(buckets) { bucket in
            VStack(alignment: .leading, spacing: 0) {
                Text(model.localized(bucket.title))
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(OpenBitFunTheme.muted)
                    .padding(.top, 12)
                    .padding(.bottom, 4)
                ForEach(bucket.sessions) { session in
                    SidebarRecentRow(
                        model: model,
                        session: session,
                        selected: model.surface == .remote && session.id == model.selectedSessionID,
                        metadata: remoteSessionMetadata(session),
                        onOpen: { model.surface = .remote; model.select(session) },
                        onActions: {
                            model.surface = .remote
                            if permanent { onPermanentActions?(session) }
                            else { compactActionSession = session }
                        }
                    )
                }
            }
        }
    }

    private func remoteChatSection(_ sessions: [ChatSession]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button {
                    withAnimation(.easeOut(duration: 0.18)) { remoteChatsCollapsed.toggle() }
                } label: {
                    HStack(spacing: 8) {
                        Text(model.localized("连接桌面端"))
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(OpenBitFunTheme.muted)
                        Text(verbatim: "\(sessions.count)")
                            .font(.system(size: 12))
                            .foregroundStyle(OpenBitFunTheme.muted)
                        Image(systemName: remoteChatsCollapsed ? "chevron.right" : "chevron.down")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(OpenBitFunTheme.muted)
                    }
                }
                .buttonStyle(.plain)
                Spacer(minLength: 0)
                Button { model.createRemoteAssistantSession() } label: {
                    Image(systemName: "folder.badge.gearshape")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(OpenBitFunTheme.muted)
                        .frame(width: 40, height: 40)
                }
                .buttonStyle(.plain)
                .disabled(model.busy)
                .accessibilityLabel(Text(model.localized("新建远程会话")))
            }
            .frame(height: 44)

            if !remoteChatsCollapsed {
                ForEach(sessions.prefix(4)) { session in
                    SidebarRecentRow(
                        model: model,
                        session: session,
                        selected: model.surface == .remote && session.id == model.selectedSessionID,
                        metadata: remoteSessionMetadata(session),
                        onOpen: { model.surface = .remote; model.select(session) },
                        onActions: {
                            model.surface = .remote
                            if permanent { onPermanentActions?(session) }
                            else { compactActionSession = session }
                        }
                    )
                }
            }
        }
        .padding(.top, 8)
    }

    private func remoteIsAssistant(_ session: ChatSession) -> Bool {
        let agent = session.agentType.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if ["claw", "assistant", "chat"].contains(agent) { return true }
        let path = normalizedWorkspacePath(session.workspacePath)
        return !path.isEmpty && model.remoteAssistants.contains {
            normalizedWorkspacePath($0.path) == path
        }
    }

    private func remoteWorkspacePath(_ session: ChatSession) -> String {
        let own = normalizedWorkspacePath(session.workspacePath)
        if !own.isEmpty { return own }
        if remoteIsAssistant(session) { return "" }
        return normalizedWorkspacePath(model.remoteWorkspaces.first(where: \.selected)?.path)
    }

    private func normalizedWorkspacePath(_ path: String?) -> String {
        var result = (path ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        while result.count > 1 && (result.hasSuffix("/") || result.hasSuffix("\\")) {
            result.removeLast()
        }
        return result
    }

    private func remoteSessionMetadata(_ session: ChatSession) -> String? {
        var parts: [String] = []
        if model.remoteShowWorkspaceMetadata {
            let name = session.workspaceName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let path = remoteWorkspacePath(session)
            if !name.isEmpty { parts.append(name) }
            else if !path.isEmpty { parts.append(path) }
        }
        if model.remoteShowUpdatedMetadata, !session.updatedLabel.isEmpty {
            parts.append(relativeUpdatedLabel(session))
        }
        if model.remoteShowStatusMetadata, !session.status.isEmpty {
            parts.append(remoteStatusLabel(session.status))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func remoteStatusLabel(_ status: String) -> String {
        switch status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "active", "running": return model.localized("运行中")
        case "ready", "idle": return model.localized("就绪")
        case "archived": return model.localized("已归档")
        default: return status
        }
    }

    private func relativeUpdatedLabel(_ session: ChatSession) -> String {
        let date = remoteSessionDate(session)
        guard date != .distantPast else { return session.updatedLabel }
        if abs(date.timeIntervalSinceNow) < 60 { return model.localized("刚刚") }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: model.appLanguage.rawValue)
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private func remoteSessionDate(_ session: ChatSession) -> Date {
        parsedRemoteDate(session.updatedLabel) ?? parsedRemoteDate(session.createdAt) ?? .distantPast
    }

    private func parsedRemoteDate(_ value: String) -> Date? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let numeric = Double(trimmed) {
            return Date(timeIntervalSince1970: numeric > 10_000_000_000 ? numeric / 1_000 : numeric)
        }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: trimmed) { return date }
        return ISO8601DateFormatter().date(from: trimmed)
    }

    private func pairedDeviceRow(name: String) -> some View {
        Button { model.openRemoteSurface() } label: {
            HStack(spacing: 10) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 17, weight: .regular))
                    .frame(width: 22, height: 18)
                Text(name)
                    .font(.system(size: 15))
                    .foregroundStyle(OpenBitFunTheme.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Circle().fill(OpenBitFunTheme.statusSuccess).frame(width: 7, height: 7)
                Image(systemName: "chevron.down")
                    .font(.system(size: 12, weight: .regular))
                    .frame(width: 14, height: 14)
            }
            .padding(.horizontal, 10)
            .frame(height: 46)
        }
        .buttonStyle(.plain)
    }

    private func createWorkspaceSession(_ workspace: MobileWorkspaceGroup, agentType: String) {
        if workspace.deviceKey == nil || normalizedDeviceKey(workspace.deviceKey) == normalizedDeviceKey(model.remoteExpectedDeviceKey) {
            model.createRemoteSession(in: workspace, agentType: agentType)
        } else if let device = model.accountDevices.first(where: { normalizedDeviceKey($0.id) == normalizedDeviceKey(workspace.deviceKey) }) {
            pendingWorkspaceCreate = NativeWorkspaceCreateTarget(workspace: workspace, agentType: agentType)
            model.selectRemoteDevice(device, preserveDrawer: true)
        }
    }

    private func finishWorkspaceCreateWhenReady() {
        guard let target = pendingWorkspaceCreate,
              normalizedDeviceKey(target.workspace.deviceKey) == normalizedDeviceKey(model.remoteExpectedDeviceKey),
              model.remoteCreateInteraction.canSubmit,
              model.remoteWorkspaces.contains(where: { $0.path == target.workspace.path && $0.remoteConnectionId == target.workspace.remoteConnectionId }) else { return }
        pendingWorkspaceCreate = nil
        model.createRemoteSession(in: target.workspace, agentType: target.agentType)
    }

    private func directoryCreateMenu(device: MobileDeviceDirectoryEntry, workspace: MobileWorkspaceGroup) -> AnyView? {
        // Capabilities belong to the connected target, never another directory device.
        guard model.remoteExpectedDeviceKey == "account:\(device.id)",
              HarnessProfilePolicy.shared.supported(capabilities: model.remoteHostCapabilities) else { return nil }
        return AnyView(Menu {
            ForEach([HarnessProfile.minimal, .standard, .ultimate], id: \.name) { profile in
                Button {
                    model.openDirectoryRemoteDraft(device: device, workspace: workspace, agentType: profile.agentType)
                } label: {
                    HarnessProfileLabel(model: model, profile: profile)
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(OpenBitFunTheme.ink)
                .frame(width: 30, height: 40)
        })
    }

    private func workspaceCreateMenu(_ workspace: MobileWorkspaceGroup) -> some View {
        VStack(spacing: 0) {
            ForEach([HarnessProfile.minimal, .standard, .ultimate], id: \.name) { profile in
                Button {
                    workspaceCreatePath = nil
                    createWorkspaceSession(workspace, agentType: profile.agentType)
                } label: {
                    HarnessProfileLabel(model: model, profile: profile)
                        .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
                        .padding(.horizontal, 14)
                }.buttonStyle(.plain)
            }
        }
        .openBitFunCompactPopoverSurface()
    }

    private func workspaceCreateMenuRow(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(verbatim: title)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(OpenBitFunTheme.ink)
                .frame(maxWidth: .infinity, minHeight: MobileDesignGeometry.compactPopoverActionHeight, alignment: .leading)
                .padding(.horizontal, 18)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var footer: some View {
        Group {
            if !showsPrimaryNavigation {
                SignedOutConnectionActions(
                    scanTitle: model.localized("扫码连接"),
                    accountTitle: model.localized("使用邮箱或 GitHub 登录"),
                    onScan: model.scanRemote,
                    onOpenAccount: { model.accountSheetOpen = true; model.drawerOpen = false },
                    showScan: !model.remoteConnected
                )
            } else {
                authenticatedFooter
            }
        }
    }

    private var authenticatedFooter: some View {
        HStack(spacing: 0) {
            Button { model.openDeviceTools() } label: { deviceToolsLabel }
                .buttonStyle(.plain)
                .disabled(!model.remoteConnected)
                .accessibilityIdentifier("sidebar.deviceTools")
            Spacer(minLength: 0)
            Button { model.settingsOpen = true; model.drawerOpen = false } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 20, weight: .regular))
                    .frame(width: 24, height: 24)
                    .frame(width: 44, height: 44)
                    .background(OpenBitFunTheme.card)
                    .clipShape(Circle())
                    .shadow(color: OpenBitFunTheme.shadowSubtle, radius: 12, y: 4)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(model.localized("设置")))
        }
        .frame(height: 56)
        .padding(.leading, 12)
    }

    private var deviceToolsLabel: some View {
        HStack(spacing: 9) {
            Image(systemName: "folder.badge.gearshape")
                .font(.system(size: 19, weight: .regular))
                .frame(width: 24, height: 24)
            Text(model.localized("Device tools"))
                .font(.system(size: 15, weight: .medium))
                .lineLimit(1)
                .fixedSize()
        }
        .foregroundStyle(OpenBitFunTheme.ink)
        .frame(minWidth: 98, minHeight: 44)
        .background(OpenBitFunTheme.card)
        .overlay(Capsule().stroke(OpenBitFunTheme.line, lineWidth: 0.5))
        .clipShape(Capsule())
        .shadow(color: OpenBitFunTheme.shadowSubtle, radius: 12, y: 4)
        .opacity(model.remoteConnected && model.remoteCreateInteraction.canSubmit && !model.remoteCreateSubmitting ? 1 : 0.45)
    }
}

private struct RemoteTimeBucket: Identifiable {
    let id: String
    let title: String
    let sessions: [ChatSession]
}

private struct SidebarRecentRow: View {
    @ObservedObject var model: MobileAppModel
    let session: ChatSession
    let selected: Bool
    var metadata: String? = nil
    let onOpen: () -> Void
    let onActions: () -> Void
    var body: some View {
        HStack(spacing: 0) {
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.title)
                        .font(.system(size: 13, weight: selected ? .bold : .regular))
                        .foregroundStyle(OpenBitFunTheme.ink)
                        .lineLimit(1)
                    if let metadata, !metadata.isEmpty {
                        Text(metadata)
                            .font(MobileDesignTypography.labelSmall.font)
                            .foregroundStyle(OpenBitFunTheme.muted)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("sidebar.recentSession.\(session.id)")

            Button {
                onActions()
            } label: {
                HStack(spacing: 3) {
                    Circle().fill(OpenBitFunTheme.muted).frame(width: 3.5, height: 3.5)
                    Circle().fill(OpenBitFunTheme.muted).frame(width: 3.5, height: 3.5)
                    Circle().fill(OpenBitFunTheme.muted).frame(width: 3.5, height: 3.5)
                }
                .frame(width: 34, height: 40)
                .opacity(0.62)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(model.localized("会话操作")))
            .anchorPreference(
                key: SidebarSessionActionsAnchorKey.self,
                value: .bounds,
                transform: { [session.id: $0] }
            )
        }
        .padding(.leading, 12)
        .padding(.trailing, 4)
        .frame(minHeight: metadata == nil ? 44 : 56)
        .background(selected ? OpenBitFunTheme.soft : OpenBitFunTheme.transparent)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

private struct SidebarWorkspaceRow: View {
    let workspace: MobileWorkspaceGroup
    let expanded: Bool
    let selectedSessionID: String?
    let metadata: (ChatSession) -> String?
    let onToggle: () -> Void
    let onToggleCreate: () -> Void
    let onOpenWorkspace: () -> Void
    let onOpenSession: (ChatSession) -> Void
    let onActions: (ChatSession) -> Void
    var selectedDeviceKey: String? = nil
    var selectedWorkspacePath: String? = nil
    var directoryLoadStatus = "READY"
    var onRetryDirectoryLoad: (() -> Void)? = nil
    var createMenu: AnyView? = nil
    @State private var visibleSessionCount = 3

    private func isSelected(_ session: ChatSession) -> Bool {
        guard selectedSessionID == session.id,
              normalizedDeviceKey(selectedDeviceKey) == normalizedDeviceKey(workspace.deviceKey) else { return false }
        func normalized(_ path: String?) -> String {
            var value = (path ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            while value.count > 1 && value.hasSuffix("/") { value.removeLast() }
            return value
        }
        return normalized(selectedWorkspacePath) == normalized(workspace.path)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Button(action: onToggle) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .frame(width: 14, height: 14)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .opacity(0.62)
                    .frame(width: 24, height: 46)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(
                    MobileLocalization.text(expanded ? "收起工作区" : "展开工作区")
                )
                .accessibilityIdentifier("sidebar.workspaceDisclosure.\(workspace.deviceKey ?? "unknown").\(workspace.path)")

                Button(action: onToggle) {
                    HStack(spacing: 10) {
                        Image(systemName: "folder")
                            .font(.system(size: 18, weight: .regular))
                            .frame(width: 24, height: 20)
                        Text(workspace.name)
                            .font(.system(size: 15, weight: workspace.selected ? .medium : .regular))
                            .foregroundStyle(OpenBitFunTheme.ink)
                            .lineLimit(1)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .simultaneousGesture(LongPressGesture().onEnded { _ in onOpenWorkspace() })
                .accessibilityIdentifier("sidebar.workspace.\(workspace.deviceKey ?? "unknown").\(workspace.path)")
                .accessibilityValue(Text(workspace.path))
                Spacer(minLength: 0)
                Group {
                    if let createMenu { createMenu }
                    else {
                        Button(action: onToggleCreate) {
                            Image(systemName: "plus")
                                .font(.system(size: 17, weight: .regular))
                                .foregroundStyle(OpenBitFunTheme.ink)
                                .frame(width: 30, height: 40)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(MobileLocalization.text("Workspace actions"))
                .accessibilityIdentifier("sidebar.newSession.\(workspace.deviceKey ?? "unknown").\(workspace.path)")
                .anchorPreference(
                    key: SidebarWorkspaceCreateAnchorKey.self,
                    value: .bounds,
                    transform: { [workspace.path + ":" + (workspace.remoteConnectionId ?? ""): $0] }
                )
            }
            .padding(.leading, 6)
            .padding(.trailing, 6)
            .frame(height: 46)
            .clipShape(RoundedRectangle(cornerRadius: 10))

            if expanded {
                if directoryLoadStatus == "LOADING" {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(MobileLocalization.text("正在加载"))
                            .font(.system(size: 13))
                            .foregroundStyle(OpenBitFunTheme.muted)
                    }
                    .padding(.leading, 42)
                    .frame(height: 40, alignment: .leading)
                } else if directoryLoadStatus == "FAILED" {
                    Button(action: { onRetryDirectoryLoad?() }) {
                        HStack(spacing: 8) {
                            Text(MobileLocalization.text("这台电脑暂时无法读取"))
                                .foregroundStyle(OpenBitFunTheme.muted)
                            Spacer(minLength: 0)
                            Text(MobileLocalization.text("重试"))
                                .foregroundStyle(OpenBitFunTheme.ink)
                        }
                        .font(.system(size: 13))
                        .padding(.leading, 42)
                        .padding(.trailing, 10)
                        .frame(height: 40)
                    }
                    .buttonStyle(.plain)
                } else if workspace.sessions.isEmpty && directoryLoadStatus == "READY" {
                    Text(MobileLocalization.text("此工作区暂无会话"))
                        .font(.system(size: 13))
                        .foregroundStyle(OpenBitFunTheme.muted)
                        .padding(.leading, 42)
                        .frame(height: 38, alignment: .leading)
                }
                ForEach(workspace.sessions.prefix(visibleSessionCount)) { session in
                    HStack(spacing: 0) {
                        Button { onOpenSession(session) } label: {
                            HStack(spacing: 10) {
                            Image(systemName: "doc")
                                .font(.system(size: 17, weight: .regular))
                                .foregroundStyle(OpenBitFunTheme.muted)
                                .frame(width: 19, height: 19)
                                .overlay(alignment: .bottomLeading) {
                                    if ["running", "active", "in_progress"].contains(session.status.lowercased()) {
                                        Circle().fill(OpenBitFunTheme.statusSuccess).frame(width: 7, height: 7)
                                    }
                                }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(session.title)
                                    .font(.system(
                                        size: 13,
                                        weight: isSelected(session) ? .bold : .regular
                                    ))
                                    .foregroundStyle(OpenBitFunTheme.ink)
                                    .lineLimit(1)
                                if let detail = metadata(session), !detail.isEmpty {
                                    Text(detail)
                                        .font(MobileDesignTypography.labelSmall.font)
                                        .foregroundStyle(OpenBitFunTheme.muted)
                                        .lineLimit(1)
                                }
                            }
                            Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("sidebar.session.\(workspace.deviceKey ?? session.deviceKey ?? "unknown").\(session.id)")
                        .accessibilityAddTraits(isSelected(session) ? .isSelected : [])
                        Button { onActions(session) } label: {
                            Image(systemName: "ellipsis")
                                .font(.system(size: 13, weight: .medium)).foregroundStyle(OpenBitFunTheme.muted)
                                .frame(width: 36, height: 40)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(MobileLocalization.text("会话操作"))
                        .anchorPreference(
                            key: SidebarSessionActionsAnchorKey.self,
                            value: .bounds,
                            transform: { [session.id: $0] }
                        )
                    }
                    .padding(.leading, 44)
                    .padding(.trailing, 4)
                    .frame(minHeight: metadata(session) == nil ? 44 : 56)
                    .background(isSelected(session) ? OpenBitFunTheme.soft : OpenBitFunTheme.transparent)
                    .clipShape(RoundedRectangle(cornerRadius: 9))
                }
                if workspace.sessions.count > visibleSessionCount {
                    Button {
                        visibleSessionCount = min(workspace.sessions.count, visibleSessionCount + 3)
                    } label: {
                        Text(
                            MobileLocalization.format(
                                "还有 %lld 个会话",
                                language: MobileLocalization.restoredLanguage(),
                                Int64(workspace.sessions.count - visibleSessionCount)
                            )
                        )
                        .font(.system(size: 13))
                        .foregroundStyle(OpenBitFunTheme.muted)
                        .padding(.leading, 42)
                        .frame(height: 36, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.bottom, 6)
    }
}

private struct SidebarWorkspacePickerSheet: View {
    let device: MobileDeviceDirectoryEntry
    let onClose: () -> Void
    let onSelect: (MobileWorkspaceGroup) -> Void

    private var workspaces: [MobileWorkspaceGroup] { device.recentWorkspaces ?? device.workspaces }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(MobileLocalization.text("选择工作区"))
                        .font(MobileDesignTypography.headlineMedium.font.weight(.bold))
                        .foregroundStyle(OpenBitFunTheme.ink)
                        .lineLimit(1)
                    Text(device.name)
                        .font(MobileDesignTypography.bodySmall.font)
                        .foregroundStyle(OpenBitFunTheme.muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 17, weight: .regular))
                        .foregroundStyle(OpenBitFunTheme.muted)
                        .frame(width: 40, height: 40)
                        .background(OpenBitFunTheme.soft)
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(MobileLocalization.text("关闭")))
            }
            .frame(height: 66)

            Divider().overlay(OpenBitFunTheme.line)

            if device.status == "LOADING" && workspaces.isEmpty {
                VStack(spacing: 12) {
                    ProgressView().controlSize(.regular)
                    Text(MobileLocalization.text("正在加载"))
                        .font(MobileDesignTypography.bodyMedium.font)
                        .foregroundStyle(OpenBitFunTheme.muted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if workspaces.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "folder")
                        .font(.system(size: 30, weight: .regular))
                        .foregroundStyle(OpenBitFunTheme.muted)
                    Text(MobileLocalization.text("这台电脑还没有工作区"))
                        .font(MobileDesignTypography.bodyMedium.font)
                        .foregroundStyle(OpenBitFunTheme.muted)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView(showsIndicators: false) {
                    LazyVStack(spacing: 4) {
                        ForEach(workspaces) { workspace in
                            Button { onSelect(workspace) } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "folder")
                                        .font(.system(size: 20, weight: .regular))
                                        .foregroundStyle(OpenBitFunTheme.ink)
                                        .frame(width: 34, height: 34)
                                        .background(OpenBitFunTheme.card)
                                        .clipShape(RoundedRectangle(cornerRadius: 10))
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(workspace.name)
                                            .font(MobileDesignTypography.bodyLarge.font.weight(workspace.selected ? .medium : .regular))
                                            .foregroundStyle(OpenBitFunTheme.ink)
                                            .lineLimit(1)
                                        Text(workspace.path)
                                            .font(MobileDesignTypography.labelSmall.font)
                                            .foregroundStyle(OpenBitFunTheme.muted)
                                            .lineLimit(1)
                                    }
                                    Spacer(minLength: 8)
                                    Image(systemName: workspace.selected ? "checkmark" : "chevron.right")
                                        .font(.system(size: workspace.selected ? 17 : 15, weight: .regular))
                                        .foregroundStyle(workspace.selected ? OpenBitFunTheme.ink : OpenBitFunTheme.muted)
                                        .frame(width: 40, height: 40)
                                }
                                .padding(.leading, 10)
                                .padding(.trailing, 8)
                                .frame(height: 68)
                                .background(workspace.selected ? OpenBitFunTheme.soft : OpenBitFunTheme.page)
                                .clipShape(RoundedRectangle(cornerRadius: 14))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.top, 10)
                    .padding(.bottom, 18)
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 10)
        .background(OpenBitFunTheme.page)
    }
}

private struct NativeDeviceToolTarget: Identifiable {
    let id = UUID()
    let location: NativeDeviceToolLocation
    let terminal: Bool
    let deviceKey: String?
}

private struct NativeWorkspaceCreateTarget {
    let workspace: MobileWorkspaceGroup
    let agentType: String
}

private struct NativeDeviceToolLocation {
    let name: String
    let path: String
    let connectionId: String?
}
