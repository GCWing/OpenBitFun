import SwiftUI
import OpenBitFunMobileCore

/// Shared chrome for every OpenBitFun modal page. The presentation primitive stays
/// native; this view owns the paper-and-ink header geometry inside it.
struct OpenBitFunModalHeader: View {
    let title: String
    var subtitle: String? = nil
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(MobileLocalization.text(title))
                    .font(MobileDesignTypography.conversationHeaderTitle.font)
                    .foregroundStyle(OpenBitFunTheme.ink)
                    .lineLimit(1)
                if let subtitle, !subtitle.isEmpty {
                    Text(MobileLocalization.text(subtitle))
                        .font(MobileDesignTypography.labelSmall.font)
                        .foregroundStyle(OpenBitFunTheme.muted)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(OpenBitFunTheme.ink)
                    .frame(
                        width: MobileDesignGeometry.controlTouchSize,
                        height: MobileDesignGeometry.controlTouchSize
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(MobileLocalization.text("关闭"))
        }
        .frame(minHeight: MobileDesignGeometry.sheetHeaderHeight)
    }
}

/// Header used when a picker or provider page replaces the current modal
/// content. Harmony's selection panels use a quiet 32-point dismissal target
/// on a 56-point row rather than another filled circular control.
struct OpenBitFunSelectionHeader: View {
    let title: String
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text(MobileLocalization.text(title))
                .font(MobileDesignTypography.headlineSmall.font)
                .foregroundStyle(OpenBitFunTheme.ink)
                .lineLimit(1)
            Spacer(minLength: 8)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 18, weight: .regular))
                    .foregroundStyle(OpenBitFunTheme.muted)
                    .frame(
                        width: MobileDesignGeometry.selectionCloseSize,
                        height: MobileDesignGeometry.selectionCloseSize
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(MobileLocalization.text("关闭"))
        }
        .padding(.horizontal, 16)
        .frame(height: MobileDesignGeometry.sheetHeaderHeight)
    }
}

struct OpenBitFunModalCard<Content: View>: View {
    var radius: CGFloat = MobileDesignGeometry.settingsCardRadius
    var bordered: Bool = true
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0, content: content)
            .background(OpenBitFunTheme.card)
            .clipShape(RoundedRectangle(cornerRadius: radius))
            .overlay(
                RoundedRectangle(cornerRadius: radius)
                    .stroke(bordered ? OpenBitFunTheme.line : OpenBitFunTheme.transparent, lineWidth: 1)
            )
    }
}

/// One signed-out connection decision, reused wherever the user can enter the
/// remote product. Native apps connect only through the signed-in account, so
/// the single action is account sign-in.
struct SignedOutConnectionActions: View {
    let accountTitle: String
    let onOpenAccount: () -> Void
    var enabled = true
    var buttonHeight: CGFloat = 48
    var spacing: CGFloat = 10
    var fontSize: CGFloat = 16

    var body: some View {
        VStack(spacing: spacing) {
            Button(action: onOpenAccount) {
                Text(accountTitle)
                    .font(.system(size: fontSize, weight: .bold))
                    .foregroundStyle(OpenBitFunTheme.contentOnAction)
                    .frame(maxWidth: .infinity, minHeight: buttonHeight)
                    .background(MobileDesignColors.primaryAction)
                    .overlay(Capsule().stroke(MobileDesignColors.primaryAction, lineWidth: 1))
                    .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(!enabled)
        }
    }
}

struct OpenBitFunPopoverSurfaceModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, MobileDesignGeometry.popoverPadding)
            .padding(.vertical, MobileDesignGeometry.popoverVerticalPadding)
            .frame(width: MobileDesignGeometry.popoverWidth)
            .background(MobileDesignColors.floatingPanelBg)
            .clipShape(RoundedRectangle(cornerRadius: MobileDesignGeometry.popoverRadius))
            .overlay(
                RoundedRectangle(cornerRadius: MobileDesignGeometry.popoverRadius)
                    .stroke(OpenBitFunTheme.line, lineWidth: 1)
            )
            .shadow(
                color: OpenBitFunTheme.line,
                radius: MobileDesignGeometry.popoverShadowRadius,
                y: 7
            )
    }
}

