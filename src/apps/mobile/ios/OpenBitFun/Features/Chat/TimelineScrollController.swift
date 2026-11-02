import SwiftUI
import UIKit
import OSLog

/// Observe the native scroll geometry, without replacing SwiftUI's scroll delegate.
/// Content-size observations also cover Markdown reveal, image loading and tool expansion.
@MainActor
final class TimelineScrollController: ObservableObject {
    @Published private(set) var followsBottom = true
    @Published private(set) var historyBottomSpace: CGFloat = 0
    /// Asked once per deliberate drag reaching the start of the transcript.
    var onHistoryStartReached: (() -> Bool)?
    private var historyArrival = HistoryPageArrivalTracker()
    private weak var scrollView: UIScrollView?
    private var observations: [NSKeyValueObservation] = []
    private var updateScheduled = false
    private var applyingOffset = false
    private var interactionRevision = 0
    private var historyAnchor: (id: String, contentTop: CGFloat)?
    private var historyRequestInFlight = false
    private var requestedDuringGesture = false
    private var sessionID = ""
    // Geometry telemetry must not invalidate the SwiftUI tree on every scroll pixel.
    private final class WeakRow {
        weak var view: UIView?
        init(_ view: UIView) { self.view = view }
    }
    private var rowViews: [String: WeakRow] = [:]
    private var preferenceFrames: [String: CGRect] = [:]
    var rowFrames: [String: CGRect] {
        get {
            guard let scroll = scrollView else { return preferenceFrames }
            var frames = preferenceFrames
            for (id, weakRow) in rowViews {
                guard let view = weakRow.view, view.window != nil else { continue }
                let rect = view.convert(view.bounds, to: scroll)
                frames[id] = rect.offsetBy(dx: -scroll.bounds.minX, dy: -scroll.bounds.minY)
            }
            return frames
        }
        set { preferenceFrames = newValue }
    }

    func registerRow(_ id: String, view: UIView) {
        guard rowViews[id]?.view !== view else { return }
        // A retained message view can acquire its acknowledged transcript ID.
        // Drop its old alias so history anchoring never selects a stale row.
        rowViews = rowViews.filter { $0.value.view != nil && ($0.key == id || $0.value.view !== view) }
        rowViews[id] = WeakRow(view)
    }
    #if DEBUG
    private var lastDiagnosticTime: TimeInterval = 0
    private var lastDiagnosticHeight: CGFloat = 0
    private var lastDiagnosticOffset: CGFloat = 0

    private func traceGeometry(_ event: String, force: Bool = false) {
        guard let scroll = scrollView else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let deltaH = scroll.contentSize.height - lastDiagnosticHeight
        let deltaY = scroll.contentOffset.y - lastDiagnosticOffset
        guard force || now - lastDiagnosticTime >= 0.2 || abs(deltaH) > 100 || abs(deltaY) > 100 else { return }
        lastDiagnosticTime = now
        lastDiagnosticHeight = scroll.contentSize.height
        lastDiagnosticOffset = scroll.contentOffset.y
        log.info("ScrollTrace event=\(event, privacy: .public) content_h=\(scroll.contentSize.height) viewport_h=\(scroll.bounds.height) offset_y=\(scroll.contentOffset.y) delta_h=\(deltaH) delta_y=\(deltaY) bottom_gap=\(self.bottomOffset(scroll) - scroll.contentOffset.y) following=\(self.followsBottom) applying=\(self.applyingOffset) tracking=\(scroll.isTracking) dragging=\(scroll.isDragging) decelerating=\(scroll.isDecelerating)")
    }
    #endif
    private var previousSize: CGSize = .zero
    private let log = Logger(subsystem: "com.openbitfun.mobile.ios", category: "timeline-scroll")
    private var lastGeometryLogTime: TimeInterval = 0

    private func logGeometry(_ reason: String, force: Bool = false) {
        guard let scroll = scrollView else { return }
        let now = Date.timeIntervalSinceReferenceDate
        guard force || now - lastGeometryLogTime >= 1 else { return }
        lastGeometryLogTime = now
        log.info("Scroll reason=\(reason, privacy: .public) content_h=\(scroll.contentSize.height) viewport_h=\(scroll.bounds.height) offset_y=\(scroll.contentOffset.y) bottom_y=\(self.bottomOffset(scroll)) following=\(self.followsBottom) dragging=\(scroll.isDragging) decelerating=\(scroll.isDecelerating) enabled=\(scroll.isScrollEnabled)")
    }

