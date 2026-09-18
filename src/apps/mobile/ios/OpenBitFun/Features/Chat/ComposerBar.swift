import OpenBitFunMobileCore
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

private enum ComposerPrimaryAction {
    case stopListening
    case stopTurn
    case send
    case sendBlocked
    case voice
    case voiceBlocked
}

struct ComposerBar: View {
    @ObservedObject var model: MobileAppModel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.scenePhase) private var scenePhase
    @FocusState private var focused: Bool
    @StateObject private var speech = SpeechInputController()
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var modelSelectorOpen = ProcessInfo.processInfo.arguments.contains(
        "--composer-model-picker"
    ) || ProcessInfo.processInfo.environment["OPENBITFUN_COMPOSER_MODEL_PICKER"] == "1"

    private var placeholder: String {
        model.localized(model.surface == .remote
            ? "向 OpenBitFun 提问"
            : (model.localSessionSelected ? "输入消息" : "问问 OpenBitFun"))
    }

    private var expanded: Bool {
        focused || modelSelectorOpen || model.draft.contains("\n")
    }

    private var hasContent: Bool {
        !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            !model.composerImages.isEmpty
    }

    private var canSend: Bool {
        hasContent && model.remoteSendSessionID != nil
    }

    private var primaryActionKind: ComposerPrimaryAction {
        if speech.isListening { return .stopListening }
        if model.isSending && (!hasContent || model.surface != .remote) { return .stopTurn }
        if hasContent { return canSend ? .send : .sendBlocked }
        return model.busy ? .voiceBlocked : .voice
    }

    private var showsSupplementalVoice: Bool {
        hasContent && !speech.isListening && !model.isSending
    }

    var body: some View {
        VStack(spacing: 2) {
            if !model.composerImages.isEmpty {
                attachmentStrip
            }

            stableInputRow

            if expanded {
                expandedActionRow
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, expanded ? 4 : 0)
        .padding(.bottom, expanded ? 2 : 0)
        .frame(minHeight: expanded
            ? MobileDesignGeometry.composerExpandedHeight
            : MobileDesignGeometry.composerCollapsedHeight)
        // The transcript now runs underneath the pill, so the fill is a material
        // and the blur does the separating rather than an opaque card colour.
        .background(MobileDesignColors.cardOverlay)
        .background(.ultraThinMaterial)
        .overlay(
            RoundedRectangle(
                cornerRadius: expanded || !model.composerImages.isEmpty
                    ? MobileDesignGeometry.composerExpandedRadius
                    : MobileDesignGeometry.composerCollapsedRadius
            )
            .stroke(OpenBitFunTheme.line, lineWidth: 0.5)
        )
        .clipShape(
            RoundedRectangle(
                cornerRadius: expanded || !model.composerImages.isEmpty
                    ? MobileDesignGeometry.composerExpandedRadius
                    : MobileDesignGeometry.composerCollapsedRadius
            )
        )
        .shadow(color: OpenBitFunTheme.shadowSubtle, radius: 10, y: 2)
        .padding(.horizontal, MobileDesignGeometry.conversationOverlaySideInset)
        .padding(.top, 8)
        .padding(.bottom, 14)
        .animation(.easeOut(duration: 0.22), value: expanded)
        .animation(.easeOut(duration: 0.18), value: model.composerImages.count)
        .onChange(of: model.composerSendGeneration) { _ in
            focused = false
            modelSelectorOpen = false
        }
        .onDisappear { speech.stop() }
        .onChange(of: scenePhase) { if $0 != .active { speech.stop() } }
        .onChange(of: model.selectedSessionID) { _ in speech.stop() }
        .onChange(of: model.remoteTargetEpoch) { _ in speech.stop() }
        .onAppear {
            if model.composerModelPickerPreview {
                modelSelectorOpen = true
            }
        }
        .onChange(of: pickerItems) { items in
            guard !items.isEmpty else { return }
            Task { await importPickedImages(items) }
        }
        .overlayPreferenceValue(ComposerModelSelectorAnchorKey.self) { anchor in
            GeometryReader { proxy in
                if horizontalSizeClass == .regular, modelSelectorOpen, let anchor {
                    let frame = proxy[anchor]
                    modelSelector(asSheet: false)
                        .frame(
                            width: MobileDesignGeometry.composerModelSelectorWidth,
                            height: modelSelectorHeight(asSheet: false)
                        )
                        .background(MobileDesignColors.floatingPanelBg)
                        .clipShape(
                            RoundedRectangle(
                                cornerRadius: MobileDesignGeometry.composerModelSelectorRadius
                            )
                        )
                        .overlay(
                            RoundedRectangle(
                                cornerRadius: MobileDesignGeometry.composerModelSelectorRadius
                            )
                                .stroke(OpenBitFunTheme.line, lineWidth: 1)
                        )
                        .shadow(color: OpenBitFunTheme.line, radius: 20, y: 8)
                        .position(
                            x: min(
                                max(
                                    MobileDesignGeometry.composerModelSelectorWidth / 2 + 8,
                                    frame.midX
                                ),
                                proxy.size.width -
                                    MobileDesignGeometry.composerModelSelectorWidth / 2 - 8
                            ),
                            y: frame.minY - modelSelectorHeight(asSheet: false) / 2 - 8
                        )
                        .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .bottom)))
                        .zIndex(20)
                }
            }
            .allowsHitTesting(horizontalSizeClass == .regular && modelSelectorOpen)
        }
        .sheet(
            isPresented: Binding(
                get: { horizontalSizeClass != .regular && modelSelectorOpen },
                set: { if !$0 { modelSelectorOpen = false } }
            )
        ) {
            modelSelector(asSheet: true)
                .presentationDetents([.height(modelSelectorHeight(asSheet: true))])
                .presentationDragIndicator(.visible)
        }
    }

    /// Keep the same TextField instance alive while focus expands the composer.
    /// Replacing the collapsed row with a separate expanded row destroys the
    /// first responder during the keyboard transition and leaves UIKit without
    /// a focused input target.
    private var stableInputRow: some View {
        HStack(spacing: expanded ? 0 : 5) {
            if !expanded {
                attachmentAction
            }
            inputField(maxLines: expanded ? 4 : 1)
                .frame(minHeight: expanded
                    ? MobileDesignGeometry.composerExpandedInputHeight
                    : MobileDesignGeometry.composerInputHeight)
            if !expanded {
                primaryAction
            }
        }
        .frame(minHeight: expanded
            ? MobileDesignGeometry.composerExpandedInputRowHeight
            : MobileDesignGeometry.composerCollapsedHeight)
    }

    private var expandedActionRow: some View {
        HStack(spacing: 6) {
            attachmentAction
            if !model.modelOptions.isEmpty {
                Button { modelSelectorOpen = true } label: {
                    HStack(spacing: 3) {
                        Text(selectedModel?.primaryLabel ?? model.localized("模型"))
                            .font(MobileDesignTypography.labelMedium.font)
                            .foregroundStyle(OpenBitFunTheme.ink)
                            .lineLimit(1)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(OpenBitFunTheme.muted)
                    }
                    .frame(minHeight: MobileDesignGeometry.composerActionSize)
                    .padding(.horizontal, 4)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(model.localized("选择模型")))
                .anchorPreference(key: ComposerModelSelectorAnchorKey.self, value: .bounds) { $0 }
            }
            Spacer(minLength: 0)
            if showsSupplementalVoice {
                supplementalVoiceAction
            }
            primaryAction
        }
        .frame(minHeight: MobileDesignGeometry.composerExpandedActionRowHeight)
        .padding(.leading, 2)
    }

    private func inputField(maxLines: Int) -> some View {
        HStack(spacing: speech.isListening ? 8 : 0) {
            if speech.isListening {
                ListeningWave()
            }
            TextField(
                "",
                text: $model.draft,
                prompt: Text(speech.isListening ? model.localized("正在聆听") : placeholder)
                    .foregroundColor(speech.isListening ? OpenBitFunTheme.statusSuccess : OpenBitFunTheme.muted),
                axis: .vertical
            )
            .font(MobileDesignTypography.bodyLarge.font)
            .foregroundStyle(OpenBitFunTheme.ink)
            .lineLimit(1...maxLines)
            .focused($focused)
            .accessibilityIdentifier("composer.input")
            .submitLabel(.send)
            .onSubmit {
                if canSend { submitMessage() }
            }
            if showsSupplementalVoice, !expanded {
                supplementalVoiceAction
            }
        }
        .padding(.leading, speech.isListening ? 12 : 4)
        .padding(.trailing, 4)
        .background(speech.isListening ? OpenBitFunTheme.soft : OpenBitFunTheme.transparent)
        .overlay(
            RoundedRectangle(cornerRadius: 20)
                .stroke(speech.isListening ? OpenBitFunTheme.statusSuccess : OpenBitFunTheme.transparent, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 20))
    }

    @ViewBuilder
    private var attachmentAction: some View {
        if model.composerImages.count < 4 {
            PhotosPicker(
                selection: $pickerItems,
                maxSelectionCount: 4 - model.composerImages.count,
                matching: .images
            ) {
                plusGlyph
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(model.localized("添加图片")))
        } else {
            Button { model.showToast(model.localized("最多添加 4 张图片")) } label: { plusGlyph }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(model.localized("已达到图片上限")))
        }
    }

    private var plusGlyph: some View {
        ReferenceGlyph(assetName: "ComposerPlusGlyph", width: 18, height: 18)
            .frame(
                width: MobileDesignGeometry.composerActionSize,
                height: MobileDesignGeometry.composerActionSize
            )
    }

    private var primaryAction: some View {
        Button(action: performPrimaryAction) {
            ZStack {
                switch primaryActionKind {
                case .send, .sendBlocked:
                    Image(systemName: "arrow.up")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(
                            primaryActionKind == .send
                                ? OpenBitFunTheme.contentOnAction
                                : OpenBitFunTheme.muted
                        )
                        .frame(width: 32, height: 32)
                        .background(
                            primaryActionKind == .send
                                ? MobileDesignColors.primaryAction
                                : OpenBitFunTheme.soft
                        )
                        .clipShape(Circle())
                case .stopListening, .stopTurn:
                    RoundedRectangle(cornerRadius: 2.5)
                        .fill(OpenBitFunTheme.contentOnAction)
                        .frame(width: 10, height: 10)
                        .frame(width: 32, height: 32)
                        .background(MobileDesignColors.primaryAction)
                        .clipShape(Circle())
                case .voice, .voiceBlocked:
                    ReferenceGlyph(
                        assetName: "ComposerMicGlyph",
                        width: 16,
                        height: 19,
                        color:
                            primaryActionKind == .voice
                                ? OpenBitFunTheme.ink
                                : OpenBitFunTheme.muted.opacity(0.38)
                    )
                }
            }
            .frame(
                width: MobileDesignGeometry.composerActionSize,
                height: MobileDesignGeometry.composerActionSize
            )
            .background(primaryActionKind == .voiceBlocked ? OpenBitFunTheme.soft : OpenBitFunTheme.transparent)
            .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(primaryActionKind == .sendBlocked || primaryActionKind == .voiceBlocked)
        .accessibilityLabel(primaryActionLabel)
    }

    private var supplementalVoiceAction: some View {
        Button(action: startVoiceInput) {
            ReferenceGlyph(
                assetName: "ComposerMicGlyph",
                width: 16,
                height: 19,
                color: OpenBitFunTheme.ink
            )
                .frame(
                    width: MobileDesignGeometry.composerActionSize,
                    height: MobileDesignGeometry.composerActionSize
                )
                .opacity(model.busy || model.isSending ? 0.32 : 0.72)
        }
        .buttonStyle(.plain)
        .disabled(model.busy || model.isSending)
        .accessibilityLabel(Text(model.localized("语音输入")))
    }

    private var primaryActionLabel: String {
        switch primaryActionKind {
        case .stopListening: return model.localized("停止听写")
        case .stopTurn: return model.localized("停止")
        case .send, .sendBlocked: return model.localized("发送")
        case .voice, .voiceBlocked: return model.localized("语音输入")
        }
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.composerImages) { attachment in
                    ZStack(alignment: .topTrailing) {
                        Group {
                            if let image = UIImage(data: attachment.data) {
                                Image(uiImage: image)
                                    .resizable()
                                    .scaledToFill()
                            } else {
                                Image(systemName: "photo")
                                    .foregroundStyle(OpenBitFunTheme.muted)
                            }
                        }
                        .frame(width: 64, height: 64)
                        .background(OpenBitFunTheme.soft)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12)
                                .stroke(OpenBitFunTheme.line, lineWidth: 1)
                        )

                        Button { model.removeComposerImage(id: attachment.id) } label: {
                            ZStack(alignment: .topTrailing) {
                                Color.clear
                                Image(systemName: "xmark")
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundStyle(OpenBitFunTheme.contentOnAction)
                                    .frame(width: 20, height: 20)
                                    .background(OpenBitFunTheme.mediaScrim)
                                    .clipShape(Circle())
                                    .offset(x: 5, y: -5)
                            }
                            .frame(
                                width: MobileDesignGeometry.composerActionSize,
                                height: MobileDesignGeometry.composerActionSize
                            )
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text(model.localized("移除图片")))
                    }
                    .padding(.top, 6)
                }
            }
            .padding(.horizontal, 2)
        }
        .frame(height: 72)
    }

    @ViewBuilder
    private func modelSelector(asSheet: Bool) -> some View {
        VStack(spacing: 10) {
            if asSheet {
                HStack(spacing: 0) {
                    Text(model.localized("选择模型"))
                        .font(MobileDesignTypography.labelMedium.font)
                        .foregroundStyle(OpenBitFunTheme.muted)
                    Spacer(minLength: 0)
                    Button { modelSelectorOpen = false } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 15, weight: .regular))
                            .foregroundStyle(OpenBitFunTheme.muted)
                            .frame(
                                width: MobileDesignGeometry.selectionCloseSize,
                                height: MobileDesignGeometry.selectionCloseSize
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text(model.localized("关闭")))
                }
                .frame(height: MobileDesignGeometry.selectionCloseSize)
            }

            ScrollView(showsIndicators: false) {
                LazyVStack(spacing: MobileDesignGeometry.composerModelSelectorRowGap) {
                    ForEach(selectorModels) { option in
                        Button {
                            model.selectModel(option.id)
                            modelSelectorOpen = false
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: option.selected ? "checkmark.circle" : "circle")
                                    .font(.system(size: 16))
                                    .foregroundStyle(option.selected ? OpenBitFunTheme.ink : OpenBitFunTheme.transparent)
                                    .frame(width: 20, height: 20)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(option.primaryLabel)
                                        .font(MobileDesignTypography.labelMedium.font)
                                        .foregroundStyle(OpenBitFunTheme.ink)
                                        .fixedSize(horizontal: false, vertical: true)
                                    Text(option.secondaryLabel)
                                        .font(MobileDesignTypography.bodySmall.font)
                                        .foregroundStyle(OpenBitFunTheme.muted)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .frame(minHeight: MobileDesignGeometry.composerModelSelectorRowHeight)
                            .background(option.selected ? OpenBitFunTheme.soft : OpenBitFunTheme.transparent)
                            .clipShape(
                                RoundedRectangle(
                                    cornerRadius: MobileDesignGeometry.composerModelSelectorRowRadius
                                )
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(10)
        .background(asSheet ? OpenBitFunTheme.card : MobileDesignColors.floatingPanelBg)
    }

    private var selectedModel: ComposerModelOption? {
        model.modelOptions.first(where: \.selected) ?? model.modelOptions.first
    }

    private var selectorModels: [ComposerModelOption] {
        model.modelOptions.filter(\.selected) + model.modelOptions.filter { !$0.selected }
    }

    private func modelSelectorHeight(asSheet: Bool) -> CGFloat {
        let visibleRows = min(model.modelOptions.count, 7)
        let listHeight = CGFloat(visibleRows) *
            MobileDesignGeometry.composerModelSelectorRowHeight +
            CGFloat(max(0, visibleRows - 1)) *
            MobileDesignGeometry.composerModelSelectorRowGap
        return min(480, listHeight + (asSheet ? 86 : 20))
    }

    private func performPrimaryAction() {
        switch primaryActionKind {
        case .stopListening:
            speech.stop()
        case .stopTurn:
            model.stopSending()
        case .send:
            submitMessage()
        case .sendBlocked, .voiceBlocked:
            return
        case .voice:
            startVoiceInput()
        }
    }

    private func submitMessage() {
        guard model.send() else { return }
        speech.stop()
        focused = false
        modelSelectorOpen = false
    }

    private func startVoiceInput() {
        let existing = model.draft
        speech.start(
            localeIdentifier: model.appLanguage == .simplifiedChinese ? "zh-CN" : "en-US",
            onPartial: { transcript in
                model.draft = VoiceDraftPolicy.shared.merge(base: existing, transcript: transcript)
            },
            onFailure: { message in model.showToast(model.localized(message)) }
        )
    }

    private func importPickedImages(_ items: [PhotosPickerItem]) async {
        let sessionID = model.selectedSessionID
        let deviceKey = model.remoteExpectedDeviceKey
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self),
                  let prepared = await Task.detached(priority: .userInitiated, operation: {
                      MobileAppModel.prepareComposerImage(data)
                  }).value else {
                model.showToast(model.localized("无法读取所选图片"))
                continue
            }
            guard model.selectedSessionID == sessionID, model.remoteExpectedDeviceKey == deviceKey else { break }
            model.addComposerImage(data: prepared, mimeType: "image/jpeg")
        }
        pickerItems = []
    }
}

private struct ComposerModelSelectorAnchorKey: PreferenceKey {
    static var defaultValue: Anchor<CGRect>?

    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = nextValue() ?? value
    }
}

private struct ListeningWave: View {
    var body: some View {
        HStack(spacing: 2) {
            ForEach([8.0, 14.0, 10.0, 17.0], id: \.self) { height in
                Capsule()
                    .fill(OpenBitFunTheme.statusSuccess)
                    .frame(width: 2, height: height)
            }
        }
        .frame(width: 18, height: 22)
        .accessibilityHidden(true)
    }
}
