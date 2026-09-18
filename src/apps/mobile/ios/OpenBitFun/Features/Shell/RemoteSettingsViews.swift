import SwiftUI

struct RemoteViewSettingsView: View {
    @ObservedObject var model: MobileAppModel

    private var statuses: [String] {
        model.sessionListStatusOptions
    }

    private var workspaces: [MobileSessionWorkspaceOption] {
        model.sessionListWorkspaceOptions
    }

    private var agentGroups: [String] {
        model.sessionListAgentGroups
    }

    var body: some View {
        VStack(spacing: 0) {
            OpenBitFunModalHeader(
                title: "视图设置",
                subtitle: "调整会话列表的分组和信息密度",
                onClose: { model.remoteViewSettingsOpen = false }
            )
            .padding(.horizontal, 20)
            Divider().overlay(OpenBitFunTheme.line)

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    sectionTitle("分组方式")
                    choiceRow("按项目", value: "PROJECT", selected: model.remoteGroupMode)
                    choiceRow("按时间倒序排列", value: "TIME", selected: model.remoteGroupMode)
                    choiceRow("聊天优先", value: "CHAT", selected: model.remoteGroupMode)

                    sectionTitle("筛选")
                    filterLabel("工作区")
                    filterRow(
                        "所有工作区",
                        selected: model.remoteWorkspaceFilter.isEmpty,
                        action: { model.remoteWorkspaceFilter = "" }
                    )
                    ForEach(workspaces) { workspace in
                        // The filter is the option key (`workspaceId ?: legacy triple`); a filter
                        // persisted as a bare path before IDs existed still matches by path.
                        filterRow(
                            workspace.name,
                            selected: model.remoteWorkspaceFilter == workspace.key ||
                                normalizedPath(model.remoteWorkspaceFilter) == normalizedPath(workspace.path),
                            action: { model.remoteWorkspaceFilter = workspace.key }
                        )
                    }

                    filterLabel("智能体类型")
                    filterRow(
                        "所有智能体类型",
                        selected: model.remoteViewAgentFilter.isEmpty,
                        action: { model.remoteViewAgentFilter = "" }
                    )
                    ForEach(agentGroups, id: \.self) { group in
                        filterRow(
                            agentLabel(group),
                            selected: model.remoteViewAgentFilter == group,
                            action: { model.remoteViewAgentFilter = group }
                        )
                    }

                    filterLabel("状态")
                    filterRow(
                        "所有状态",
                        selected: model.remoteStatusFilter.isEmpty,
                        action: { model.remoteStatusFilter = "" }
                    )
                    ForEach(statuses, id: \.self) { status in
                        filterRow(
                            statusLabel(status),
                            selected: model.remoteStatusFilter == status,
                            action: { model.remoteStatusFilter = status }
                        )
                    }

                    sectionTitle("显示信息")
                    metadataToggle("工作区", isOn: $model.remoteShowWorkspaceMetadata)
                    metadataToggle("更新时间", isOn: $model.remoteShowUpdatedMetadata)
                    metadataToggle("状态", isOn: $model.remoteShowStatusMetadata)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 34)
            }
        }
        .background(OpenBitFunTheme.page)
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(model.localized(title))
            .font(MobileDesignTypography.labelSmall.font.weight(.medium))
            .foregroundStyle(OpenBitFunTheme.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 4)
            .padding(.top, 12)
            .frame(height: 38, alignment: .topLeading)
    }

    private func filterLabel(_ title: String) -> some View {
        Text(model.localized(title))
            .font(MobileDesignTypography.labelSmall.font)
            .foregroundStyle(OpenBitFunTheme.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 10)
            .padding(.top, 10)
            .frame(height: 34, alignment: .topLeading)
    }

    private func choiceRow(_ title: String, value: String, selected: String) -> some View {
        filterRow(title, selected: value == selected) { model.remoteGroupMode = value }
    }

    private func filterRow(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(selected ? OpenBitFunTheme.ink : OpenBitFunTheme.muted)
                    .frame(width: 22)
                Text(model.localized(title))
                    .font(MobileDesignTypography.titleSmall.font)
                    .foregroundStyle(OpenBitFunTheme.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(height: 46)
            .frame(maxWidth: .infinity)
            .background(selected ? OpenBitFunTheme.card : OpenBitFunTheme.transparent)
            .overlay(alignment: .bottom) {
                Rectangle().fill(OpenBitFunTheme.line).frame(height: 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
    }

    private func metadataToggle(_ title: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            Text(model.localized(title))
                .font(MobileDesignTypography.titleSmall.font)
                .foregroundStyle(OpenBitFunTheme.ink)
        }
        .tint(OpenBitFunTheme.ink)
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .frame(height: 52)
        .overlay(alignment: .bottom) {
            Rectangle().fill(OpenBitFunTheme.line).frame(height: 1)
        }
    }

    private func agentLabel(_ group: String) -> String {
        switch group {
        case "CHAT": return "聊天"
        case "COWORK": return "Cowork"
        default: return "Code"
        }
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "active", "running": return "运行中"
        case "ready", "idle": return "就绪"
        case "archived": return "已归档"
        default: return status
        }
    }

    private func normalizedPath(_ path: String) -> String {
        var result = path.trimmingCharacters(in: .whitespacesAndNewlines)
        while result.count > 1 && (result.hasSuffix("/") || result.hasSuffix("\\")) {
            result.removeLast()
        }
        return result
    }
}