    func attach(_ scroll: UIScrollView) {
        guard scrollView !== scroll else { return }
        scrollView?.panGestureRecognizer.removeTarget(self, action: #selector(historyPanChanged(_:)))
        observations.removeAll()
        scrollView = scroll
        scroll.panGestureRecognizer.addTarget(self, action: #selector(historyPanChanged(_:)))
        previousSize = scroll.bounds.size
        observations = [
            scroll.observe(\.contentSize, options: [.new]) { [weak self] scroll, _ in
                MainActor.assumeIsolated {
                    #if DEBUG
                    self?.traceGeometry("content-size")
                    #endif
                    self?.scheduleFollow()
                    self?.restoreHistoryAnchor()
                }
            },
            scroll.observe(\.bounds, options: [.new]) { [weak self] scroll, _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if self.previousSize != scroll.bounds.size {
                        self.previousSize = scroll.bounds.size
                        self.scheduleFollow()
                    }
                    #if DEBUG
                    self.traceGeometry("bounds")
                    #endif
                    self.observeUserScroll(scroll)
                    self.restoreHistoryAnchor()
                }
            }
        ]
        logGeometry("attach", force: true)
        scheduleFollow()
        restoreHistoryAnchor()
    }

    func open(session: String) {
        guard sessionID != session else { return }
        sessionID = session
        historyArrival.cancelArrival()
        historyRequestInFlight = false
        requestedDuringGesture = false
        followBottom()
    }

    func followBottom() {
        interactionRevision += 1
        historyAnchor = nil
        historyBottomSpace = 0
        followsBottom = true
        logGeometry("follow-request", force: true)
        scheduleFollow()
    }

    func stopFollowing() { interactionRevision += 1; followsBottom = false }

    /// Capture content coordinates, not a viewport position. Finger movement
    /// changes only the viewport; prepending changes only the row's content Y.
    @discardableResult
    func beginHistoryRequest() -> Bool {
        guard !historyRequestInFlight, let scroll = scrollView else { return false }
        historyRequestInFlight = true
        requestedDuringGesture = true
        stopFollowing()
        // A short transcript leaves blank space below its rows. Retain that
        // space while prepending, otherwise UIScrollView clamps the compensating
        // offset and pushes the original messages down on a tall viewport.
        historyBottomSpace += max(0, scroll.bounds.height - scroll.adjustedContentInset.top
            - scroll.adjustedContentInset.bottom - scroll.contentSize.height)
        if let row = rowFrames.filter({ $0.value.maxY > 0 })
            .min(by: { $0.value.minY < $1.value.minY }) {
            historyAnchor = (row.key, row.value.minY + scroll.contentOffset.y)
        }
        return true
    }

    func historyLoadingChanged(_ loading: Bool) {
        historyRequestInFlight = loading
        restoreHistoryAnchor()
    }

    /// Run during native layout so the inserted area is compensated before it
    /// is drawn. This also works while dragging/decelerating: it never restores
    /// an old finger position or scrolls the captured row to the top first.
    func restoreHistoryAnchor() {
        guard !applyingOffset, !followsBottom, let anchor = historyAnchor,
              let scroll = scrollView, let view = rowViews[anchor.id]?.view,
              view.window != nil else { return }
        let contentTop = view.convert(view.bounds, to: scroll).minY
        let delta = contentTop - anchor.contentTop
        guard abs(delta) > 0.5 else { return }
        historyAnchor = (anchor.id, contentTop)
        applyingOffset = true
        scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x,
            y: scroll.contentOffset.y + delta), animated: false)
        applyingOffset = false
    }

    @objc private func historyPanChanged(_ pan: UIPanGestureRecognizer) {
        guard let scroll = scrollView else { return }
        if pan.state == .began {
            requestedDuringGesture = historyRequestInFlight
            historyArrival.beginGesture()
            // A completed page no longer owns subsequent deliberate scrolling.
            if !historyRequestInFlight { historyAnchor = nil }
        }
        guard pan.state == .began || pan.state == .changed,
              !requestedDuringGesture, !historyRequestInFlight else { return }
        observeHistoryStart(scroll)
    }

    private func observeUserScroll(_ scroll: UIScrollView) {
        guard !applyingOffset, scroll.isTracking || scroll.isDragging || scroll.isDecelerating else { return }
        logGeometry("user-scroll")
        let atBottom = bottomOffset(scroll) - scroll.contentOffset.y <= 24
        let revision = interactionRevision
        // KVO can run inside a layout pass; publish presentation state on the next turn.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.interactionRevision == revision else { return }
            if !self.historyRequestInFlight { self.followsBottom = atBottom }
        }
    }

    private func bottomOffset(_ scroll: UIScrollView) -> CGFloat {
        max(-scroll.adjustedContentInset.top,
            scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
    }

    /// Only real pan events may request a page. Layout, bounce and anchor
    /// corrections cannot re-arm pagination or drain history after release.
    private func observeHistoryStart(_ scroll: UIScrollView) {
        let aboveStart = scroll.contentOffset.y + scroll.adjustedContentInset.top
        guard historyArrival.arrived(atStart: aboveStart <= 0.5) else { return }
        let session = sessionID
        requestedDuringGesture = true
        DispatchQueue.main.async { [weak self] in
            guard let self, self.sessionID == session, !self.historyRequestInFlight else { return }
            _ = self.onHistoryStartReached?()
        }
    }

    private func scheduleFollow() {
        guard !updateScheduled else { return }
        updateScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.updateScheduled = false
            guard self.followsBottom, let scroll = self.scrollView,
                  !scroll.isTracking, !scroll.isDragging, !scroll.isDecelerating else { return }
            #if DEBUG
            let layoutStart = ProcessInfo.processInfo.systemUptime
            self.traceGeometry("follow-before-layout")
            #endif
            scroll.layoutIfNeeded()
            #if DEBUG
            let layoutMS = (ProcessInfo.processInfo.systemUptime - layoutStart) * 1_000
            if layoutMS > 16 { self.log.info("ScrollTrace event=slow-layout duration_ms=\(layoutMS)") }
            #endif
            let y = self.bottomOffset(scroll)
            guard abs(y - scroll.contentOffset.y) > 0.5 else { return }
            self.logGeometry("follow-apply")
            self.applyingOffset = true
            scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: y), animated: false)
            #if DEBUG
            self.traceGeometry("follow-after-offset")
            #endif
            self.applyingOffset = false
        }
    }
}

