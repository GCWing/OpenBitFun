import Foundation

@main
struct HistoryPageArrivalTrackerTests {
    static func main() {
        var tracker = HistoryPageArrivalTracker()
        precondition(!tracker.arrived(atStart: true), "Layout alone cannot request history")
        tracker.beginGesture()
        precondition(!tracker.arrived(atStart: false))
        precondition(tracker.arrived(atStart: true))
        for _ in 0..<10 {
            precondition(!tracker.arrived(atStart: false))
            precondition(!tracker.arrived(atStart: true), "Bounce/layout cannot request a second page")
        }
        tracker.beginGesture()
        precondition(tracker.arrived(atStart: true), "A new drag may request another page")
        tracker.cancelArrival()
        precondition(!tracker.arrived(atStart: true), "Refused/manual requests cannot queue a retry")
        print("History page gesture gate tests passed")
    }
}
