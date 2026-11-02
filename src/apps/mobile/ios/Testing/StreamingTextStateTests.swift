import Foundation

@main
struct StreamingTextStateTests {
    @MainActor
    static func main() {
        var state = StreamingTextState()
        let text = String(repeating: "中文👨‍👩‍👧‍👦é", count: 100)
        state.update(text, active: true)
        assert(state.visible.isEmpty)
        for _ in 0..<35 {
            let previous = state.visible
            state.advance()
            assert(state.visible.hasPrefix(previous))
            assert(text.hasPrefix(state.visible))
        }
        assert(state.visible == text)
        state.update("中文", active: true)
        assert(state.visible == "中文" && state.target == "中文" && state.ticksRemaining == 0)
        state.update(text + " tail", active: true)
        state.advance()
        state.update("corrected", active: true)
        assert(state.visible == "corrected")
        state.update("final", active: false)
        assert(state.visible == "final" && state.ticksRemaining == 0)
        state.update("", active: false)
        assert(state.visible.isEmpty)
        let restored = StreamingTextState(text: text)
        assert(restored.visible == text && restored.ticksRemaining == 0)
        let cache = StreamingRevealCache()
        cache.save("partial", for: "device-a|session-a|row-a|body")
        assert(cache.text(for: "device-a|session-a|row-a|body") == "partial")
        assert(cache.text(for: "device-b|session-a|row-a|body").isEmpty)
        assert(cache.text(for: "device-a|session-b|row-a|body").isEmpty)
        var resumed = StreamingTextState(text: cache.text(for: "device-a|session-a|row-a|body"))
        resumed.update("partial remainder", active: true)
        assert(resumed.visible == "partial")
        resumed.advance()
        assert(resumed.visible.hasPrefix("partial"))
        // A same-row cached reveal must not resurrect content removed by the host.
        var shortened = StreamingTextState(text: "partial obsolete")
        shortened.update("partial", active: true)
        assert(shortened.visible == "partial" && shortened.target == "partial")
        shortened.update("", active: true)
        assert(shortened.visible.isEmpty && shortened.ticksRemaining == 0)
        // Corrections may still share the visible prefix while changing the
        // unrevealed target; the old animation must not remain in flight.
        var pending = StreamingTextState(text: "prefix")
        pending.update("prefix obsolete", active: true)
        pending.update("prefix fixed", active: true)
        assert(pending.visible == "prefix fixed" && pending.ticksRemaining == 0)
        print("Streaming text state tests passed")
    }
}
