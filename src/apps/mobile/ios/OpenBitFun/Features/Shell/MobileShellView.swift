import OpenBitFunMobileCore
import SwiftUI
import UniformTypeIdentifiers

struct MobileShellView: View {
    @ObservedObject var model: MobileAppModel
    @State private var wideSidebarCollapsed = false
    @State private var sessionActionsOpen = false
    @State private var sidebarActionSession: ChatSession?

    var body: some View {
        GeometryReader { proxy in
            adaptiveSurface(viewportWidth: proxy.size.width, viewportHeight: proxy.size.height)
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
        .fileExporter(
            isPresented: $model.downloadExporterOpen,
            document: MobileDownloadDocument(data: model.pendingDownload?.data ?? Data()),
            contentType: model.pendingDownload.flatMap { UTType(mimeType: $0.mimeType) } ?? .data,
            defaultFilename: model.pendingDownload?.name ?? "download"
        ) { result in
            switch result {
            case .success: model.finishDownloadExport(success: true)
            case .failure: model.finishDownloadExport(success: false)
            }
        }

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
                anchor: .leading
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
        VStack(spacing: 0) {
            if !showsWelcomeHome {
            ConversationHeader(
                model: model,
                actionsOpen: $sessionActionsOpen,
                sidebarAction: sidebarAction,
                sidebarActionLabel: sidebarActionLabel
            )
            }
            if model.surface == .remote,
               model.remoteExpectedDeviceKey != nil,
               model.connectionPhase != .connected {
                ConnectionStatusBar(
                    phase: model.connectionPhase,
                    detail: model.coreErrorMessage,
                    onRetry: model.verifyRemoteConnection
                )
            }
            if showsWelcomeHome {
                WelcomeHomeView(model: model)
            } else if model.surface == .remote && !model.remoteSessionSelected {
                RemoteConnectedHomeView(model: model, onBrowse: sidebarAction)
            } else {
                ZStack {
                    ChatTimelineView(model: model)
                    if model.surface == .remote && model.remoteConversationLoading {
                        ConversationLoadingState()
                    }
                }
                ComposerBar(model: model)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(conversationAccessibilityIdentifier)
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
