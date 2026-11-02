import Foundation

/// Native presentation state. The authoritative text always stays outside the reveal buffer.
struct StreamingTextState: Equatable {
    private(set) var visible: String
    private(set) var target: String
    private(set) var ticksRemaining = 0

    init(text: String = "") {
        visible = text
        target = text
    }

    mutating func update(_ text: String, active: Bool) {
        // The transcript owner already resolves record revisions. Rewrites and
        // deletions are authoritative even while active; only append-only growth
        // may keep animating from the previous reveal buffer.
        guard active, text.hasPrefix(target), text.hasPrefix(visible) else {
            visible = text
            target = text
            ticksRemaining = 0
            return
        }
        target = text
        if target == visible { ticksRemaining = 0 }
        else if ticksRemaining == 0 { ticksRemaining = 35 }
    }

    mutating func advance() {
        guard visible != target, ticksRemaining > 0 else { return }
        let remaining = target.count - visible.count
        let step = max(1, Int(ceil(Double(remaining) / Double(min(8, ticksRemaining)))))
        // Character boundaries prevent splitting emoji, combining marks or surrogate pairs.
        visible = String(target.prefix(min(target.count, visible.count + step)))
        ticksRemaining -= 1
        if visible == target { ticksRemaining = 0 }
    }
}

/// Retains native reveal progress across row reuse and collapsed subagent cards.
/// Entries are scoped by controller epoch, session, row and block at the call site.
@MainActor
final class StreamingRevealCache {
    static let shared = StreamingRevealCache()
    private let entries = NSCache<NSString, NSString>()

    init() {
        entries.countLimit = 128
        entries.totalCostLimit = 4 * 1_024 * 1_024
    }

    func text(for key: String) -> String {
        entries.object(forKey: key as NSString) as String? ?? ""
    }

    func save(_ text: String, for key: String) {
        entries.setObject(text as NSString, forKey: key as NSString, cost: text.utf8.count)
    }
}
