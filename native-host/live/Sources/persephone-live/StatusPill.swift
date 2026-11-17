import AppKit

/// A small always-on-top strip at the top of the screen that answers "is it
/// working?" while the chat tab is not in front: whether live text is on, the
/// latest words heard, and a brief confirmation when a question is sent.
///
/// It never takes focus and lets clicks pass through, so it cannot get in the
/// way of the app the user is actually working in. Main thread only.
final class StatusPill {
    enum Tone {
        case live, problem, confirmation

        var color: NSColor {
            switch self {
            case .live: return NSColor(calibratedRed: 0.93, green: 0.26, blue: 0.21, alpha: 1)
            case .problem: return NSColor(calibratedRed: 1.0, green: 0.62, blue: 0.0, alpha: 1)
            case .confirmation: return NSColor(calibratedRed: 0.20, green: 0.78, blue: 0.35, alpha: 1)
            }
        }
    }

    private enum Layout {
        static let height: CGFloat = 26
        static let padding: CGFloat = 12
        static let dotSize: CGFloat = 8
        static let dotGap: CGFloat = 8
        static let minimumWidth: CGFloat = 120
        static let maximumWidth: CGFloat = 560
        static let topMargin: CGFloat = 6
    }

    private let panel: NSPanel
    private let dot = NSView()
    private let label = NSTextField(labelWithString: "")
    /// What to go back to once a flash is over (nil = hidden).
    private var resting: (tone: Tone, text: String)?
    private var flashEnd: DispatchWorkItem?

    init() {
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: Layout.minimumWidth, height: Layout.height),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        // Stay visible on every desktop and over full-screen apps (a call window is often full screen).
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]

        let background = NSView(frame: NSRect(x: 0, y: 0, width: Layout.minimumWidth, height: Layout.height))
        background.wantsLayer = true
        background.layer?.backgroundColor = NSColor(calibratedWhite: 0.08, alpha: 0.9).cgColor
        background.layer?.cornerRadius = Layout.height / 2
        background.autoresizingMask = [.width, .height]
        panel.contentView = background

        dot.wantsLayer = true
        dot.layer?.cornerRadius = Layout.dotSize / 2
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = .white
        label.lineBreakMode = .byTruncatingHead
        label.maximumNumberOfLines = 1
        background.addSubview(dot)
        background.addSubview(label)
    }

    /// The steady state: shown until changed or hidden.
    func show(_ tone: Tone, _ text: String) {
        resting = (tone, text)
        if flashEnd == nil { render(tone, text) }
    }

    /// A short confirmation over the steady state, e.g. "Sent".
    func flash(_ tone: Tone, _ text: String, seconds: TimeInterval = 1.5) {
        flashEnd?.cancel()
        render(tone, text)
        let end = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.flashEnd = nil
            if let resting = self.resting { self.render(resting.tone, resting.text) } else { self.panel.orderOut(nil) }
        }
        flashEnd = end
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: end)
    }

    func hide() {
        resting = nil
        if flashEnd == nil { panel.orderOut(nil) }
    }

    private func render(_ tone: Tone, _ text: String) {
        label.stringValue = text
        dot.layer?.backgroundColor = tone.color.cgColor

        // A label's own size estimate runs a few points short of what it needs to draw
        // without truncating, so measure the string and leave a little room.
        let textWidth = ceil(label.attributedStringValue.size().width) + 8
        let chrome = Layout.padding * 2 + Layout.dotSize + Layout.dotGap
        let width = min(max(textWidth + chrome, Layout.minimumWidth), Layout.maximumWidth)
        let labelHeight = ceil(label.intrinsicContentSize.height)
        dot.frame = NSRect(x: Layout.padding, y: (Layout.height - Layout.dotSize) / 2, width: Layout.dotSize, height: Layout.dotSize)
        label.frame = NSRect(x: Layout.padding + Layout.dotSize + Layout.dotGap, y: (Layout.height - labelHeight) / 2,
                             width: width - chrome, height: labelHeight)

        // Top centre of the screen the user is working on, just under the menu bar.
        let screen = NSScreen.main ?? NSScreen.screens.first
        let area = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        panel.setFrame(NSRect(x: area.midX - width / 2, y: area.maxY - Layout.height - Layout.topMargin,
                              width: width, height: Layout.height), display: true)
        panel.orderFrontRegardless()
    }
}