/// A passive fallback for lazy rows whose unchanged SwiftUI preferences may
/// not be delivered after a transcript replacement. Read geometry at capture time.
struct TimelineRowProbe: UIViewRepresentable {
    let controller: TimelineScrollController
    let rowID: String

    func makeUIView(context: Context) -> UIView {
        let view = RowView()
        view.controller = controller
        view.isUserInteractionEnabled = false
        controller.registerRow(rowID, view: view)
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        controller.registerRow(rowID, view: view)
    }

    final class RowView: UIView {
        weak var controller: TimelineScrollController?
        override func layoutSubviews() {
            super.layoutSubviews()
            controller?.restoreHistoryAnchor()
        }
    }
}

struct TimelineScrollProbe: UIViewRepresentable {
    let controller: TimelineScrollController

    func makeUIView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.isUserInteractionEnabled = false
        view.controller = controller
        return view
    }

    func updateUIView(_ uiView: ProbeView, context: Context) {
        uiView.controller = controller
        uiView.bindScrollView()
    }

    final class ProbeView: UIView {
        weak var controller: TimelineScrollController?
        override func didMoveToWindow() { super.didMoveToWindow(); bindScrollView() }
        override func layoutSubviews() {
            super.layoutSubviews()
            bindScrollView()
            controller?.restoreHistoryAnchor()
        }

        func bindScrollView() {
            var parent = superview
            while let candidate = parent {
                if let scroll = candidate as? UIScrollView {
                    controller?.attach(scroll)
                    return
                }
                parent = candidate.superview
            }
        }
    }
}

#if DEBUG
/// Passive telemetry: never publishes geometry into SwiftUI state or requests layout.
struct ThinkingLayoutProbe: UIViewRepresentable {
    let rowID: String
    let partID: String
    let characters: Int
    let streaming: Bool
    let expanded: Bool

    func makeUIView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: ProbeView, context: Context) {
        let changed = view.characters != characters || view.streaming != streaming || view.expanded != expanded
        view.rowID = rowID
        view.partID = partID
        view.characters = characters
        view.streaming = streaming
        view.expanded = expanded
        if changed { view.record("state", force: true) }
    }

    static func dismantleUIView(_ view: ProbeView, coordinator: ()) {
        view.record("dismantle", force: true)
    }

    final class ProbeView: UIView {
        var rowID = ""
        var partID = ""
        var characters = 0
        var streaming = false
        var expanded = false
        private let instance = String(UUID().uuidString.prefix(8))
        private let log = Logger(subsystem: "com.openbitfun.mobile.ios", category: "thinking-layout")
        private var lastTime: TimeInterval = 0
        private var lastHeight: CGFloat = -1
        private var exceededViewport = false

        override func didMoveToWindow() {
            super.didMoveToWindow()
            record(window == nil ? "detach" : "attach", force: true)
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            record("layout")
        }

        func record(_ event: String, force: Bool = false) {
            var ancestor = superview
            while ancestor != nil && !(ancestor is UIScrollView) { ancestor = ancestor?.superview }
            let scroll = ancestor as? UIScrollView
            let viewport = scroll?.bounds.height ?? 0
            let exceeds = viewport > 0 && bounds.height >= viewport
            let crossed = exceeds != exceededViewport
            let now = ProcessInfo.processInfo.systemUptime
            guard force || crossed || (bounds.height != lastHeight && now - lastTime >= 0.2) else { return }
            let delta = bounds.height - lastHeight
            lastHeight = bounds.height
            lastTime = now
            exceededViewport = exceeds
            let top = scroll.map { convert(bounds, to: $0).minY - $0.bounds.minY } ?? 0
            log.info("Thinking event=\(event, privacy: .public) instance=\(self.instance, privacy: .public) row=\(self.rowID, privacy: .private(mask: .hash)) part=\(self.partID, privacy: .private(mask: .hash)) chars=\(self.characters) streaming=\(self.streaming) expanded=\(self.expanded) width=\(self.bounds.width) height=\(self.bounds.height) delta_h=\(delta) viewport_h=\(viewport) exceeds_viewport=\(exceeds) crossed_viewport=\(crossed) visible_top=\(top) content_h=\(scroll?.contentSize.height ?? 0) offset_y=\(scroll?.contentOffset.y ?? 0) dragging=\(scroll?.isDragging ?? false)")
        }
    }
}
#endif