struct OpenBitFunCompactPopoverSurfaceModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.vertical, 8)
            .frame(width: MobileDesignGeometry.compactPopoverWidth)
            .background(MobileDesignColors.floatingPanelBg)
            .clipShape(RoundedRectangle(cornerRadius: MobileDesignGeometry.compactPopoverRadius))
            .overlay(
                RoundedRectangle(cornerRadius: MobileDesignGeometry.compactPopoverRadius)
                    .stroke(OpenBitFunTheme.line, lineWidth: 1)
            )
            .shadow(color: OpenBitFunTheme.line, radius: MobileDesignGeometry.popoverShadowRadius, y: 7)
    }
}

extension View {
    func openBitFunPopoverSurface() -> some View {
        modifier(OpenBitFunPopoverSurfaceModifier())
    }

    func openBitFunCompactPopoverSurface() -> some View {
        modifier(OpenBitFunCompactPopoverSurfaceModifier())
    }

    func openBitFunAdaptiveModal<ModalContent: View>(
        isPresented: Binding<Bool>,
        placement: SettingsPlacement,
        onDismiss: (() -> Void)? = nil,
        fitContent: Bool = false,
        @ViewBuilder content: @escaping () -> ModalContent
    ) -> some View {
        modifier(
            OpenBitFunAdaptiveModalModifier(
                isPresented: isPresented,
                placement: placement,
                onDismiss: onDismiss,
                fitContent: fitContent,
                modalContent: content
            )
        )
    }
}

/// Selects the native presentation lifecycle from the KMP placement decision.
/// Compact devices keep a system sheet; side placements use a native full-screen
/// cover containing a trailing paper surface so focus and VoiceOver are isolated
/// from the covered conversation while the dimensions remain Harmony-compatible.
private struct OpenBitFunAdaptiveModalModifier<ModalContent: View>: ViewModifier {
    @Binding var isPresented: Bool
    let placement: SettingsPlacement
    let onDismiss: (() -> Void)?
    let fitContent: Bool
    @State private var contentHeight: CGFloat = 280
    @ViewBuilder let modalContent: () -> ModalContent

    private var supportsFittedCover: Bool {
        if #available(iOS 16.4, *) { return true }
        return false
    }

    private var isSide: Bool { !fitContent && placement.mode == .side }

    private var compactDetent: PresentationDetent {
        fitContent ? .height(contentHeight) : placement.height > 0 ? .height(CGFloat(placement.height)) : .large
    }

    private var compactPresented: Binding<Bool> {
        Binding(
            get: { isPresented && !isSide && !(fitContent && supportsFittedCover) },
            set: { if !$0 { isPresented = false } }
        )
    }

    private var sidePresented: Binding<Bool> {
        Binding(
            get: { isPresented && isSide },
            set: { if !$0 { isPresented = false } }
        )
    }

    private var fittedPresented: Binding<Bool> {
        Binding(get: { isPresented && fitContent && supportsFittedCover }, set: { if !$0 { isPresented = false } })
    }

    func body(content base: Content) -> some View {
        base
            .sheet(isPresented: compactPresented, onDismiss: onDismiss) {
                compactSheet
            }
            .fullScreenCover(isPresented: fittedPresented, onDismiss: onDismiss) {
                fittedCover
            }
            .fullScreenCover(isPresented: sidePresented, onDismiss: onDismiss) {
                sideCover
            }
    }

