import SwiftUI

struct RelaySignalMark: View {
    var body: some View {
        Canvas { context, size in
            let bridge = CGRect(
                x: size.width * 0.25,
                y: size.height * 0.43,
                width: size.width * 0.5,
                height: size.height * 0.17
            )
            context.fill(
                Path(roundedRect: bridge, cornerRadius: bridge.height / 2),
                with: .color(.calmSage)
            )

            let lineWidth = min(size.width, size.height) * 0.09
            context.stroke(
                RelaySignalArc(inset: size.width * 0.12).path(in: CGRect(origin: .zero, size: size)),
                with: .color(.calmSage),
                style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
            )
            context.stroke(
                RelaySignalArc(inset: size.width * 0.28).path(in: CGRect(origin: .zero, size: size)),
                with: .color(.calmSage.opacity(0.68)),
                style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
            )
        }
        .containerRelativeFrame([.horizontal, .vertical]) { length, _ in length }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityLabel("Relay")
    }
}

private struct RelaySignalArc: Shape {
    let inset: CGFloat

    func path(in rect: CGRect) -> Path {
        let radius = min(rect.width, rect.height) / 2 - inset
        let center = CGPoint(x: rect.midX, y: rect.midY)
        var path = Path()
        path.addArc(
            center: center,
            radius: radius,
            startAngle: .degrees(205),
            endAngle: .degrees(335),
            clockwise: false
        )
        return path
    }
}

private struct RelaySignalMarkPreview: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        VStack(spacing: 28) {
            HStack(alignment: .bottom, spacing: 20) {
                mark(at: 32)
                mark(at: 64)
                mark(at: 160)
            }

            HStack(spacing: 12) {
                swatch(.calmSage)
                swatch(.calmCanvas)
                swatch(.calmCard)
                swatch(.calmStone)
            }
        }
        .padding(32)
        .background(reduceTransparency ? Color.calmCanvas : Color.calmCanvas.opacity(0.88))
    }

    private func mark(at size: CGFloat) -> some View {
        RelaySignalMark()
            .frame(width: size, height: size)
            .padding(size * 0.12)
            .background(Color.calmCard, in: RoundedRectangle(cornerRadius: size * 0.22))
    }

    private func swatch(_ color: Color) -> some View {
        RoundedRectangle(cornerRadius: 10)
            .fill(color)
            .frame(width: 52, height: 52)
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(.primary.opacity(0.12)))
    }
}

#Preview("Light") {
    RelaySignalMarkPreview()
        .environment(\.colorScheme, .light)
}

#Preview("Dark") {
    RelaySignalMarkPreview()
        .environment(\.colorScheme, .dark)
}

#Preview("Increased Contrast") {
    RelaySignalMarkPreview()
        .environment(\._colorSchemeContrast, .increased)
}

#Preview("Reduce Transparency") {
    RelaySignalMarkPreview()
        .environment(\._accessibilityReduceTransparency, true)
}
