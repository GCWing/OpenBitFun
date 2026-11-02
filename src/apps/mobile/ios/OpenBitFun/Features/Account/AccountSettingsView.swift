import OpenBitFunMobileCore
import SwiftUI

/// Account entry presented from welcome, sidebar and launch previews. Signing
/// in stays its own step; once signed in the account lives inline in
/// Settings, so this surface lands on the settings page rather than a
/// standalone profile page.
struct AccountSettingsView: View {
    @ObservedObject var model: MobileAppModel
    var onClose: (() -> Void)? = nil

    var body: some View {
        AccountLoginView(model: model, onClose: close)
            .onAppear(perform: landOnSettingsIfSignedIn)
            .onChange(of: model.accountUser) { _ in landOnSettingsIfSignedIn() }
            .onChange(of: model.accountFailureStage) { _ in landOnSettingsIfSignedIn() }
    }

    /// Signed-in account details live in Settings; once the login step is no
    /// longer needed this sheet hands over instead of showing a profile page.
    private func landOnSettingsIfSignedIn() {
        guard !AccountLoginView.isNeeded(model) else { return }
        close()
        model.settingsOpen = true
    }

    private func close() {
        if let onClose { onClose() } else { model.accountSheetOpen = false }
    }
}

/// Sign-in step and the post-login device-list retry. Hosted by the account
/// sheet and, as an in-place step, by both settings pages.
struct AccountLoginView: View {
    @ObservedObject var model: MobileAppModel
    let onClose: () -> Void
    @ScaledMetric(relativeTo: .title2) private var loginTitleSize = MobileDesignTypography.displayMedium.size
    @ScaledMetric(relativeTo: .body) private var loginBodySize = MobileDesignTypography.bodyMedium.size
    @ScaledMetric(relativeTo: .caption) private var loginErrorSize = MobileDesignTypography.bodySmall.size

    static func isNeeded(_ model: MobileAppModel) -> Bool {
        model.accountUser == nil || isDeviceListRetry(model)
    }

    private static func isDeviceListRetry(_ model: MobileAppModel) -> Bool {
        model.accountFailureStage == "DEVICE_LIST" && model.accountFailureCanRetry
    }

    var body: some View {
        Group {
            if Self.isDeviceListRetry(model) {
                deviceListRetryPage
            } else {
                loginPage
            }
        }
        .frame(maxWidth: .infinity, maxHeight: model.accountUser == nil && model.accountFailureStage != "DEVICE_LIST" ? nil : .infinity)
        .background(OpenBitFunTheme.page)
        .onAppear { model.accountLoginSurfaces += 1 }
        .onDisappear { model.accountLoginSurfaces = max(0, model.accountLoginSurfaces - 1) }
    }

    private var loginPage: some View {
        VStack(spacing: 0) {
            ConnectionSheetHeader(onClose: onClose, uniformGlyph: true)

            VStack(spacing: 0) {
                Text(model.localized("使用邮箱或 GitHub 登录"))
                    .font(.system(size: loginTitleSize, weight: .bold))
                    .padding(.vertical, MobileDesignTypography.displayMedium.lineSpacing / 2)
                    .foregroundStyle(OpenBitFunTheme.ink)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                Text(model.localized("使用邮箱或 GitHub 登录并连接自己的电脑。\n任务和模型配置保留在被控电脑上。"))
                    .font(.system(size: loginBodySize))
                    .padding(.vertical, MobileDesignTypography.bodyMedium.lineSpacing / 2)
                    .foregroundStyle(OpenBitFunTheme.muted)
                    .lineSpacing(MobileDesignTypography.bodyMedium.lineSpacing)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)

                if let error = model.coreErrorMessage, !error.isEmpty {
                    Text(error)
                        .font(.system(size: loginErrorSize))
                        .padding(.vertical, MobileDesignTypography.bodySmall.lineSpacing / 2)
                        .foregroundStyle(OpenBitFunTheme.statusDanger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                        .padding(.top, 12)
                }
            }
            .frame(maxWidth: 520)
            .padding(.horizontal, MobileDesignGeometry.sheetHorizontalPadding)
            .frame(maxWidth: .infinity)
            .frame(minHeight: MobileDesignGeometry.loginSheetBodyMinHeight, alignment: .top)

            ConnectionSheetFooter(
                label: model.localized(model.accountAuthorizationURL != nil ? "打开 OpenBitFun 授权"
                    : model.accountBusy ? "正在登录" : "使用邮箱或 GitHub 登录"),
                elevated: false, primary: true, enabled: canLogin, onAction: model.loginAccount
            )
            .accessibilityIdentifier("account.login")
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var deviceListRetryPage: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { onClose() } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 19, weight: .medium))
                    .foregroundStyle(OpenBitFunTheme.ink)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.localized("返回"))

            Spacer()
            Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                .font(.system(size: 48, weight: .medium))
                .foregroundStyle(OpenBitFunTheme.muted)
                .frame(maxWidth: .infinity)
            Text(model.localized("无法加载设备列表"))
                .font(.system(size: 26, weight: .bold))
                .foregroundStyle(OpenBitFunTheme.ink)
                .frame(maxWidth: .infinity)
                .padding(.top, 20)
            Text(model.coreErrorMessage ?? model.localized("登录已完成，但设备列表加载失败。请重试。"))
                .font(.system(size: 15))
                .foregroundStyle(OpenBitFunTheme.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.top, 10)

            Button { model.retryAccountFailure() } label: {
                HStack(spacing: 8) {
                    if model.accountBusy { ProgressView().tint(OpenBitFunTheme.contentOnAction) }
                    Text(model.localized(model.accountBusy ? "正在重试" : "重试加载设备"))
                }
                .font(.system(size: 17, weight: .bold))
                .foregroundStyle(OpenBitFunTheme.contentOnAction)
                .frame(maxWidth: .infinity, minHeight: 56)
                .background(OpenBitFunTheme.accent)
                .clipShape(RoundedRectangle(cornerRadius: 18))
            }
            .buttonStyle(.plain)
            .disabled(model.accountBusy)
            .padding(.top, 30)

            Button(model.localized("使用其他账号重新登录")) {
                model.logoutAccount()
            }
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(OpenBitFunTheme.ink)
            .frame(maxWidth: .infinity, minHeight: 48)
            .buttonStyle(.plain)
            .disabled(model.accountBusy)
            .padding(.top, 8)
            Spacer()
        }
        .padding(.horizontal, 28)
        .padding(.top, 22)
        .padding(.bottom, 44)
    }

    private var canLogin: Bool {
        !model.accountBusy || model.accountAuthorizationURL != nil
    }
}

