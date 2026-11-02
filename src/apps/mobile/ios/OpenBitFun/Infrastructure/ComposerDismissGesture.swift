import CoreGraphics

/// A downward drag on the composer input row dismisses the keyboard.
///
/// The transcript's own scroll view already dismisses the keyboard
/// interactively, but a short conversation has nothing to scroll, and the
/// composer row sits outside that scroll view entirely — which is why dragging
/// the input row had no effect. Matching the Messages and WeChat composers, only
/// an intentional and mostly vertical drag counts, so the text field keeps its
/// tap, caret placement and horizontal scrolling.
enum ComposerDismissGesture {
    /// Long enough to exclude a tap or a caret drag, short enough to feel immediate.
    static let minimumDistance: CGFloat = 12
    static let threshold: CGFloat = 36
    /// Vertical drags win over the sideways travel they are usually mixed with.
    private static let verticalBias: CGFloat = 1.5

    static func dismissesKeyboard(translation: CGSize, isFocused: Bool) -> Bool {
        guard isFocused else { return false }
        return translation.height > threshold
            && translation.height > abs(translation.width) * verticalBias
    }
}
