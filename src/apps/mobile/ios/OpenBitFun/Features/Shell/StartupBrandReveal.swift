import SwiftUI

/// Native rendering of the mobile startup_brand_reveal contract; no network dependencies.
struct StartupBrandReveal: View {
    let onFinished: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var started = Date()
    private let widths: [CGFloat] = [30,25,24,25,28,10,16,24,25,25]
    private let letters = Array("OpenBıtFun")

    var body: some View {
        GeometryReader { geometry in
            TimelineView(.animation) { timeline in
                let p = min(1, max(0, timeline.date.timeIntervalSince(started) / (MobileDesignMotion.startupBrand / 1000)))
                let scale = min(1, max(0.1, (geometry.size.width - 32) / 280))
                ZStack {
                    OpenBitFunTheme.page
                    stage(progress: p)
                        .frame(width: 280, height: 240)
                        .scaleEffect(scale)
                }
                .frame(width: geometry.size.width, height: geometry.size.height)
                .opacity(1 - smooth((p - 0.97) / 0.03))
            }
        }
        .ignoresSafeArea()
        .contentShape(Rectangle())
        .onTapGesture { }
        .accessibilityHidden(true)
        .task {
            guard !reduceMotion else { onFinished(); return }
            started = Date()
            do {
                try await Task.sleep(nanoseconds: UInt64(MobileDesignMotion.startupBrand * 1_000_000))
                onFinished()
            } catch { /* The overlay was removed or the scene backgrounded. */ }
        }
        .onChange(of: reduceMotion) { if $0 { onFinished() } }
    }

    private func stage(progress p: Double) -> some View {
        let t = min(p / 0.65 * 0.9, 0.9)
        let settle = smooth((p - 0.66) / 0.19)
        let mark = max(0, min(1, (p - 0.66) / 0.19))
        let q = mark - 1
        let markScale = 0.65 + 0.35 * (1 + 2.2*q*q*q + 1.2*q*q)
        return ZStack(alignment: .topLeading) {
            WelcomeBrandFlowView()
                .frame(width: 92, height: 92)
                .scaleEffect(markScale).opacity(ease(mark))
                .position(x: 140, y: 60)
            Canvas { context, _ in
                for i in 0..<letters.count {
                    let start = 0.19 + Double(i) * 0.048
                    let reveal = ease((t - start) / 0.05)
                    let phase = max(0, min(1, (t - start) / 0.085))
                    let bounce = sin(phase * .pi) * pow(1 - phase, 0.65)
                    let center = CGPoint(x: x(i) + widths[i] / 2,
                                         y: 110 + 42*settle + 7*(1-reveal)-8*bounce)
                    var glyphContext = context
                    glyphContext.opacity = reveal
                    glyphContext.translateBy(x: center.x, y: center.y)
                    glyphContext.rotate(by: .degrees((i % 2 == 0 ? -1 : 1) * bounce * 6))
                    let glyph = Text(String(letters[i]))
                        .font(.system(size: MobileDesignTypography.brandWordmark.size, weight: .medium, design: .rounded))
                        .foregroundColor(OpenBitFunTheme.ink)
                    glyphContext.draw(glyph, at: .zero)
                }
                let dot = dotPose(t: t, settle: settle)
                let halo = sin(max(0, min(1, (t - 0.86) / 0.04)) * .pi)
                context.fill(Path(ellipseIn: CGRect(x: dot.x-11,y:dot.y-11,width:22,height:22)),
                             with: .color(MobileDesignColors.brandDot.opacity(0.16 * halo)))
                let bounds = CGRect(x: dot.x-4.5*dot.sx, y:dot.y-4.5*dot.sy,
                                    width:9*dot.sx, height:9*dot.sy)
                context.fill(Path(ellipseIn: bounds), with: .color(MobileDesignColors.brandDot.opacity(ease(t/0.12))))
            }
        }
    }

