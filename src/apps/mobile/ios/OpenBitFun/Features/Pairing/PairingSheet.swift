import OpenBitFunMobileCore
import SwiftUI

struct PairingSheet: View {
    private enum Step { case intro, account, scan }

    @ObservedObject var model: MobileAppModel
    @Environment(\.dismiss) private var dismiss
    @State private var step: Step = .intro
    @State private var pairingURL = MobileLaunchConfiguration.pairingAccountPreview
        ? "https://remote.openbitfun.com/v/1.0.2/#/pair?did=preview-device"
        : ""
    @State private var manualOpen = false
    @State private var scanError: String?
    @State private var switchingDeviceID: String?
    @FocusState private var focused: Bool

    var body: some View {
        return ZStack {
            switch step {
            case .intro: introPage
            case .account: accountDevicePage
            case .scan: scanPage
            }
            if manualOpen { manualPairingOverlay }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(OpenBitFunTheme.card)
        .onAppear {
            if model.pairingScanRequested {
                step = .scan
                model.consumePairingScanRequest()
            } else if MobileLaunchConfiguration.pairingManualPreview ||
                MobileLaunchConfiguration.pairingAccountPreview {
                step = .scan
                manualOpen = true
                focused = !MobileLaunchConfiguration.pairingAccountPreview
            } else if model.accountUser != nil {
                step = .account
                model.refreshRemoteDevices()
            }
        }
        .onChange(of: model.accountSelectedDeviceID) { selectedDeviceID in
            guard step == .account, selectedDeviceID == switchingDeviceID else { return }
            switchingDeviceID = nil
            dismiss()
        }
        .onChange(of: model.coreErrorMessage) { error in
            if step == .account, error != nil { switchingDeviceID = nil }
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

                    Button {
                        scanError = nil
                        step = .scan
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "link")
                                .font(.system(size: 20, weight: .regular))
                                .foregroundStyle(OpenBitFunTheme.muted.opacity(0.66))
                                .frame(width: 22, height: 22)
                            Text(model.localized("扫描二维码连接"))
                                .font(MobileDesignTypography.bodyLarge.font.weight(.medium))
                                .foregroundStyle(OpenBitFunTheme.ink)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(OpenBitFunTheme.muted.opacity(0.44))
                        }
                        .padding(.horizontal, 16)
                        .frame(height: 58)
                        .background(OpenBitFunTheme.card)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(OpenBitFunTheme.line, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
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

    private var introPage: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 0) {
                hero(height: 250)
                VStack(spacing: 18) {
                    ZStack(alignment: .topLeading) {
                        RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(OpenBitFunTheme.ink, lineWidth: 5)
                            .frame(width: 58, height: 39).offset(x: 5)
                        Rectangle().strokeBorder(OpenBitFunTheme.ink, lineWidth: 5)
                            .frame(width: 26, height: 13).offset(x: 21, y: 38)
                    }
                    .frame(width: 68, height: 55)
                    Text(model.localized("连接电脑"))
                        .font(MobileDesignTypography.displayLarge.font)
                        .foregroundStyle(OpenBitFunTheme.ink)
                    SignedOutConnectionActions(
                        scanTitle: model.localized("扫码连接电脑"),
                        accountTitle: model.localized("使用邮箱或 GitHub 登录"),
                        onScan: { scanError = nil; step = .scan },
                        onOpenAccount: model.openAccountFromPairing,
                        primaryScan: true,
                        enabled: !model.pairingBusy,
                        buttonHeight: 58,
                        spacing: 18,
                        fontSize: 16
                    )
                    .frame(maxWidth: 520)
                    .padding(.horizontal, 36)
                }
                .offset(y: -24)
            }
            .padding(.bottom, 28)
        }
    }

