// persephone-live: streams the text of MacWhisper's Live Captions panel to the
// Persephone extension while someone is talking, so the question is already in
// the chat box by the time the user presses send.
//
// Runs as a Chrome native messaging host (started by the extension, talks JSON
// over stdin/stdout). MacWhisper still does all the transcription; this only
// reads what it shows.
//
//   extension -> host   {"cmd": "mark"}   start a new question and keep streaming
//                       {"cmd": "pause"}  stop reading until the next mark
//                       {"cmd": "notify", "text": "Sent", "tone": "confirmation" | "problem", "seconds": 1.5}
//                                         flash a short message on the status pill
//   host -> extension   {"type": "text", "text": "..."}     question so far
//                       {"type": "status", "state": "...", "source": "Loopback Audio"}
//                                         see CaptionState; source only with "ready"
//
// Run with --print in a terminal to watch it without Chrome.

import AppKit
import ApplicationServices
import Foundation
import LiveCore

// MARK: - Configuration

enum Config {
    static let macWhisperBundleID = "com.goodsnooze.MacWhisper"
    /// MacWhisper's name as it appears in its own Window menu.
    static let macWhisperName = "MacWhisper"
    /// Accessibility identifier of MacWhisper's main window.
    static let mainWindowIdentifier = "mainWindowID"
    /// Accessibility description of the button on MacWhisper's home screen that
    /// switches Live Captions on and off.
    static let liveCaptionsButton = "Live Captions"
    /// Accessibility description of the sidebar entry that shows the home screen.
    static let homeSidebarItem = "Home"

    /// How often the panel is read while a question is open. One read costs about 3 ms.
    static let pollInterval: TimeInterval = 0.04
    /// How often to look again, and take the next recovery step, while captions are not running.
    static let retryInterval: TimeInterval = 1.0
    /// Longest MacWhisper may take to answer one accessibility request. The
    /// system default is several seconds, long enough to freeze the status pill.
    static let accessibilityTimeout: Float = 1.0
    static let maxTreeDepth = 14
    /// Where the captions panel is sent so it is out of the way. Far beyond any
    /// screen on purpose: macOS pulls it back until a thin strip is still on
    /// the bottom-right edge, which is as hidden as a window can get while
    /// MacWhisper keeps updating it.
    static let parkedPanelOrigin = CGPoint(x: 100_000, y: 100_000)
    /// How much of the end of MacWhisper's log is searched for the caption source.
    static let logTailBytes: UInt64 = 256 * 1024
    /// MacWhisper writes the source to its log just after the panel appears; wait this long before reading it.
    static let sourceReportDelay: TimeInterval = 1.0
    /// MacWhisper comes to the front when it launches or starts captions.
    /// These are the moments (seconds after asking it to) at which focus is
    /// handed back if it did. Several, because it can take a few seconds.
    static let refocusChecks: [TimeInterval] = [0.3, 0.7, 1.2, 2, 3, 5]
}

enum CaptionState: String {
    case ready                  // panel found, text is being read
    case captionsStarting = "captions_starting"   // this helper is getting Live Captions running
    case captionsOff = "captions_off"             // it tried and could not
    case macWhisperNotRunning = "macwhisper_not_running"   // and could not be started
    case noAccessibility = "no_accessibility"
}

func log(_ message: String) {
    FileHandle.standardError.write("[persephone-live] \(message)\n".data(using: .utf8)!)
}

// MARK: - Host

final class Host {
    private let captions = MacWhisperCaptions()
    private var stitcher = CaptionStitcher()
    private let queue = DispatchQueue(label: "persephone.live")
    private var timer: DispatchSourceTimer?
    private var state: CaptionState?
    private var streaming = false
    /// When to look up and report the caption audio source after captions come up.
    private var sourceDueAt: Date?
    /// On-screen indicator. Created and touched on the main thread only.
    private var pill: StatusPill?
    private let printMode: Bool
    private let started = Date()

    init(printMode: Bool) {
        self.printMode = printMode
    }

