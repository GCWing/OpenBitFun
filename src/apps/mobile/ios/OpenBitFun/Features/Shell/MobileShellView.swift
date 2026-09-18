import OpenBitFunMobileCore
import SwiftUI
import UniformTypeIdentifiers

/// The measured height of the conversation's floating bottom layer. Only the
/// jump-to-bottom button needs it: `safeAreaInset` already pads the transcript.
private struct BottomOverlayHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

struct MobileShellView: View {
    @ObservedObject var model: MobileAppModel
    @State private var wideSidebarCollapsed = false
    @State private var sessionActionsOpen = false
    @State private var sidebarActionSession: ChatSession?
    @State private var bottomOverlayHeight: CGFloat = 0

    var body: some View {
        GeometryReader { proxy in
            adaptiveSurface(viewportWidth: proxy.size.width, viewportHeight: proxy.size.height)
                .environment(\.permissionMailboxMaxHeight, proxy.size.height * 0.4)
        }
        .overlayPreferenceValue(SessionActionsAnchorKey.self) { anchor in
            GeometryReader { proxy in
                if sessionActionsOpen, let anchor {
                    let frame = proxy[anchor]
                    ZStack(alignment: .topLeading) {
                        OpenBitFunTheme.transparent
                            .contentShape(Rectangle())
                            .onTapGesture { sessionActionsOpen = false }
                        ConversationActionsPopover(
                            model: model,
                            onDismiss: { sessionActionsOpen = false }
                        )
                        .offset(
                            x: min(
                                max(8, frame.maxX - MobileDesignGeometry.popoverWidth),
                                proxy.size.width - MobileDesignGeometry.popoverWidth - 8
                            ),
                            y: frame.maxY + 8
                        )
                        .transition(
                            .offset(x: 8, y: -8).combined(with: .opacity)
                        )
                    }
                }
            }
        }
        .overlayPreferenceValue(SidebarSessionActionsAnchorKey.self) { anchors in
            GeometryReader { proxy in
                if let session = sidebarActionSession,
                   let anchor = anchors[session.id] {
                    let frame = proxy[anchor]
                    let remote = model.surface == .remote
                    ZStack(alignment: .topLeading) {
                        OpenBitFunTheme.transparent
                            .contentShape(Rectangle())
                            .onTapGesture { sidebarActionSession = nil }
                        SessionActionSurface(
                            model: model,
                            session: session,
                            presentation: .popover,
                            canViewDetails: true,
                            canArchive: false,
                            canExport: false,
                            canDelete: true,
                            onViewDetails: {
                                sidebarActionSession = nil
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                                    model.showSessionDetails(session)
                                }
                            },
                            onArchive: {},
                            onExport: {},
                            onDelete: {
                                model.deleteRemoteSession(session)
                            },
                            onClose: { sidebarActionSession = nil }
                        )
                        .position(
                            x: frame.maxX + 6 + 150,
                            y: min(max(frame.midY, 170), proxy.size.height - 170)
                        )
                    }
                }
            }
        }
        .animation(.easeInOut(duration: 0.22), value: wideSidebarCollapsed)
        .overlay(alignment: .bottom) {
            if let message = model.toastMessage {
                Text(message)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(OpenBitFunTheme.contentOnAction)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 38)
                    .background(OpenBitFunTheme.toastBackground)
                    .clipShape(Capsule())
                    .padding(.bottom, 86)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.18), value: model.toastMessage)
        .modifier(RuntimeDownloadPresentation(model: model, enabled: model.runtimeDeviceTools?.visible != true && model.filePreview == nil))

    }

    private var showsWelcomeHome: Bool {
        model.surface == .remote && model.accountUser == nil && !model.remoteConnected && model.remoteExpectedDeviceKey == nil
    }

    @ViewBuilder
    private func adaptiveSurface(viewportWidth: CGFloat, viewportHeight: CGFloat) -> some View {
        let width = Int32(max(0, viewportWidth.rounded(.down)))
        let height = Int32(max(0, viewportHeight.rounded(.down)))
        let layoutPolicy = ConversationLayoutPolicy.shared
        let wide = layoutPolicy.useMasterDetail(
            viewportWidth: width,
            wideViewportMatched: width >= layoutPolicy.MD_MIN_WIDTH,
            isFolded: false,
            creases: [],
            isExpandedFoldable: false,
            isHover: false
        )
        let geometry = layoutPolicy.resolveWideGeometry(viewportWidth: width, creases: [])
        let adaptiveInput = AdaptiveLayoutInput(
            viewportWidth: width,
            viewportHeight: height,
            isFolded: false,
            isExpandedFoldable: false,
            isHoverOperate: false,
            wideLayoutMatched: width >= layoutPolicy.MD_MIN_WIDTH,
            verticalCreases: [],
            horizontalCreases: [],
            isRtl: false
        )
        let settingsPlacement = SettingsPlacementPolicy.shared.resolve(
            input: adaptiveInput,
            kind: .settings
        )
        let connectPlacement = SettingsPlacementPolicy.shared.resolve(
            input: adaptiveInput,
            kind: .connect
        )
        let sessionDetailsPlacement = SettingsPlacementPolicy.shared.resolve(
            input: adaptiveInput,
            kind: .sessionDetails
        )
        let remoteViewSettingsPlacement = SettingsPlacementPolicy.shared.resolve(
            input: adaptiveInput,
            kind: .remoteViewSettings
        )
        let previewLayout = FilePreviewPlacementPolicy.shared.resolveLayout(
            previewVisible: model.filePreview != nil,
            largeScreenLayout: wide,
            viewportWidth: width,
            creases: [],
            preferredMasterWidth: geometry.masterPaneWidth
        )
        let previewInPane = model.filePreview != nil &&
            previewLayout.placement != FilePreviewPlacement.compactFullPage
        let previewForSheet = Binding<MobileFilePreview?>(
            get: { previewInPane ? nil : model.filePreview },
            set: { value in
                if value == nil { model.dismissFilePreview() }
            }
        )
        let focusSplit = previewLayout.placement == FilePreviewPlacement.wideFocusSplit
        let triplePane = previewLayout.placement == FilePreviewPlacement.wideTriplePane
        let sidebarVisible = wide && !wideSidebarCollapsed && !focusSplit
        let sidebarWidth = triplePane
            ? CGFloat(previewLayout.masterPaneWidth)
            : CGFloat(geometry.masterPaneWidth)
        let compactSidebarWidth = min(280, max(220, viewportWidth * 0.68))

        ZStack(alignment: .leading) {
            if !sidebarVisible {
                SidebarView(model: model)
                    .frame(width: compactSidebarWidth)
                    .opacity(model.drawerOpen ? 1 : 0)
                    .offset(x: model.drawerOpen ? 0 : -compactSidebarWidth * 0.1)
                    .animation(
                        .easeOut(duration: model.drawerOpen ? 0.30 : 0.22),
                        value: model.drawerOpen
                    )
            }

            HStack(spacing: 0) {
                if sidebarVisible {
                    SidebarView(
                        model: model,
                        permanent: true,
                        onCollapse: { wideSidebarCollapsed = true },
                        onPermanentActions: { sidebarActionSession = $0 }
                    )
                    .frame(width: sidebarWidth)
                    paneSeparator(width: triplePane ? CGFloat(previewLayout.masterConversationGap) : 0)
                }

                conversationSurface(
                    sidebarAction: sidebarVisible ? nil : {
                        if wide {
                            if focusSplit { model.dismissFilePreview() }
                            wideSidebarCollapsed = false
                        } else {
                            model.drawerOpen = true
                        }
                    },
                    sidebarActionLabel: wide ? "展开侧栏" : "打开侧栏"
                )
                .frame(width: previewInPane ? CGFloat(previewLayout.conversationPaneWidth) : nil)

                if previewInPane, let preview = model.filePreview {
                    paneSeparator(width: CGFloat(previewLayout.conversationPreviewGap))
                    RemoteFilePreviewSheet(model: model, preview: preview, embedded: true)
                        .frame(width: CGFloat(previewLayout.previewPaneWidth))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .overlay {
                if !sidebarVisible && model.drawerOpen {
                    OpenBitFunTheme.page.opacity(0.62)
                        .transition(.opacity.animation(.easeOut(duration: 0.21)))
                        .onTapGesture { model.drawerOpen = false }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: !sidebarVisible && model.drawerOpen ? 28 : 0))
            .shadow(
                color: !sidebarVisible && model.drawerOpen ? OpenBitFunTheme.shellScrim : OpenBitFunTheme.transparent,
                radius: !sidebarVisible && model.drawerOpen ? 34 : 0,
                x: !sidebarVisible && model.drawerOpen ? -10 : 0
            )
            .blur(radius: !sidebarVisible && model.drawerOpen ? 1.1 : 0)
            .scaleEffect(
                x: !sidebarVisible && model.drawerOpen ? 0.985 : 1,
                y: !sidebarVisible && model.drawerOpen ? 0.992 : 1,
                anchor: UnitPoint(x: 0, y: MobileDesignGeometry.conversationHeaderHeight / 2 / max(1, viewportHeight))
            )
            .offset(x: !sidebarVisible && model.drawerOpen ? compactSidebarWidth : 0)
            .animation(
                .easeOut(duration: model.drawerOpen ? 0.32 : 0.25),
                value: model.drawerOpen
            )
        }
        .sheet(item: previewForSheet, onDismiss: model.dismissFilePreview) { preview in
            RemoteFilePreviewSheet(model: model, preview: preview)
        }
        .openBitFunAdaptiveModal(
            isPresented: $model.settingsOpen,
            placement: settingsPlacement
        ) {
            SettingsView(model: model)
        }
        .openBitFunAdaptiveModal(
            isPresented: $model.remoteControlSettingsOpen,
            placement: settingsPlacement
        ) {
            RemoteControlSettingsView(model: model)
        }
        .openBitFunAdaptiveModal(
            isPresented: $model.remoteViewSettingsOpen,
            placement: remoteViewSettingsPlacement
        ) {
            RemoteViewSettingsView(model: model)
        }
        .openBitFunAdaptiveModal(
            isPresented: $model.pairingSheetOpen,
            placement: connectPlacement,
            onDismiss: model.dismissPairing
        ) {
            PairingSheet(model: model)
        }
        .openBitFunAdaptiveModal(
            isPresented: $model.accountSheetOpen,
            placement: settingsPlacement,
            fitContent: model.accountUser == nil && model.accountFailureStage != "DEVICE_LIST"
        ) {
            AccountSettingsView(model: model)
        }
        .openBitFunAdaptiveModal(
            isPresented: Binding(
                get: { model.sessionDetails != nil },
                set: { if !$0 { model.dismissSessionDetails() } }
            ),
            placement: sessionDetailsPlacement
        ) {
            if let session = model.sessionDetails {
                SessionDetailsView(
                    model: model,
                    session: session,
                    onClose: model.dismissSessionDetails
                )
            }
        }
        .onChange(of: wide) { isWide in
            if !isWide { wideSidebarCollapsed = false }
        }
    }

    @ViewBuilder
    private func conversationSurface(
        sidebarAction: (() -> Void)?,
        sidebarActionLabel: String
    ) -> some View {
        Group {
            if model.remoteCreateOpen {
                RemoteCreateSessionView(
                    model: model,
                    onBack: { model.remoteCreateOpen = false }
                )
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("conversation.draft")
            } else {
                conversationContent(
                    sidebarAction: sidebarAction,
                    sidebarActionLabel: sidebarActionLabel
                )
            }
        }
        .background(OpenBitFunTheme.page)
    }

    private func conversationContent(
        sidebarAction: (() -> Void)?,
        sidebarActionLabel: String
    ) -> some View {
        Group {
            if showsWelcomeHome {
                WelcomeHomeView(model: model)
            } else if model.surface == .remote && !model.remoteSessionSelected {
                VStack(spacing: 0) {
                    ConversationHeader(
                        model: model,
                        actionsOpen: $sessionActionsOpen,
                        sidebarAction: sidebarAction,
                        sidebarActionLabel: sidebarActionLabel
                    )
                    RemoteConnectedHomeView(model: model, onBrowse: sidebarAction)
                }
            } else {
                floatingConversation(
                    sidebarAction: sidebarAction,
                    sidebarActionLabel: sidebarActionLabel
                )
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(conversationAccessibilityIdentifier)
    }

    /**
     The transcript owns the whole pane; the header and the composer float over
     it and the transcript scrolls underneath both, fading out as it reaches
     either edge. `safeAreaInset` is exactly that arrangement: it reserves the
     room at rest so nothing starts out hidden, and lets the scroll view pass
     beneath once it moves — which is why this needs no height measurement,
     unlike the same layout on Android and HarmonyOS.
     */
    private func floatingConversation(
        sidebarAction: (() -> Void)?,
        sidebarActionLabel: String
    ) -> some View {
        ZStack {
            ChatTimelineView(model: model, bottomOverlayInset: bottomOverlayHeight)
            if model.surface == .remote && model.remoteConversationLoading {
                ConversationLoadingState()
            }
        }
        .onPreferenceChange(BottomOverlayHeightKey.self) { bottomOverlayHeight = $0 }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                VStack(spacing: 0) {
                    ConversationHeader(
                        model: model,
                        actionsOpen: $sessionActionsOpen,
                        sidebarAction: sidebarAction,
                        sidebarActionLabel: sidebarActionLabel
                    )
                    PermissionMailboxPanel(model: model)
                }
                .background(MobileDesignColors.pageBgOverlay)
                .background(.ultraThinMaterial)
                conversationTopEdgeFade
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                ComposerBar(model: model)
            }
            // The fade covers the whole layer, not just a strip above it: the
            // transcript runs behind the composer, so anything short of that
            // leaves a line of text sitting crisp and legible beside the pill
            // after it has already faded out higher up. It stops short of the
            // page colour so the pill's material still has something to blur.
            .background(
                LinearGradient(
                    stops: [
                        .init(color: MobileDesignColors.pageBgFade, location: 0),
                        .init(color: MobileDesignColors.pageBgOverlay, location: 0.45),
                        .init(color: MobileDesignColors.pageBgOverlay, location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .background(
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: BottomOverlayHeightKey.self,
                        value: proxy.size.height
                    )
                }
            )
        }
    }

    /**
     Carries the header's opaque band down into the transcript, so a line of
     text is not cut in half at its edge. Never takes a touch: the transcript
     below it is still the thing being pointed at. The bottom layer needs no
     strip of its own — its whole background is the gradient.
     */
    private var conversationTopEdgeFade: some View {
        LinearGradient(
            colors: [OpenBitFunTheme.page, OpenBitFunTheme.page.opacity(0)],
            startPoint: .top,
            endPoint: .bottom
        )
        .frame(height: MobileDesignGeometry.conversationEdgeFadeHeight)
        .allowsHitTesting(false)
    }

    private var conversationAccessibilityIdentifier: String {
        guard model.surface == .remote else { return "conversation.local" }
        let sessionID = model.selectedSessionID
        guard model.remoteSessionSelected,
              !sessionID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return "conversation.draft"
        }
        return "conversation.session.\(sessionID)"
    }

    @ViewBuilder
    private func paneSeparator(width: CGFloat) -> some View {
        if width > 0 {
            Rectangle().fill(OpenBitFunTheme.line).frame(width: width)
        }
    }
}


struct RuntimeDownloadPresentation: ViewModifier {
    @ObservedObject var model: MobileAppModel
    let enabled: Bool
    func body(content: Content) -> some View {
        content.sheet(isPresented: Binding(
            get: { enabled && model.downloadExporterOpen },
            set: { if enabled { model.downloadExporterOpen = $0 } }
        )) {
            if let download = model.pendingDownload {
                RuntimeDownloadExporter(url: download.localURL, name: download.name) { saved in
                    guard model.pendingDownload?.localURL == download.localURL else { return }
                    model.finishDownloadExport(success: saved)
                }
            }
        }
    }
}

private struct RuntimeDownloadExporter: UIViewControllerRepresentable {
    let url: URL
    let name: String
    let finished: (Bool) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(finished) }
    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}
    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let finished: (Bool) -> Void
        init(_ finished: @escaping (Bool) -> Void) { self.finished = finished }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finished(!urls.isEmpty) }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finished(false) }
    }
}