/// Compact identity card shared by the settings pages (Harmony
/// `AccountProfilePanel.CompactIdentityCard`). Signed out, the card is the
/// inline sign-in entry.
struct AccountIdentityCard: View {
    @ObservedObject var model: MobileAppModel
    let onSignIn: () -> Void

    private var signedIn: Bool { model.accountUser != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            AccountSectionTitle(title: "账号")
            Button {
                if !signedIn { onSignIn() }
            } label: {
                HStack(spacing: 14) {
                    AccountAvatar(url: signedIn ? model.accountAvatarURL : nil)
                        .frame(width: 46, height: 46)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.localized(signedIn ? "当前账号" : "当前身份"))
                            .font(MobileDesignTypography.bodySmall.font)
                            .foregroundStyle(OpenBitFunTheme.muted)
                        Text(signedIn ? (model.accountUser ?? "") : model.localized("未登录"))
                            .font(MobileDesignTypography.bodyLarge.font.weight(.medium))
                            .foregroundStyle(OpenBitFunTheme.ink)
                            .lineLimit(1)
                        if signedIn {
                            Text("\(model.localized("用户 ID")) \(accountIdentifier)")
                                .font(MobileDesignTypography.bodySmall.font)
                                .foregroundStyle(OpenBitFunTheme.muted)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    Spacer(minLength: 8)
                    if signedIn {
                        Text(model.localized("已登录"))
                            .font(MobileDesignTypography.bodySmall.font.weight(.medium))
                            .foregroundStyle(OpenBitFunTheme.statusSuccess)
                    } else {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(OpenBitFunTheme.muted.opacity(0.72))
                    }
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, minHeight: 72)
                .background(OpenBitFunTheme.card)
                .clipShape(RoundedRectangle(cornerRadius: MobileDesignGeometry.settingsCardRadius))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .allowsHitTesting(!signedIn)
            .accessibilityIdentifier(signedIn ? "settings.account" : "settings.account.login")
        }
        .padding(.bottom, 24)
    }

    private var accountIdentifier: String {
        model.accountUserID?.isEmpty == false ? model.accountUserID! : (model.accountUser ?? "-")
    }
}

/// Account device list with selection, shared by the settings pages and kept
/// in step with Harmony `AccountProfilePanel.DeviceManagementSection`.
struct AccountDevicesSection: View {
    @ObservedObject var model: MobileAppModel

