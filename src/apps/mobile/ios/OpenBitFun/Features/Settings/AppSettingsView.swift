import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: MobileAppModel
    var onClose: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    /// Sign-in stays its own step; the signed-in account is inline below.
    @State private var loginOpen = false

    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"
    }

    private var selectedModelName: String {
        (model.modelOptions.first(where: \.selected) ?? model.modelOptions.first).map {
            $0.roleLabelKey.map(model.localized) ?? $0.primaryLabel
        }
            ?? model.localized("未配置")
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(spacing: 0) {
                OpenBitFunModalHeader(title: "设置", onClose: { if let onClose { onClose() } else { dismiss() } })
                    .padding(.horizontal, MobileDesignGeometry.sheetHorizontalPadding)
                Divider().overlay(OpenBitFunTheme.line)

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 0) {
                        AccountIdentityCard(model: model, onSignIn: { loginOpen = true })

                        if showsCurrentConnection {
                            currentConnectionSection
                        }

                        RemotePermissionSection(model: model)

                        SettingsGroup(title: "通用") {
                            Button { model.languagePickerOpen = true } label: {
                                SettingsValueRow(
                                    icon: "textformat",
                                    title: "语言",
                                    value: model.appLanguage.nativeName,
                                    showsChevron: true
                                ).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                        SettingsGroup(title: "通知") {
                            Button {
                                Task { await TaskCompletionNotifier.manageNotifications() }
                            } label: {
                                SettingsValueRow(
                                    icon: "bell",
                                    title: "任务完成通知",
                                    value: "",
                                    showsChevron: true
                                )
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("settings.notifications")
                        }
                        AccountDevicesSection(model: model)
                        SettingsGroup(title: "关于") {
                            VStack(spacing: 0) {
                                SettingsValueRow(
                                    icon: nil,
                                    title: "产品",
                                    value: "OpenBitFun iOS版"
                                )
                                Divider().overlay(OpenBitFunTheme.line).padding(.horizontal, 26)
                                SettingsValueRow(icon: nil, title: "版本", value: appVersion)
                            }
                        }
                        if model.accountUser != nil {
                            AccountLogoutButton(model: model)
                        }
                    }
                    .padding(.horizontal, MobileDesignGeometry.sheetHorizontalPadding)
                    .padding(.top, 22)
                    .padding(.bottom, 34)
                    .id(model.appLanguage)
                }
            }

            if model.languagePickerOpen {
                LanguagePickerSheet(model: model)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            } else if loginOpen {
                AccountLoginView(model: model, onClose: { loginOpen = false })
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .background(OpenBitFunTheme.page)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .background(OpenBitFunTheme.page)
        .animation(.easeInOut(duration: 0.2), value: model.languagePickerOpen)
        .animation(.easeInOut(duration: 0.2), value: loginOpen)
        .onAppear {
            if model.remoteConnected { model.refreshRemotePermissionMode() }
        }
        .onChange(of: model.accountUser) { _ in closeLoginWhenDone() }
        .onChange(of: model.accountFailureStage) { _ in closeLoginWhenDone() }
    }

    private func closeLoginWhenDone() {
        if loginOpen && !AccountLoginView.isNeeded(model) { loginOpen = false }
    }

    private var showsCurrentConnection: Bool {
        model.remoteConnected || model.accountDeviceName != nil
    }

    private var currentConnectionSection: some View {
        SettingsGroup(title: "当前远程控制") {
            VStack(spacing: 0) {
                HStack(spacing: 14) {
                    Image(systemName: "desktopcomputer")
                        .font(.system(size: 20, weight: .regular))
                        .foregroundStyle(OpenBitFunTheme.muted)
                        .frame(width: 28, height: 28)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(
                            model.accountDeviceName

                                ?? model.localized("尚未连接桌面端")
                        )
                        .font(MobileDesignTypography.bodyLarge.font.weight(.medium))
                        .foregroundStyle(OpenBitFunTheme.ink)
                        .lineLimit(1)
                        Text(connectionDetail)
                            .font(MobileDesignTypography.bodySmall.font)
                            .foregroundStyle(OpenBitFunTheme.muted)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 18)
                .frame(minHeight: 68)

                Divider().overlay(OpenBitFunTheme.line).padding(.horizontal, 18)

                HStack(spacing: 8) {
                    Text(model.localized(model.accountDeviceName == nil ? "扫码配对" : "账号设备"))
                        .font(MobileDesignTypography.bodySmall.font)
                        .foregroundStyle(OpenBitFunTheme.muted)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(OpenBitFunTheme.soft)
                        .clipShape(Capsule())
                    Spacer(minLength: 0)
                    // Same rule as Android and HarmonyOS: one action, leave a link
                    // that is up or coming up, re-bind once it is down.
                    if model.connectionPhase == .disconnected {
                        Button(model.localized("重新连接"), action: model.reconnectRemote)
                            .font(MobileDesignTypography.bodyMedium.font.weight(.medium))
                            .foregroundStyle(OpenBitFunTheme.ink)
                            .buttonStyle(.plain)
                    } else {
                        Button(model.localized("断开"), action: model.disconnectRemote)
                            .font(MobileDesignTypography.bodyMedium.font.weight(.medium))
                            .foregroundStyle(OpenBitFunTheme.statusDanger)
                            .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 18)
                .frame(minHeight: 54)
            }
        }
    }

    private var connectionDetail: String {
        switch model.connectionPhase {
        case .connected: model.localized("已连接")
        case .reconnecting: model.localized("正在重连")
        case .disconnected: model.localized("连接已断开")
        }
    }
}

private struct LanguagePickerSheet: View {
    @ObservedObject var model: MobileAppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            OpenBitFunSelectionHeader(title: "选择语言", onClose: { model.languagePickerOpen = false })
            Divider().overlay(OpenBitFunTheme.line)

            VStack(spacing: 0) {
                ForEach(MobileLanguage.allCases) { language in
                    Button {
                        model.setLanguage(language)
                        model.languagePickerOpen = false
                    } label: {
                        HStack {
                            Text(language.nativeName)
                                .font(.system(size: 16, weight: .medium))
                                .foregroundStyle(OpenBitFunTheme.ink)
                            Spacer()
                            if model.appLanguage == language {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 18, weight: .medium))
                                    .foregroundStyle(OpenBitFunTheme.ink)
                            }
                        }
                        .padding(.horizontal, 16)
                        .frame(height: MobileDesignGeometry.selectionRowHeight)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 8)
            .padding(.bottom, 28)

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(OpenBitFunTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: MobileDesignGeometry.selectionTopRadius))
    }
}
private struct SettingsGroup<Content: View, Accessory: View>: View {
    let title: String
    @ViewBuilder let accessory: () -> Accessory
    @ViewBuilder let content: () -> Content