    @ViewBuilder
    private var fittedCover: some View {
        if #available(iOS 16.4, *) {
            fittedPanel.presentationBackground(OpenBitFunTheme.transparent)
        } else {
            fittedPanel
        }
    }

    private var fittedPanel: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottom) {
                OpenBitFunTheme.scrim.ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { isPresented = false }
                ScrollView(showsIndicators: false) {
                    modalContent()
                        .background {
                            GeometryReader { contentGeometry in
                                Color.clear.preference(key: ConnectionSheetHeightKey.self, value: contentGeometry.size.height)
                            }
                        }
                }
                .frame(width: min(MobileDesignGeometry.loginSheetMaxWidth,
                    geometry.size.width - 2 * MobileDesignGeometry.loginSheetOuterMargin),
                    height: min(contentHeight, max(0, geometry.size.height - 2 * MobileDesignGeometry.loginSheetOuterMargin)))
                .background(OpenBitFunTheme.page)
                .clipShape(RoundedRectangle(cornerRadius: MobileDesignGeometry.sheetTopRadius, style: .circular))
                .padding(.bottom, MobileDesignGeometry.loginSheetOuterMargin)
                .onPreferenceChange(ConnectionSheetHeightKey.self) { height in
                    if height > 0 { contentHeight = height }
                }
                .accessibilityAddTraits(.isModal)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private var compactSheet: some View {
        let surface = sizedContent
            .background(OpenBitFunTheme.page)
            .onPreferenceChange(ConnectionSheetHeightKey.self) { height in
                if fitContent && height > 0 { contentHeight = max(280, height) }
            }
            .presentationDetents([compactDetent])
            .presentationDragIndicator(.hidden)
        if #available(iOS 16.4, *) {
            surface.presentationCornerRadius(MobileDesignGeometry.sheetTopRadius)
        } else {
            surface
        }
    }

    @ViewBuilder
    private var sizedContent: some View {
        if fitContent {
            ScrollView(showsIndicators: false) {
                modalContent()
                    .background {
                        GeometryReader { geometry in
                            Color.clear.preference(key: ConnectionSheetHeightKey.self, value: geometry.size.height)
                        }
                    }
            }
        } else {
            modalContent()
        }
    }

    @ViewBuilder
    private var sideCover: some View {
        let cover = ZStack(alignment: .trailing) {
            OpenBitFunTheme.scrim
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { isPresented = false }

            modalContent()
                .frame(
                    width: CGFloat(placement.width),
                    height: CGFloat(placement.height)
                )
                .background(OpenBitFunTheme.page)
                .clipShape(
                    RoundedRectangle(
                        cornerRadius: MobileDesignGeometry.sheetSideRadius,
                        style: .continuous
                    )
                )
                .overlay(
                    RoundedRectangle(
                        cornerRadius: MobileDesignGeometry.sheetSideRadius,
                        style: .continuous
                    )
                    .stroke(OpenBitFunTheme.line, lineWidth: 1)
                )
                .shadow(color: OpenBitFunTheme.shadowStrong, radius: 18, x: -5, y: 8)
                .accessibilityAddTraits(.isModal)
        }
        if #available(iOS 16.4, *) {
            cover.presentationBackground(OpenBitFunTheme.transparent)
        } else {
            cover
        }
    }
}

/// Connection and login pages mirror Harmony's SheetCloseHeader and SheetActionFooter.
struct ConnectionSheetHeader: View {
    let onClose: () -> Void
    var uniformGlyph = false
    var body: some View {
        HStack {
            Spacer()
            Button(action: onClose) {
                Group {
                    if uniformGlyph {
                        Path { path in
                            path.move(to: CGPoint(x: 2, y: 2)); path.addLine(to: CGPoint(x: 16, y: 16))
                            path.move(to: CGPoint(x: 16, y: 2)); path.addLine(to: CGPoint(x: 2, y: 16))
                        }
                        .stroke(OpenBitFunTheme.ink, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                        .frame(width: 18, height: 18)
                    } else {
                        Image(systemName: "xmark")
                            .font(.system(size: 18, weight: .medium))
                            .foregroundStyle(OpenBitFunTheme.ink)
                    }
                }
                .frame(width: MobileDesignGeometry.controlTouchSize, height: MobileDesignGeometry.controlTouchSize)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(MobileLocalization.text("关闭"))
        }
        .padding(.trailing, 8)
        .frame(height: MobileDesignGeometry.sheetHeaderHeight)
    }
}

struct ConnectionSheetFooter: View {
    let label: String
    var elevated = true
    var primary = false
    var enabled = true
    let onAction: () -> Void
    var body: some View {
        Button(action: onAction) {
            Text(label)
                .font(MobileDesignTypography.labelLarge.font)
                .foregroundStyle(primary ? OpenBitFunTheme.contentOnAction : OpenBitFunTheme.ink)
                .frame(maxWidth: .infinity, minHeight: MobileDesignGeometry.sheetActionHeight)
                .background(primary ? MobileDesignColors.primaryAction : OpenBitFunTheme.card)
                .clipShape(Capsule())
                .overlay(Capsule().stroke(primary ? OpenBitFunTheme.transparent : OpenBitFunTheme.line, lineWidth: 1))
                .shadow(color: primary ? MobileDesignColors.shadowSubtle : MobileDesignColors.shadowFaint,
                    radius: elevated ? 14 : 0, y: elevated ? 5 : 0)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.32)
        .frame(maxWidth: 520)
        .padding(.horizontal, MobileDesignGeometry.sheetHorizontalPadding)
        .frame(maxWidth: .infinity)
        .padding(.top, 10)
        .padding(.bottom, 24)
    }
}

private struct ConnectionSheetHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