    private var desktopDevices: [MobileAccountDevice] { model.accountDevices }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                AccountSectionTitle(title: "设备")
                Spacer(minLength: 0)
                Button(action: model.refreshRemoteDevices) {
                    Group {
                        if model.accountRefreshing {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 17, weight: .regular))
                        }
                    }
                    .foregroundStyle(OpenBitFunTheme.ink)
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(model.accountUser == nil || model.accountRefreshing)
                .opacity(model.accountUser == nil || model.accountRefreshing ? 0.55 : 1)
                .accessibilityLabel(model.localized("刷新"))
            }
            .padding(.trailing, 4)
            .frame(minHeight: 44)

            VStack(spacing: 4) {
                if model.accountUser == nil {
                    emptyMessage("登录云账号后可查看该账号下的所有设备。")
                } else if model.accountRefreshing && desktopDevices.isEmpty {
                    emptyMessage("正在加载设备…")
                } else if desktopDevices.isEmpty {
                    emptyMessage("账号下还没有其他已注册设备。")
                } else {
                    ForEach(desktopDevices) { device in
                        Button {
                            guard device.online, !isControlling(device) else { return }
                            model.selectRemoteDevice(device)
                        } label: {
                            SettingsDeviceRow(device: device, connected: isControlling(device))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(8)
            .background(OpenBitFunTheme.card)
            .clipShape(RoundedRectangle(cornerRadius: MobileDesignGeometry.settingsCardRadius))
        }
        .padding(.bottom, 24)
    }

    private func isControlling(_ device: MobileAccountDevice) -> Bool {
        device.selected && model.connectionPhase == .connected
    }

    private func emptyMessage(_ text: String) -> some View {
        Text(model.localized(text))
            .font(MobileDesignTypography.bodySmall.font)
            .foregroundStyle(OpenBitFunTheme.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
    }
}

/// Sign-out action placed at the end of a settings page.
struct AccountLogoutButton: View {
    @ObservedObject var model: MobileAppModel

    var body: some View {
        Button(role: .destructive) {
            model.logoutAccount()
        } label: {
            HStack(spacing: 14) {
                Image(systemName: "rectangle.portrait.and.arrow.right")
                    .font(.system(size: 20, weight: .regular))
                    .frame(width: 24, height: 24)
                Text(model.localized("退出账号"))
                    .font(MobileDesignTypography.bodyLarge.font.weight(.medium))
                Spacer(minLength: 0)
            }
            .foregroundStyle(OpenBitFunTheme.statusDanger)
            .padding(.horizontal, 20)
            .frame(minHeight: 62)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.accountBusy)
        .overlay(alignment: .top) {
            Divider().overlay(OpenBitFunTheme.line).padding(.horizontal, 8)
        }
        .accessibilityIdentifier("settings.account.logout")
    }
}

struct AccountSectionTitle: View {
    let title: String

    var body: some View {
        Text(MobileLocalization.text(title))
            .font(MobileDesignTypography.bodySmall.font.weight(.medium))
            .foregroundStyle(OpenBitFunTheme.muted)
            .padding(.leading, 8)
            .padding(.bottom, 2)
    }
}

struct SettingsDeviceRow: View {
    let device: MobileAccountDevice
    let connected: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "desktopcomputer")
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(connected ? OpenBitFunTheme.ink : OpenBitFunTheme.muted)
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(device.name.isEmpty ? device.id : device.name)
                    .font(MobileDesignTypography.titleSmall.font.weight(.medium))
                    .foregroundStyle(OpenBitFunTheme.ink)
                    .lineLimit(1)
                Text(deviceStatus)
                    .font(MobileDesignTypography.bodySmall.font)
                    .foregroundStyle(device.online ? OpenBitFunTheme.statusSuccess : OpenBitFunTheme.muted)
            }
            Spacer(minLength: 8)
            if device.online && !connected {
                Text(MobileLocalization.text("连接"))
                    .font(MobileDesignTypography.bodyMedium.font)
                    .foregroundStyle(OpenBitFunTheme.ink)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(OpenBitFunTheme.soft)
                    .clipShape(Capsule())
            }
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 62)
        .background(connected ? OpenBitFunTheme.soft : OpenBitFunTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: MobileDesignGeometry.settingsCompactCardRadius))
        .opacity(device.online ? 1 : 0.48)
        .contentShape(Rectangle())
    }

    private var deviceStatus: String {
        let presence = MobileLocalization.text(device.online ? "在线" : "离线")
        if connected { return "\(MobileLocalization.text("当前控制")) · \(presence)" }
        if device.selected { return "\(MobileLocalization.text("上次连接")) · \(presence)" }
        return presence
    }
}

struct AccountAvatar: View {
    let url: String?
    var body: some View {
        AsyncImage(url: url.flatMap { value in
            guard let candidate = URL(string: value), candidate.scheme == "https",
                  candidate.host == "avatars.githubusercontent.com" else { return nil }
            return candidate
        }) { image in
            image.resizable().scaledToFill()
        } placeholder: {
            ZStack {
                Circle().fill(OpenBitFunTheme.soft)
                Image(systemName: "person.fill").foregroundStyle(OpenBitFunTheme.ink)
            }
        }.clipShape(Circle()).accessibilityHidden(true)
    }
}
