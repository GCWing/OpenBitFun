import OpenBitFunMobileCore
import SwiftUI

struct RemoteConnectedHomeView: View {
    @ObservedObject var model: MobileAppModel
    var onBrowse: (() -> Void)?

    private var recent: [ChatSession] {
        let candidates = model.remoteSessions.map {
            RecentSessionUiState(id: $0.id, status: $0.status,
                                 updatedAt: $0.updatedLabel, createdAt: $0.createdAt)
        }
        return RecentSessionsPresentation.shared.sessionIds(sessions: candidates).compactMap { id in
            model.remoteSessions.first { $0.id == id }
        }
    }
    private func context(_ session: ChatSession) -> String {
        let device = model.accountDevices.first { $0.id == session.deviceKey }?.name ?? model.accountDeviceName ?? ""
        let workspace = session.workspaceName.flatMap { $0.isEmpty ? nil : $0 }
            ?? session.workspacePath?.split(separator: "/").last.map(String.init) ?? ""
        return [device, workspace].filter { !$0.isEmpty }.joined(separator: " · ")
    }
    private func browse() {
        if let onBrowse { onBrowse() }
        else { model.drawerOpen = true }
    }
    private var presentation: RemoteHomePresentation {
        RemoteHomePresentation.resolve(
            signedIn: model.accountUser != nil,
            hasTarget: model.remoteExpectedDeviceKey != nil,
            connected: model.remoteConnected && model.connectionPhase == .connected,
            reconnecting: model.connectionPhase == .reconnecting,
            sessionsLoaded: model.remoteInitialSessionReady
        )
    }

    @ViewBuilder
    private var homeStatus: some View {
        switch presentation {
        case .chooseDevice:
            Text(model.localized("选择设备和工作区，继续你的对话。"))
                .font(.system(size: 13)).foregroundStyle(OpenBitFunTheme.muted)
            homeButton("查看设备", action: browse)
        case .pairDevice:
            Text(model.localized("连接电脑后，继续你的对话。"))
                .font(.system(size: 13)).foregroundStyle(OpenBitFunTheme.muted)
            homeButton("连接电脑", action: model.connectRemote)
        case .connecting, .loadingSessions:
            homeButton("查看设备", action: browse)
        case .unavailable:
            // The shell's connection banner owns the error detail and retry action.
            homeButton("查看设备", action: browse)
        case .ready:
            EmptyView()
        }
    }

    private func homeButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(model.localized(title))
                .font(.system(size: 15, weight: .medium))
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(OpenBitFunTheme.soft, in: RoundedRectangle(cornerRadius: 12))
        }.buttonStyle(.plain).padding(.vertical, 16)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                WelcomeBrandFlowView(sweep: true)
                    .frame(width: MobileDesignGeometry.recentHomeMarkSize, height: MobileDesignGeometry.recentHomeMarkSize)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 20)
                Text(model.localized("今天，想做点什么？"))
                    .font(.system(size: MobileDesignGeometry.recentHomeTitleSize, weight: .medium))
                    .multilineTextAlignment(.center).frame(maxWidth: .infinity)
                    .padding(.top, 10).padding(.bottom, 32)
                homeStatus
                if !recent.isEmpty || presentation == .ready {
                    HStack {
                        Text(model.localized("最近会话"))
                        Spacer()
                        Button(model.localized("全部会话"), action: browse)
                            .foregroundStyle(OpenBitFunTheme.ink)
                    }.font(.system(size: 12)).foregroundStyle(OpenBitFunTheme.muted)
                }
                ForEach(recent) { session in
                    Button {
                        if session.deviceKey != nil { model.selectDirectorySession(session) }
                        else { model.select(session) }
                    } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(session.title).font(.system(size: 15)).lineLimit(2)
                                Text(context(session)).font(.system(size: 11))
                                    .foregroundStyle(OpenBitFunTheme.muted).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                        }.padding(.vertical, MobileDesignGeometry.recentHomeRowPadding)
                            .contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    Rectangle().fill(OpenBitFunTheme.line).frame(height: 0.5)
                }
                if recent.isEmpty && presentation == .ready {
                    Text(model.localized("还没有可继续的对话"))
                        .font(.system(size: 13)).foregroundStyle(OpenBitFunTheme.muted).padding(.vertical, 18)
                }

            }
            .padding(.horizontal, MobileDesignGeometry.recentHomeGutter).padding(.bottom, 28)
            .frame(maxWidth: MobileDesignGeometry.recentHomeMaxWidth)
            .frame(maxWidth: .infinity, alignment: .center)
        }.foregroundStyle(OpenBitFunTheme.ink).background(OpenBitFunTheme.page)
    }
}