    init(
        title: String,
        @ViewBuilder accessory: @escaping () -> Accessory,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.accessory = accessory
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(MobileLocalization.text(title))
                    .font(MobileDesignTypography.bodySmall.font.weight(.medium))
                    .foregroundStyle(OpenBitFunTheme.muted)
                Spacer(minLength: 0)
                accessory()
            }
            .padding(.leading, 8)
            // A trailing action ends on the card's inner edge (row padding 18).
            .padding(.trailing, 18)
            .padding(.bottom, 2)
            SettingsCard(content: content)
        }
        .padding(.bottom, 24)
    }
}

extension SettingsGroup where Accessory == EmptyView {
    init(title: String, @ViewBuilder content: @escaping () -> Content) {
        self.init(title: title, accessory: { EmptyView() }, content: content)
    }
}

/// Remote permission mode for the controlled desktop (`set_permission_mode`).
/// Labels mirror the desktop's permission-mode copy. Always visible so the
/// setting is discoverable; without a live connection the rows are disabled
/// and the connection-required hint explains why.
private struct RemotePermissionSection: View {
    @ObservedObject var model: MobileAppModel
    @State private var confirmingFullAccess = false

    private var loading: Bool { model.remoteConnected && !model.remotePermissionModeLoaded }
    private var editable: Bool { model.remoteConnected && !model.busy && !loading }

    private var hint: String {
        if !model.remoteConnected { return "连接桌面后可修改权限模式。" }
        if loading && model.remotePermissionFailure != "LOAD" { return "正在读取桌面权限设置…" }
        return "此设置会同步到当前桌面，并应用于所有新的工具调用。"
    }

