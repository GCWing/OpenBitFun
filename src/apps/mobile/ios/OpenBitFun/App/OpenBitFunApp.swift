import SwiftUI

@main
struct OpenBitFunApp: App {
    @State private var showStartupBrand = !MobileLaunchConfiguration.streamingRegressionPreview
        && MobileLaunchConfiguration.designPreviewScenario() == nil
        && StartupRevealPreference.claim()
    @State private var showColdStart = false
    @State private var coldStartConsumed = false
    @State private var notificationOnboardingOpen = false
    @StateObject private var model = MobileLaunchConfiguration.makeModel()
    @Environment(\.scenePhase) private var scenePhase
    private let designPreviewScenario = MobileLaunchConfiguration.designPreviewScenario()
    private static var coldStartProcessClaimed = false

    var body: some Scene {
        WindowGroup {
            if MobileLaunchConfiguration.streamingRegressionPreview {
                #if DEBUG
                StreamingRegressionView()
                #endif
            } else if let scenario = designPreviewScenario {
                MobileDesignGallery(scenario: scenario)
                    .preferredColorScheme(scenario.appearance == "dark" ? .dark : .light)
            } else {
                ZStack {
                    MobileShellView(model: model)
                        .accessibilityHidden(showStartupBrand || showColdStart)
                    if showStartupBrand {
                        StartupBrandReveal { showStartupBrand = false }
                    }
                }
                    .overlayPreferenceValue(ColdStartHomeMarkPreference.self) { anchor in
                        if showColdStart {
                            GeometryReader { geometry in
                                ColdStartHomeTransition(target: anchor.map { geometry[$0] }) { showColdStart = false }
                            }
                        }
                    }
                    .onAppear { resolveColdStart() }
                    .onChange(of: model.launchAccountRestored) { _ in resolveColdStart() }
                    .task(id: showStartupBrand || showColdStart || !coldStartConsumed) {
                        if !showStartupBrand && !showColdStart && coldStartConsumed {
                            notificationOnboardingOpen = await TaskCompletionNotifier.shouldOfferOnboarding()
                        }
                    }
                    .alert(model.localized("开启任务完成提醒"), isPresented: $notificationOnboardingOpen) {
                        Button(model.localized("稍后"), role: .cancel) {
                            TaskCompletionNotifier.finishOnboarding(enable: false)
                        }
                        Button(model.localized("开启通知")) {
                            TaskCompletionNotifier.finishOnboarding(enable: true)
                        }
                    } message: {
                        Text(model.localized("允许 OpenBitFun 在任务完成时发送通知。你可以稍后在系统设置中更改。"))
                    }
                    .onChange(of: scenePhase) { phase in
                        if phase == .background { Self.coldStartProcessClaimed = true; coldStartConsumed = true; showStartupBrand = false; showColdStart = false }
                        model.handleScenePhase(phase)
                    }
                    .onOpenURL { url in
                        // The auth page redirects to this scheme after the
                        // browser completes. The shared account poller is
                        // already waiting; opening the URL brings this scene
                        // foreground and the next poll is immediate.
                        guard url.scheme == "openbitfun",
                              url.host == "auth",
                              url.path == "/callback",
                              url.user == nil,
                              url.password == nil,
                              url.query == nil,
                              url.fragment == nil else { return }
                        model.notifyAuthorizationCallback()
                    }
                    .environment(\.locale, Locale(identifier: model.appLanguage.rawValue))
            }
        }
    }

    private func resolveColdStart() {
        guard !coldStartConsumed else { return }
        if showStartupBrand { Self.coldStartProcessClaimed = true; coldStartConsumed = true; return }
        guard !Self.coldStartProcessClaimed else { coldStartConsumed = true; return }
        guard let signedIn = model.launchAccountRestored else { return }
        Self.coldStartProcessClaimed = true
        coldStartConsumed = true
        showColdStart = signedIn && !model.remoteSessionSelected
    }
}
