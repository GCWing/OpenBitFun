import Foundation

@main
struct ComposerDismissGestureTests {
    static func main() {
        // An intentional downward drag on the focused input row collapses the keyboard.
        expect(ComposerDismissGesture.dismissesKeyboard(
            translation: CGSize(width: 0, height: 60), isFocused: true
        ), "a straight downward drag dismisses the keyboard")

        // A drag that mostly travels sideways belongs to the field, not the dismissal.
        expect(!ComposerDismissGesture.dismissesKeyboard(
            translation: CGSize(width: 120, height: 40), isFocused: true
        ), "a mostly horizontal drag leaves the keyboard alone")

        // Just past the axis bias is still a vertical intent.
        expect(ComposerDismissGesture.dismissesKeyboard(
            translation: CGSize(width: 20, height: 60), isFocused: true
        ), "a vertical drag with modest sideways travel still dismisses")

        // Below the threshold nothing happens, in either direction.
        for height in [-80.0, 0, 12, 35] {
            expect(!ComposerDismissGesture.dismissesKeyboard(
                translation: CGSize(width: 0, height: height), isFocused: true
            ), "a \(height) vertical translation is not a dismissal")
        }
        expect(ComposerDismissGesture.dismissesKeyboard(
            translation: CGSize(width: 0, height: 37), isFocused: true
        ), "the threshold itself starts dismissing")

        // An unfocused field has no keyboard to dismiss, however far the drag goes.
        expect(!ComposerDismissGesture.dismissesKeyboard(
            translation: CGSize(width: 0, height: 200), isFocused: false
        ), "an unfocused composer ignores the drag")

        // The drag must be long enough to exclude a tap before it is even tracked.
        expect(ComposerDismissGesture.minimumDistance > 0
            && ComposerDismissGesture.minimumDistance < ComposerDismissGesture.threshold,
               "the recognition distance stays below the dismissal threshold")

        print("Composer dismiss gesture tests passed")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        precondition(condition(), message)
    }
}