    func run() -> Never {
        // An accessory app: it can put the status pill on screen but has no
        // Dock icon, no menu bar, and never takes focus.
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        pill = StatusPill()

        if printMode {
            queue.async { self.handle(["cmd": "mark"]) }
        } else {
            readCommands()
        }
        app.run()
        exit(0)
    }

    private func readCommands() {
        var buffer = Data()
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else {
                // Chrome closed the port: the extension is gone, so are we.
                exit(0)
            }
            buffer.append(chunk)
            let messages = NativeMessaging.decodeAvailable(&buffer)
            self?.queue.async { messages.forEach { self?.handle($0) } }
        }
    }

    private func handle(_ message: [String: Any]) {
        switch message["cmd"] as? String {
        case "mark":
            stitcher.startQuestion()
            // Live text going from off to on is the user asking again: earlier
            // failures to start captions no longer count.
            if !streaming { captions.liveTextSwitchedOn() }
            streaming = true
            startPolling(every: Config.pollInterval)
            send(["type": "text", "text": ""])
            refreshPill()
            poll()
        case "pause":
            streaming = false
            timer?.cancel()
            timer = nil
            captions.stopLiveCaptionsIfStartedHere()
            state = nil
            refreshPill()
        case "notify":
            let text = (message["text"] as? String) ?? ""
            let tone: StatusPill.Tone = (message["tone"] as? String) == "problem" ? .problem : .confirmation
            let seconds = (message["seconds"] as? NSNumber)?.doubleValue ?? 1.5
            DispatchQueue.main.async { self.pill?.flash(tone, text, seconds: seconds) }
        default:
            log("ignoring unknown message")
        }
    }

    private func startPolling(every interval: TimeInterval) {
        timer?.cancel()
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + interval, repeating: interval)
        source.setEventHandler { [weak self] in self?.poll() }
        source.resume()
        timer = source
    }

    private func poll() {
        guard streaming else { return }
        let (newState, text) = captions.read()
        if newState != state {
            state = newState
            send(["type": "status", "state": newState.rawValue])
            sourceDueAt = newState == .ready ? Date().addingTimeInterval(Config.sourceReportDelay) : nil
            // No point reading 25 times a second while there is nothing to read.
            startPolling(every: newState == .ready ? Config.pollInterval : Config.retryInterval)
            refreshPill()
        }
        if let due = sourceDueAt, Date() >= due {
            // Tell the extension which audio source captions are listening to,
            // so the wrong one cannot go unnoticed.
            sourceDueAt = nil
            if let source = captions.captionSource() { send(["type": "status", "state": "ready", "source": source]) }
        }
        guard newState == .ready, stitcher.ingest(text, at: ProcessInfo.processInfo.systemUptime) else { return }
        send(["type": "text", "text": stitcher.questionText])
        refreshPill()
    }

    /// Bring the status pill in line with what is happening. Called on `queue`.
    private func refreshPill() {
        let streaming = self.streaming
        let state = self.state
        let question = stitcher.questionText
        DispatchQueue.main.async {
            guard let pill = self.pill else { return }
            if !streaming {
                pill.hide()
            } else if state == .captionsStarting {
                pill.show(.live, PillText.startingCaptions)
            } else if let state, state != .ready {
                pill.show(.problem, PillText.problem(state.rawValue))
            } else {
                pill.show(.live, PillText.question(question))
            }
        }
    }

    private func send(_ message: [String: Any]) {
        if printMode {
            let elapsed = String(format: "%7.2fs", Date().timeIntervalSince(started))
            let detail = message["text"] ?? message["state"] ?? ""
            let source = (message["source"] as? String).map { "  (source: \($0))" } ?? ""
            print("\(elapsed)  \(message["type"] ?? "")  \(detail)\(source)")
            fflush(stdout)
            return
        }
        guard let framed = NativeMessaging.encode(message) else {
            log("dropping a message that is too large for Chrome")
            return
        }
        FileHandle.standardOutput.write(framed)
    }
}

Host(printMode: CommandLine.arguments.contains("--print")).run()