/// Matches HarmonyOS ChatStatusBar: page background, two hairlines, one status label.
struct RemoteConversationStatusBar: View {
    @ObservedObject var model: MobileAppModel

    private var failed: Bool { model.connectionPhase == .disconnected && !(model.coreErrorMessage ?? "").isEmpty }
    private var tone: Color { failed ? OpenBitFunTheme.statusDanger : OpenBitFunTheme.muted }
    private var title: String {
        model.localized(model.isSending ? "OpenBitFun 正在执行..." :
            (model.connectionPhase == .reconnecting ? "正在恢复连接" : (failed ? "连接异常" : "已断开")))
    }
    private var detail: String {
        model.coreErrorMessage ?? model.localized(model.connectionPhase == .reconnecting ?
            "正在重新连接桌面端" : "请重新连接")
    }

    var body: some View {
        HStack(spacing: 10) {
            if model.isSending { Color.clear.frame(width: 68) }
            HStack(spacing: 7) {
                Circle().fill(tone).frame(width: 8, height: 8)
                Text(detail.isEmpty || detail == title ? title : "\(title) · \(detail)")
                    .font(MobileDesignTypography.bodySmall.font)
                    .foregroundStyle(model.isSending ? OpenBitFunTheme.muted : tone)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: model.isSending ? .center : .leading)
            if model.isSending {
                Button(model.localized("停止"), action: model.stopSending)
                    .font(MobileDesignTypography.bodySmall.font)
                    .foregroundStyle(OpenBitFunTheme.ink)
                    .frame(width: 68, height: 34)
                    .background(OpenBitFunTheme.soft, in: Capsule())
                    .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 24)
        .frame(height: 48)
        .background(OpenBitFunTheme.page)
        .overlay(alignment: .top) { OpenBitFunTheme.line.frame(height: 1) }
        .overlay(alignment: .bottom) { OpenBitFunTheme.line.frame(height: 1) }
        .accessibilityIdentifier("conversation.connectionStatus")
    }
}

/// Signed-out home with a fixed contour mark and looping desktop phrases.
struct WelcomeHomeView: View {
    @ObservedObject var model: MobileAppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var started = Date()
    private var phrases: [String] { ["OpenBitFun", model.localized("干点活儿"), model.localized("玩点花样"), model.localized("随你发挥")] }