    private func x(_ index: Int) -> CGFloat { 24 + widths.prefix(index).reduce(0, +) }
    private func dotPose(t: Double, settle: Double) -> DotPose {
        var dot = DotPose(x: 9, y: 110, sx: 1, sy: 1)
        for i in 0..<10 {
            let end = 0.19 + Double(i) * 0.048
            let begin = i == 0 ? end - 0.065 : end - 0.048
            let from = i == 0 ? 9 : x(i) + 10
            let to = x(i+1) + 10
            if t >= end { dot.x = to; continue }
            if t >= begin {
                let step = max(0, min(1, (t-begin)/(end-begin)))
                let hop = max(0, min(1, (step-0.16)/0.84))
                let squash = sin(max(0, min(1, step/0.16)) * .pi)
                dot.x = from + (to-from)*smooth(hop)
                dot.y -= 4*hop*(1-hop)*(i == 0 ? 20 : 15)
                dot.sx = 1+0.2*squash; dot.sy = 1-0.18*squash
            }
            break
        }
        if t >= 0.70 {
            let flight = max(0, min(1, (t-0.70)/0.16))
            let travel = smooth(flight)
            dot.x += (x(5)+5-dot.x)*travel
            dot.y = 110-15*travel-sin(.pi*flight)*44
            dot.sx = 1+(7.35/9-1)*travel; dot.sy = dot.sx
            if t > 0.86 && t < 0.9 { dot.y -= sin((t-0.86)/0.04 * .pi)*2 }
        }
        dot.y += 42*settle
        return dot
    }
    private struct DotPose { var x: CGFloat; var y: CGFloat; var sx: CGFloat; var sy: CGFloat }
    private func smooth(_ x: Double) -> Double { let v=max(0,min(1,x));return v*v*(3-2*v) }
    private func ease(_ x: Double) -> Double { 1-pow(1-max(0,min(1,x)),3) }
}


/// Same fixed contour ribbon as desktop AboutBrandMark, with slow highlights.
struct WelcomeBrandFlowView: View {
    var sweep = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    private static let contours: [(Path, CGFloat)] = (0..<15).map { index in
        let progress = CGFloat(index) / 14
        let radius = 79 + 23 * progress
        let angle = (-60 - 30 * progress) * .pi / 180
        let vertices = (0..<6).map { vertex in
            CGPoint(x: 128 + radius * cos(angle + CGFloat(vertex) * .pi / 3),
                    y: 128 + radius * sin(angle + CGFloat(vertex) * .pi / 3))
        }
        var path = Path()
        for i in 0..<6 {
            let vertex = vertices[i], previous = vertices[(i+5)%6], next = vertices[(i+1)%6]
            let entry = CGPoint(x: vertex.x+(previous.x-vertex.x)*0.16,y: vertex.y+(previous.y-vertex.y)*0.16)
            let exit = CGPoint(x: vertex.x+(next.x-vertex.x)*0.16,y: vertex.y+(next.y-vertex.y)*0.16)
            if i == 0 { path.move(to: entry) } else { path.addLine(to: entry) }
            path.addQuadCurve(to: exit, control: vertex)
        }
        path.closeSubpath()
        return (path,radius*5.83080081501503)
    }
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0/30, paused: reduceMotion || scenePhase != .active)) { timeline in
            let phase = timeline.date.timeIntervalSince1970.truncatingRemainder(dividingBy: 18)/18
            Canvas { context,size in
                context.scaleBy(x: size.width/256,y: size.height/256)
                for (index,contour) in Self.contours.enumerated() {
                    if sweep {
                        let progress = timeline.date.timeIntervalSince1970.truncatingRemainder(dividingBy: 5)/5
                        let shift = reduceMotion ? 0 : (min(1, progress/0.75)*2-1)*256
                        let stops: [Gradient.Stop] = [
                            .init(color: OpenBitFunTheme.ink.opacity(0.16), location: 0),
                            .init(color: OpenBitFunTheme.ink.opacity(0.25), location: 0.46),
                            .init(color: OpenBitFunTheme.ink, location: 0.55),
                            .init(color: OpenBitFunTheme.ink.opacity(0.25), location: 0.65),
                            .init(color: OpenBitFunTheme.ink.opacity(0.16), location: 1)
                        ]
                        context.stroke(contour.0, with: .linearGradient(Gradient(stops: stops),
                            startPoint: CGPoint(x: shift, y: shift), endPoint: CGPoint(x: shift+256, y: shift+256)), lineWidth: 1.45)
                        continue
                    }
                    context.stroke(contour.0,with: .color(OpenBitFunTheme.ink.opacity(0.25)),lineWidth: 1)
                    if !reduceMotion {
                        for (layer,length) in [0.34,0.26,0.18].enumerated() {
                            let total=contour.1
                            context.stroke(contour.0,with: .color(OpenBitFunTheme.ink.opacity([0.12,0.14,0.36][layer])),
                                style: StrokeStyle(lineWidth: 1,dash: [total*length/2,total*(1-length),total*length/2,0],dashPhase: -total*(phase+Double(index)*0.03)))
                        }
                    }
                }
            }
        }.accessibilityHidden(true)
    }
}