/// The desktop-wide control page mirrors HarmonyOS' RemoteControlSettingsSheet.
/// Account navigation and full-access confirmation stay inside this adaptive
/// modal so a settings action never creates a second sheet or scrim.
struct RemoteControlSettingsView: View {
    private enum Page { case control, account }

    @ObservedObject var model: MobileAppModel
    @State private var page: Page = .control
    @State private var confirmingFullAccess = false

    var body: some View {
        Group {
            if page == .account {
                AccountSettingsView(model: model, onClose: { page = .control })
            } else {
                controlPage
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(OpenBitFunTheme.page)
        .animation(.easeInOut(duration: 0.2), value: page)
        .onAppear {
            if model.remoteConnected { model.refreshRemotePermissionMode() }
        }
    }

    private var controlPage: some View {
        VStack(spacing: 0) {
            OpenBitFunModalHeader(
                title: "远程控制",
                onClose: { model.remoteControlSettingsOpen = false }
            )
            .padding(.horizontal, MobileDesignGeometry.sheetHorizontalPadding)
            Divider().overlay(OpenBitFunTheme.line)

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    Button { page = .account } label: {
                        remoteCard(radius: 28) {
                            HStack(spacing: 12) {
                                Image(systemName: "person.crop.circle")
                                    .font(.system(size: 28, weight: .regular))
                                    .foregroundStyle(OpenBitFunTheme.muted)
                                    .frame(width: 34, height: 34)
                                Text(model.localized(model.accountUser == nil ? "使用邮箱或 GitHub 登录" : "个人资料"))
                                    .font(.system(size: 18, weight: .medium))
                                    .foregroundStyle(OpenBitFunTheme.ink)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(OpenBitFunTheme.muted.opacity(0.72))
                            }
                            .padding(.horizontal, 18)
                            .frame(height: 64)
                        }
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 28)

                    remoteSectionTitle("当前远程控制")
                    currentControlCard

                    VStack(alignment: .leading, spacing: 10) {
                        remoteSectionTitle("其他连接方式")
                        Button {
                            model.remoteControlSettingsOpen = false
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) {
                                model.connectRemote()
                            }
                        } label: {
                            remoteCard(radius: 24) {
                                HStack(spacing: 12) {
                                    Image(systemName: "link")
                                        .font(.system(size: 20, weight: .regular))
                                        .foregroundStyle(OpenBitFunTheme.muted)
                                        .frame(width: 24, height: 24)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(model.localized("扫描二维码连接"))
                                            .font(.system(size: 16, weight: .medium))
                                            .foregroundStyle(OpenBitFunTheme.ink)
                                        Text(model.localized("适用于临时配对或未登录账号的桌面端。"))
                                            .font(.system(size: 13))
                                            .foregroundStyle(OpenBitFunTheme.muted)
                                            .lineLimit(2)
                                    }
                                    Spacer(minLength: 8)
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 14, weight: .medium))
                                        .foregroundStyle(OpenBitFunTheme.muted.opacity(0.72))
                                }
                                .padding(.horizontal, 18)
                                .frame(minHeight: 78)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.top, 16)
                    .padding(.bottom, 8)

                    permissionSection
                }
                .padding(.horizontal, MobileDesignGeometry.sheetHorizontalPadding)
                .padding(.top, 22)
                .padding(.bottom, 42)
            }
        }
    }

    private var currentControlCard: some View {
        remoteCard(radius: 28) {
            HStack(spacing: 14) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 23, weight: .regular))
                    .foregroundStyle(OpenBitFunTheme.muted)
                    .frame(width: 40, height: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.localized("OpenBitFun 桌面版"))
                        .font(.system(size: 14)).foregroundStyle(OpenBitFunTheme.muted)
                    Text(model.accountDeviceName ?? model.localized("尚未连接桌面端"))
                        .font(.system(size: 18, weight: .medium)).foregroundStyle(OpenBitFunTheme.ink)
                        .lineLimit(1)
                    Text(connectionStatus)
                        .font(.system(size: 14)).foregroundStyle(OpenBitFunTheme.muted)
                }
                Spacer(minLength: 6)
                if model.remoteConnected {
                    remoteChip("断开", action: model.disconnectRemote)
                } else if model.connectionPhase == .disconnected {
                    remoteChip("重新连接", action: model.verifyRemoteConnection)
                }
            }
            .padding(.horizontal, 18)
            .frame(minHeight: 92)

            Divider().overlay(OpenBitFunTheme.line).padding(.horizontal, 18)

            HStack(spacing: 10) {
                Image(systemName: "link")
                    .font(.system(size: 18)).foregroundStyle(OpenBitFunTheme.muted)
                    .frame(width: 20, height: 20)
                Text(model.localized("连接来源"))
                    .font(.system(size: 14)).foregroundStyle(OpenBitFunTheme.muted)
                Spacer()
                Text(connectionSource)
                    .font(.system(size: 13)).foregroundStyle(OpenBitFunTheme.ink)
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(OpenBitFunTheme.soft).clipShape(Capsule())
            }
            .padding(.horizontal, 18)
            .frame(height: 52)
        }
    }

    private var permissionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                remoteSectionTitle("远程权限")
                Spacer()
                if model.remoteConnected {
                    Button(model.localized("刷新")) { model.refreshRemotePermissionMode() }
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(OpenBitFunTheme.ink)
                        .buttonStyle(.plain)
                        .disabled(model.busy)
                }
            }
            remoteCard(radius: 28) {
                Text(model.localized("控制桌面端执行工具时采用的确认方式。"))
                    .font(.system(size: 13)).foregroundStyle(OpenBitFunTheme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 4)
                permissionRow("ASK", title: "每次询问", detail: "执行需要授权的操作前先询问。")
                Divider().overlay(OpenBitFunTheme.line).padding(.horizontal, 18)
                permissionRow("AUTO", title: "自动允许", detail: "自动允许常规操作，高风险操作仍会询问。")
                Divider().overlay(OpenBitFunTheme.line).padding(.horizontal, 18)
                permissionRow("FULL_ACCESS", title: "完全访问", detail: "不再询问，允许桌面端执行所有操作。")

                if let failure = model.remotePermissionFailure, !failure.isEmpty {
                    Text(failure)
                        .font(.system(size: 12)).foregroundStyle(OpenBitFunTheme.statusDanger)
                        .padding(.horizontal, 18).padding(.bottom, 10)
                }

                if confirmingFullAccess {
                    fullAccessConfirmation
                }
            }
        }
    }

    private var fullAccessConfirmation: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(model.localized("确认完全访问"))
                .font(.system(size: 15, weight: .bold)).foregroundStyle(OpenBitFunTheme.statusDanger)
            Text(model.localized("完全访问会取消所有操作确认。仅在你信任当前桌面端时启用。"))
                .font(.system(size: 13)).foregroundStyle(OpenBitFunTheme.ink).lineSpacing(4)
            HStack(spacing: 10) {
                confirmationButton("取消", destructive: false) { confirmingFullAccess = false }
                confirmationButton("启用完全访问", destructive: true) {
                    model.setRemotePermissionMode("FULL_ACCESS")
                    confirmingFullAccess = false
                }
            }
        }
        .padding(16)
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(OpenBitFunTheme.statusDanger, lineWidth: 1))
        .padding(.horizontal, 12).padding(.bottom, 14)
    }

    private func permissionRow(_ mode: String, title: String, detail: String) -> some View {
        Button {
            if mode == "FULL_ACCESS" { confirmingFullAccess = true }
            else {
                confirmingFullAccess = false
                model.setRemotePermissionMode(mode)
            }
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    if model.remotePermissionMode == mode {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 20)).foregroundStyle(OpenBitFunTheme.ink)
                    }
                }
                .frame(width: 22, height: 24)
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.localized(title))
                        .font(.system(size: 16, weight: .medium)).foregroundStyle(OpenBitFunTheme.ink)
                    Text(model.localized(detail))
                        .font(.system(size: 12)).foregroundStyle(OpenBitFunTheme.muted)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 18)
            .frame(minHeight: 72)
            .contentShape(Rectangle())
            .opacity(model.remoteConnected && !model.busy ? 1 : 0.54)
        }
        .buttonStyle(.plain)
        .disabled(!model.remoteConnected || model.busy)
    }

    private func remoteSectionTitle(_ title: String) -> some View {
        Text(model.localized(title))
            .font(MobileDesignTypography.titleSmall.font)
            .foregroundStyle(OpenBitFunTheme.muted)
            .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
            .padding(.horizontal, 18)
    }

    private func remoteCard<Content: View>(
        radius: CGFloat,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        OpenBitFunModalCard(radius: radius, bordered: false, content: content)
    }

    private func remoteChip(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(model.localized(title))
                .font(.system(size: 14)).foregroundStyle(OpenBitFunTheme.ink)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(OpenBitFunTheme.soft).clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func confirmationButton(
        _ title: String,
        destructive: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(model.localized(title))
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(destructive ? OpenBitFunTheme.contentOnAction : OpenBitFunTheme.ink)
                .frame(maxWidth: .infinity, minHeight: 42)
                .background(destructive ? OpenBitFunTheme.statusDanger : OpenBitFunTheme.soft)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private var connectionStatus: String {
        switch model.connectionPhase {
        case .connected: model.localized(model.remoteConnected ? "已连接" : "未连接")
        case .reconnecting: model.localized("正在重新连接")
        case .disconnected: model.localized("连接已断开")
        }
    }

    private var connectionSource: String {
        if model.accountSelectedDeviceID != nil { return model.localized("账号设备") }
        if model.remoteConnected { return model.localized("扫码配对") }
        return model.localized("未连接")
    }
}