    var body: some View {
        GeometryReader { geometry in
            let height = max(540, geometry.size.height)
            ScrollView(showsIndicators: false) {
                VStack(spacing: 0) {
                    HStack {
                        HStack(spacing: 0) { ForEach(Array("OpenBitFun".enumerated()), id: \.offset) { _, c in welcomeGlyph(c, size: MobileDesignGeometry.welcomeHeaderWordSize) } }
                        Spacer()
                    }
                    .padding(.horizontal, MobileDesignGeometry.welcomeGutter)
                    .frame(height: MobileDesignGeometry.welcomeHeaderHeight)
                    TimelineView(.animation(minimumInterval: 1.0 / 60, paused: reduceMotion || scenePhase != .active)) { timeline in
                        let pose = phrase(at: timeline.date)
                        VStack(spacing: 29) {
                            WelcomeBrandFlowView()
                                .frame(width: MobileDesignGeometry.welcomeMarkSize, height: MobileDesignGeometry.welcomeMarkSize)
                            HStack(spacing: 0) {
                                ForEach(Array(pose.word.enumerated()), id: \.offset) { index, letter in
                                    let p = min(1, max(0, (pose.time - 180 - Double(index) * 55) / 800))
                                    let ease = 1 - pow(1-p, 3)
                                    let bump = sin(p * .pi) * (1-p)
                                    let out = min(1, max(0, (pose.time - duration(pose.word) + 650) / 650))
                                    welcomeGlyph(letter, size: pose.word.count > 12 ? 27 : MobileDesignGeometry.welcomeWordSize)
                                        .opacity(min(1,p*3)*(1-out))
                                        .scaleEffect(1+bump*0.045)
                                        .offset(x: (1-ease)*38-bump*5-out*out*30)
                                }
                            }
                            .frame(height: 48)
                            .accessibilityHidden(true)
                        }
                        .offset(y: -28)
                        .frame(maxWidth: .infinity)
                        .frame(height: max(270,height-MobileDesignGeometry.welcomeHeaderHeight-228))
                    }
                    VStack(spacing: MobileDesignGeometry.welcomeButtonGap) {
                        welcomeAction(model.accountUser == nil ? "登录账号" : "连接电脑", symbol: nil) {
                            if model.accountUser == nil { model.accountSheetOpen = true }
                            else { model.connectRemote() }
                        }
                        welcomeAction("扫码连接电脑", symbol: "viewfinder") { model.scanRemote() }
                        MiniAppsButton(model: model).foregroundStyle(MobileDesignColors.welcomeButton)
                    }
                    .padding(.horizontal, MobileDesignGeometry.welcomeGutter)
                    .padding(.top, MobileDesignGeometry.welcomeGutter)
                    .padding(.bottom, MobileDesignGeometry.welcomeDockBottom)
                    .background(MobileDesignColors.welcomeDock)
                    .clipShape(UnevenRoundedRectangle(topLeadingRadius: MobileDesignGeometry.welcomeDockRadius, topTrailingRadius: MobileDesignGeometry.welcomeDockRadius))
                }
                .frame(maxWidth: MobileDesignGeometry.welcomeMaxWidth)
                .frame(maxWidth: .infinity)
            }
        }
        .foregroundStyle(OpenBitFunTheme.ink)
        .background(OpenBitFunTheme.page)
        .onChange(of: scenePhase) { if $0 == .active { started = Date() } }
    }

    private func welcomeGlyph(_ letter: Character, size: CGFloat) -> some View {
        Text(letter == "i" ? "ı" : String(letter)).font(.system(size: size, weight: .semibold))
            .overlay(alignment: .top) {
                if letter == "i" { Circle().fill(MobileDesignColors.brandDot).frame(width: size*0.14, height: size*0.14).offset(y: size*0.25) }
            }
    }

    private func welcomeAction(_ title: String, symbol: String?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if let symbol { Image(systemName: symbol).font(.system(size: 20, weight: .regular)) }
                Text(model.localized(title)).font(.system(size: 14, weight: .semibold))
            }
            .frame(maxWidth: .infinity, minHeight: MobileDesignGeometry.welcomeButtonHeight)
            .foregroundStyle(MobileDesignColors.welcomeButtonLabel)
            .background(MobileDesignColors.welcomeButton)
            .clipShape(Capsule())
        }.buttonStyle(.plain)
    }
    private func duration(_ word: String) -> Double { 250+Double(word.count)*185+(word == "OpenBitFun" ? 600 : 0)+1800+650 }
    private func phrase(at date: Date) -> (word: String,time: Double) {
        if reduceMotion { return ("OpenBitFun",2700) }
        var time = max(0,date.timeIntervalSince(started)*1000).truncatingRemainder(dividingBy: phrases.reduce(0) { $0+duration($1) })
        for word in phrases { if time < duration(word) { return (word,time) };time -= duration(word) }
        return (phrases[0],0)
    }
}