    private var scanPage: some View {
        VStack(spacing: 0) {
            ConnectionSheetHeader(onClose: { dismiss() })

            GeometryReader { geometry in
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 0) {
                        Text(model.localized("扫描桌面端二维码"))
                            .font(MobileDesignTypography.displayMedium.font)
                            .padding(.vertical, MobileDesignTypography.displayMedium.lineSpacing / 2)
                            .foregroundStyle(OpenBitFunTheme.ink)
                            .multilineTextAlignment(.center)
                        Text(model.localized("在 OpenBitFun 桌面端点击「连接移动端」\n扫描二维码完成连接"))
                            .font(MobileDesignTypography.bodyMedium.font)
                            .padding(.vertical, MobileDesignTypography.bodyMedium.lineSpacing / 2)
                            .foregroundStyle(OpenBitFunTheme.muted)
                            .lineSpacing(MobileDesignTypography.bodyMedium.lineSpacing)
                            .multilineTextAlignment(.center)
                            .padding(.top, 8)
                            .padding(.bottom, 24)

                        inlineScanner
                        HStack(spacing: 8) {
                            Circle().fill(OpenBitFunTheme.muted).frame(width: 8, height: 8)
                            Text(model.localized("扫描二维码或粘贴远程连接链接后会显示桌面端连接状态。"))
                                .font(MobileDesignTypography.bodySmall.font)
                            .padding(.vertical, MobileDesignTypography.bodySmall.lineSpacing / 2)
                                .foregroundStyle(OpenBitFunTheme.muted)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 12)
                        .frame(maxWidth: .infinity, minHeight: 30)
                        .background(OpenBitFunTheme.soft)
                        .clipShape(Capsule())
                        .padding(.top, 18)

                        if let error = scanError ?? model.pairingError {
                            Text(error)
                                .font(MobileDesignTypography.bodySmall.font)
                            .padding(.vertical, MobileDesignTypography.bodySmall.lineSpacing / 2)
                                .foregroundStyle(scanError == nil
                                    ? OpenBitFunTheme.statusDanger
                                    : OpenBitFunTheme.muted)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 12)
                                .frame(maxWidth: .infinity)
                                .background(OpenBitFunTheme.soft)
                                .clipShape(RoundedRectangle(cornerRadius: 16))
                                .padding(.top, 14)
                        }
                    }
                    .frame(maxWidth: 520)
                    .padding(.horizontal, MobileDesignGeometry.sheetHorizontalPadding)
                    .frame(maxWidth: .infinity, minHeight: geometry.size.height, alignment: .center)
                }
            }
            .padding(.bottom, 18)

            ConnectionSheetFooter(label: model.localized("改为手动配对")) {
                manualOpen = true
                focused = true
            }
        }
        .background(OpenBitFunTheme.page)
        .ignoresSafeArea(.container, edges: .bottom)
    }

    private var inlineScanner: some View {
        ZStack {
            QRCodeScannerView(
                paused: manualOpen,
                showsCloseButton: false,
                onCode: handleScannedCode,
                onCancel: {},
                onPermissionDenied: {
                    scanError = model.localized(
                        "需要相机权限才能扫码，请在系统设置中允许 OpenBitFun 访问相机，或改为手动配对。"
                    )
                },
                onUnavailable: {
                    scanError = model.localized(
                        "无法打开相机，请检查权限后重试，或改为手动配对。"
                    )
                }
            )
            .frame(width: 248, height: 248)

            MobileDesignColors.shadowMedium
            Canvas { context, size in
                for right in [false, true] {
                    for bottom in [false, true] {
                        let x = right ? size.width - 20 - 56 : 20
                        let y = bottom ? size.height - 20 - 56 : 20
                        let horizontal = CGRect(x: x + (right ? 20 : 0), y: y + (bottom ? 52 : 0), width: 36, height: 4)
                        let vertical = CGRect(x: x + (right ? 52 : 0), y: y + (bottom ? 20 : 0), width: 4, height: 36)
                        context.fill(Path(roundedRect: horizontal, cornerRadius: 2), with: .color(MobileDesignColors.connectScanAccent))
                        context.fill(Path(roundedRect: vertical, cornerRadius: 2), with: .color(MobileDesignColors.connectScanAccent))
                    }
                }
            }
        }
        .frame(width: 248, height: 248)
        .background(OpenBitFunTheme.page)
        .clipShape(RoundedRectangle(cornerRadius: 28))
        .overlay(RoundedRectangle(cornerRadius: 28).stroke(OpenBitFunTheme.line, lineWidth: 1))
    }

    private func handleScannedCode(_ code: String) {
        pairingURL = code
        scanError = nil
        model.submitPairing(url: code)
    }

    private func hero(height: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 36).fill(MobileDesignColors.connectHeroBg)
                .frame(height: 282)
            RoundedRectangle(cornerRadius: 72).fill(MobileDesignColors.connectHeroSurface.opacity(0.7))
                .frame(width: 260, height: 142).offset(x: 112, y: 26)
            RoundedRectangle(cornerRadius: 68).fill(MobileDesignColors.connectHeroAccent.opacity(0.42))
                .frame(width: 188, height: 134).offset(x: -42, y: 198)
            RoundedRectangle(cornerRadius: 64).fill(MobileDesignColors.connectHeroSecondary.opacity(0.54))
                .frame(width: 188, height: 126).offset(x: 258)
            Button {
                if step == .scan {
                    step = model.accountUser == nil ? .intro : .account
                } else {
                    dismiss()
                }
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(OpenBitFunTheme.ink)
                    .frame(width: 44, height: 44)
                    .background(OpenBitFunTheme.card)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .padding(.top, 18).padding(.leading, 18)
        }
        .frame(height: height)
    }

    private var manualPairingOverlay: some View {
        let canSubmit = !model.pairingBusy &&
            !pairingURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

        return ZStack {
            OpenBitFunTheme.scrim
                .ignoresSafeArea()
                .onTapGesture {
                    if !model.pairingBusy {
                        manualOpen = false
                    }
                }
            VStack(alignment: .leading, spacing: 20) {
                Text(model.localized("手动输入配对码"))
                    .font(.system(size: 24, weight: .bold)).foregroundStyle(OpenBitFunTheme.ink)
                Text(model.localized("输入桌面端显示的配对链接或代码。"))
                    .font(.system(size: 17)).foregroundStyle(OpenBitFunTheme.muted).lineSpacing(5)
                TextField(model.localized("配对码或连接链接"), text: $pairingURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .lineLimit(1)
                    .font(.system(size: 20)).foregroundStyle(OpenBitFunTheme.ink)
                    .padding(.horizontal, 20).frame(minHeight: 62)
                    .background(OpenBitFunTheme.soft).clipShape(Capsule())
                    .focused($focused)
                if let error = model.pairingError {
                    Text(error).font(.system(size: 13)).foregroundStyle(OpenBitFunTheme.statusDanger)
                }
                HStack(spacing: 12) {
                    pairingButton("取消", primary: false) {
                        manualOpen = false
                        focused = false
                    }
                    pairingButton(model.pairingBusy ? "正在连接" : "配对", primary: true) {
                        model.submitPairing(url: pairingURL)
                        focused = false
                    }
                    .disabled(!canSubmit)
                }
            }
            .padding(.horizontal, 28).padding(.top, 30).padding(.bottom, 28)
            .frame(maxWidth: 520)
            .background(OpenBitFunTheme.card)
            .clipShape(RoundedRectangle(cornerRadius: 34))
            .overlay(RoundedRectangle(cornerRadius: 34).stroke(OpenBitFunTheme.line, lineWidth: 1))
            .padding(.horizontal, 34)
        }
    }

    private func pairingButton(_ title: String, primary: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(model.localized(title))
                .font(.system(size: 19, weight: .bold))
                .foregroundStyle(primary ? OpenBitFunTheme.contentOnAction : OpenBitFunTheme.ink)
                .frame(maxWidth: .infinity, minHeight: 58)
                .background(primary ? OpenBitFunTheme.accent : OpenBitFunTheme.soft)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}