    private var failureText: String? {
        guard model.remoteConnected else { return nil }
        switch model.remotePermissionFailure {
        case "LOAD": return "权限设置读取失败，请重试。"
        case "SAVE": return "权限模式保存失败，请重试。"
        default: return nil
        }
    }

    var body: some View {
        SettingsGroup(title: "权限模式", accessory: {
            if model.remoteConnected {
                Button(model.localized("刷新")) { model.refreshRemotePermissionMode() }
                    .font(MobileDesignTypography.bodyMedium.font.weight(.medium))
                    .foregroundStyle(OpenBitFunTheme.ink)
                    .buttonStyle(.plain)
                    .disabled(model.busy)
            }
        }) {
            VStack(alignment: .leading, spacing: 0) {
                Text(model.localized(hint))
                    .font(MobileDesignTypography.bodySmall.font)
                    .foregroundStyle(OpenBitFunTheme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 4)
                    .accessibilityIdentifier("settings.permission.hint")
                permissionRow("ASK", title: "需要确认", detail: "高风险操作会等待你确认。")
                Divider().overlay(OpenBitFunTheme.line).padding(.horizontal, 18)
                permissionRow("AUTO", title: "自动批准", detail: "原本需要确认的操作会自动通过。")
                Divider().overlay(OpenBitFunTheme.line).padding(.horizontal, 18)
                permissionRow("FULL_ACCESS", title: "完全访问", detail: "允许所有工具操作，不再请求确认。")

                if let failureText {
                    Text(model.localized(failureText))
                        .font(.system(size: 12)).foregroundStyle(OpenBitFunTheme.statusDanger)
                        .padding(.horizontal, 18).padding(.bottom, 10)
                        .accessibilityIdentifier("settings.permission.failure")
                }

                if confirmingFullAccess && model.remoteConnected {
                    fullAccessConfirmation
                }
            }
        }
        .onChange(of: model.remoteConnected) { connected in
            if !connected { confirmingFullAccess = false }
        }
    }

    private var fullAccessConfirmation: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(model.localized("确认开启完全访问？"))
                .font(.system(size: 15, weight: .bold)).foregroundStyle(OpenBitFunTheme.statusDanger)
            Text(model.localized("开启后，桌面端工具可以直接执行命令和修改文件。"))
                .font(.system(size: 13)).foregroundStyle(OpenBitFunTheme.ink).lineSpacing(4)
            HStack(spacing: 10) {
                confirmationButton("取消", destructive: false) { confirmingFullAccess = false }
                confirmationButton("开启完全访问", destructive: true) {
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
                    if model.remoteConnected && !loading && model.remotePermissionMode == mode {
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
            .opacity(editable ? 1 : 0.54)
        }
        .buttonStyle(.plain)
        .disabled(!editable)
        .accessibilityIdentifier("settings.permission.\(mode)")
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
}

struct SettingsCard<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        OpenBitFunModalCard(
            radius: MobileDesignGeometry.settingsCardRadius,
            bordered: false,
            content: content
        )
    }
}

private struct SettingsValueRow: View {
    let icon: String?
    let title: String
    let value: String
    var showsChevron: Bool = false

    var body: some View {
        HStack(spacing: 14) {
            if let icon {
                if icon == "textformat" {
                    Text("Aa")
                        .font(.system(size: 18, weight: .regular))
                        .foregroundStyle(OpenBitFunTheme.muted)
                        .frame(width: 23, height: 23)
                } else {
                    Image(systemName: icon)
                        .font(.system(size: 20, weight: .regular))
                        .foregroundStyle(OpenBitFunTheme.muted)
                        .frame(width: 23, height: 23)
                }
            }
            Text(MobileLocalization.text(title))
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(OpenBitFunTheme.ink)
            Spacer(minLength: 12)
            Text(MobileLocalization.text(value))
                .font(.system(size: 15))
                .foregroundStyle(OpenBitFunTheme.muted)
                .lineLimit(1)
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(OpenBitFunTheme.muted.opacity(0.72))
            }
        }
        .padding(.horizontal, 18)
        .frame(minHeight: 56)
    }
}
