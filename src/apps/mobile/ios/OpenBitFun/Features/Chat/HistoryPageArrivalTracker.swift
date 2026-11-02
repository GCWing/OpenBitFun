import Foundation

/// One automatic page per deliberate drag. Layout and bounce cannot re-arm it.
struct HistoryPageArrivalTracker {
    private var consumed = true

    mutating func beginGesture() { consumed = false }

    mutating func arrived(atStart: Bool) -> Bool {
        guard atStart, !consumed else { return false }
        consumed = true
        return true
    }

    mutating func cancelArrival() { consumed = true }
}
