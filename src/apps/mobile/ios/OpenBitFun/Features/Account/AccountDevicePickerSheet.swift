import OpenBitFunMobileCore
import SwiftUI

/// Account device picker. Native apps connect a desktop only through the
/// signed-in account's device list; the desktop QR code opens mobile web.
struct AccountDevicePickerSheet: View {
    @ObservedObject var model: MobileAppModel
    @Environment(\.dismiss) private var dismiss
    @State private var switchingDeviceID: String?

    var body: some View {
        accountDevicePage
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(OpenBitFunTheme.card)
            .onAppear {
                if model.accountUser != nil { model.refreshRemoteDevices() }
            }
            .onChange(of: model.accountUser) { user in
                if user == nil { dismiss() }
            }
            .onChange(of: model.accountSelectedDeviceID) { selectedDeviceID in
                guard selectedDeviceID == switchingDeviceID else { return }
                switchingDeviceID = nil
                dismiss()
            }
            .onChange(of: model.coreErrorMessage) { error in
                if error != nil { switchingDeviceID = nil }
            }
    }

    private var accountDevicePage: some View {
        VStack(spacing: 0) {
            HStack(spacing: 16) {
                Button { dismiss() } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(OpenBitFunTheme.ink)
                        .frame(width: 48, height: 48)
                        .background(OpenBitFunTheme.card)
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(model.localized("返回"))

                VStack(alignment: .leading, spacing: 4) {
                    Text(model.localized("选择桌面设备"))
                        .font(MobileDesignTypography.headlineLarge.font)
                        .foregroundStyle(OpenBitFunTheme.ink)
                    Text(model.localized("远程"))
                        .font(MobileDesignTypography.bodySmall.font)
                        .foregroundStyle(OpenBitFunTheme.muted)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 28)
            .padding(.top, 18)
            .frame(height: 92, alignment: .top)

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 18) {
                    Text(model.localized("选择一台在线桌面继续工作。"))
                        .font(MobileDesignTypography.bodyMedium.font)
                        .foregroundStyle(OpenBitFunTheme.muted)
                        .lineSpacing(MobileDesignTypography.bodyMedium.lineSpacing)

                    accountDeviceList
                }
                .frame(maxWidth: 520)
                .padding(.horizontal, 28)
                .padding(.top, 10)
                .padding(.bottom, 34)
                .frame(maxWidth: .infinity)
            }
        }
        .background(OpenBitFunTheme.page)
    }

    private var accountDeviceList: some View {
        VStack(spacing: 4) {
            HStack {
                Text(model.localized("账号设备"))
                    .font(MobileDesignTypography.bodyLarge.font.weight(.bold))
                    .foregroundStyle(OpenBitFunTheme.ink)
                Spacer(minLength: 0)
                Button(action: model.refreshRemoteDevices) {
                    Text(model.localized(model.accountRefreshing ? "正在加载" : "刷新"))
                        .font(MobileDesignTypography.bodyMedium.font)
                        .foregroundStyle(model.accountRefreshing ? OpenBitFunTheme.muted : OpenBitFunTheme.accent)
                        .frame(minWidth: 44, minHeight: 38, alignment: .trailing)
                }
                .buttonStyle(.plain)
                .disabled(model.accountRefreshing)
            }
            .frame(height: 38)

            Group {
                if model.accountRefreshing && accountDesktopDevices.isEmpty {
                    VStack(spacing: 0) {
                        accountDeviceSkeleton
                        accountDeviceSkeleton
                    }
                } else if accountDesktopDevices.isEmpty {
                    Text(model.localized("暂无可连接的桌面设备"))
                        .font(MobileDesignTypography.bodyMedium.font)
                        .foregroundStyle(OpenBitFunTheme.muted)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                } else {
                    ScrollView(showsIndicators: false) {
                        VStack(spacing: 0) {
                            ForEach(accountDesktopDevices) { device in
                                accountDeviceRow(device)
                            }
                        }
                    }
                }
            }
            .frame(height: 120)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(height: 174)
        .background(OpenBitFunTheme.card)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(OpenBitFunTheme.line, lineWidth: 1))
    }

    private var accountDesktopDevices: [MobileAccountDevice] {
        model.accountDevices.filter { model.localDeviceID.isEmpty || $0.id != model.localDeviceID }
    }

    private var accountDeviceSkeleton: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 5).fill(OpenBitFunTheme.soft).frame(width: 26, height: 22)
            VStack(alignment: .leading, spacing: 7) {
                RoundedRectangle(cornerRadius: 4).fill(OpenBitFunTheme.soft).frame(width: 142, height: 12)
                RoundedRectangle(cornerRadius: 4).fill(OpenBitFunTheme.soft).frame(width: 52, height: 9)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
        .frame(height: 60)
    }

    private func accountDeviceRow(_ device: MobileAccountDevice) -> some View {
        Button {
            guard device.online, switchingDeviceID == nil else { return }
            switchingDeviceID = device.id
            model.selectRemoteDevice(device)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 22, weight: .regular))
                    .foregroundStyle(OpenBitFunTheme.muted.opacity(device.online ? 0.68 : 0.38))
                    .frame(width: 26, height: 24)
                VStack(alignment: .leading, spacing: 3) {
                    Text(device.name.isEmpty ? device.id : device.name)
                        .font(MobileDesignTypography.titleSmall.font)
                        .foregroundStyle(OpenBitFunTheme.ink)
                        .lineLimit(1)
                    Text(accountDeviceStatus(device))
                        .font(MobileDesignTypography.bodySmall.font)
                        .foregroundStyle(device.online ? OpenBitFunTheme.statusSuccess : OpenBitFunTheme.muted)
                }
                Spacer(minLength: 0)
                if device.online && !(device.selected && model.connectionPhase == .connected) {
                    Text(model.localized(switchingDeviceID == device.id ? "正在连接" : "连接"))
                        .font(MobileDesignTypography.bodyMedium.font)
                        .foregroundStyle(OpenBitFunTheme.ink)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(OpenBitFunTheme.soft)
                        .clipShape(Capsule())
                } else if device.online {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(OpenBitFunTheme.muted.opacity(0.44))
                }
            }
            .padding(.horizontal, 4)
            .frame(height: 60)
            .contentShape(Rectangle())
            .opacity(device.online ? 1 : 0.64)
        }
        .buttonStyle(.plain)
        .disabled(!device.online || switchingDeviceID != nil)
    }

    private func accountDeviceStatus(_ device: MobileAccountDevice) -> String {
        if switchingDeviceID == device.id { return model.localized("正在连接") }
        let presence = model.localized(device.online ? "在线" : "离线")
        if device.selected && model.connectionPhase == .connected {
            return "\(model.localized("当前控制")) · \(presence)"
        }
        if device.selected { return "\(model.localized("上次连接")) · \(presence)" }
        return presence
    }
}
