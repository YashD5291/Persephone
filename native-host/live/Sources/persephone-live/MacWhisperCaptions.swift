import AppKit
import ApplicationServices
import Foundation
import LiveCore

// MARK: - Accessibility helpers

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String {
    (attribute(element, name) as? String) ?? ""
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

/// Depth-first search for the first element that passes `test`.
func firstElement(in root: AXUIElement, maxDepth: Int, where test: (AXUIElement) -> Bool) -> AXUIElement? {
    func search(_ element: AXUIElement, _ depth: Int) -> AXUIElement? {
        if test(element) { return element }
        guard depth < maxDepth else { return nil }
        for child in children(element) {
            if let found = search(child, depth + 1) { return found }
        }
        return nil
    }
    return search(root, 0)
}

func staticTexts(in element: AXUIElement, depth: Int = 0) -> [String] {
    var found: [String] = []
    if stringAttribute(element, kAXRoleAttribute) == (kAXStaticTextRole as String) {
        let value = stringAttribute(element, kAXValueAttribute)
        if !value.isEmpty { found.append(value) }
    }
    if depth < Config.maxTreeDepth {
        for child in children(element) { found += staticTexts(in: child, depth: depth + 1) }
    }
    return found
}

// MARK: - MacWhisper Live Captions

/// Reads MacWhisper's Live Captions and keeps them running.
///
/// MacWhisper offers no command, link or script hook for Live Captions, so the
/// only way in is its user interface. That makes this the fragile part of the
/// system, and the class is written around that: every state MacWhisper can be
/// in (not running, window closed, another screen showing, panel closed by
/// hand mid-call, slow to answer) has a defined way back, decided by
/// `CaptionsRecovery`, and each way back is a single small step taken on one
/// poll so that a step that does not work is simply followed by the next.
///
/// Called from one serial queue only.
final class MacWhisperCaptions {
    private var app: AXUIElement?
    private var pid: pid_t = 0
    private var recovery = CaptionsRecovery()
    private var lastAccessibilityRequest = Date.distantPast
    private var panelIsParked = false
    private var askedForPermission = false
    /// True while Live Captions is running because this helper switched it on.
    private var startedCaptions = false
    /// What the last successful reading found, repeated when MacWhisper does not answer.
    private var lastState: CaptionState?
    private var lastText = ""

    /// Live text was switched on by the user: forget earlier failures and try afresh.
    func liveTextSwitchedOn() {
        recovery.reset()
    }

    /// Current panel text, or the reason there is none. When captions are not
    /// running this also takes one step towards getting them running.
    func read() -> (state: CaptionState, text: String) {
        guard AXIsProcessTrusted() else {
            askForAccessibilityPermission()
            return (.noAccessibility, "")
        }

        let now = ProcessInfo.processInfo.systemUptime
        guard let app = connectedApp() else {
            let step = recovery.next(.init(appRunning: false, hasMainWindow: false, buttonReachable: false,
                                           shortcutSet: false), now: now)
            if step == .launchApp { return (launchMacWhisper() ? .captionsStarting : .macWhisperNotRunning, "") }
            return (.captionsStarting, "")
        }

        // No answer (MacWhisper busy, request timed out) is not the same as
        // "no captions panel". Acting on it could toggle running captions off.
        guard let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] else {
            return (lastState ?? .captionsStarting, lastText)
        }
        if let panel = captionsPanel(in: windows) {
            recovery.panelSeen()
            park(panel)
            let texts = staticTexts(in: panel)
            if texts.isEmpty { requestFullAccessibility(of: app) }
            lastState = .ready
            lastText = texts.joined(separator: " ")
            return (.ready, lastText)
        }
        panelIsParked = false
        lastState = .captionsStarting
        lastText = ""

        let main = mainWindow(in: windows)
        let button = liveCaptionsButton(in: windows)
        let shortcut = recordedShortcut()
        let step = recovery.next(.init(appRunning: true, hasMainWindow: main != nil, buttonReachable: button != nil,
                                       shortcutSet: shortcut != nil), now: now)
        if step != .wait && step != .giveUp { keepFocusWhereItIs() }
        switch step {
        case .pressButton:
            if let button, AXUIElementPerformAction(button, kAXPressAction as CFString) == .success {
                startedCaptions = true
                log("pressed MacWhisper's Live Captions button")
            }
        case .pressShortcut:
            if let shortcut {
                post(shortcut)
                startedCaptions = true
                log("sent MacWhisper's Live Captions shortcut")
            }
        case .reopenWindow:
            log(reopenMainWindow(of: app) ? "reopened MacWhisper's window" : "could not reopen MacWhisper's window")
        case .selectHome:
            if let main {
                log(selectHome(in: main) ? "sent MacWhisper back to its home screen" : "could not find MacWhisper's Home entry")
            }
        case .giveUp:
            return (.captionsOff, "")
        case .wait, .launchApp:
            break
        }
        return (.captionsStarting, "")
    }

    /// Live text was switched off: if this helper started Live Captions, stop
    /// it again so MacWhisper is not transcribing (and using battery) for nobody.
    func stopLiveCaptionsIfStartedHere() {
        guard startedCaptions, AXIsProcessTrusted(), let app = connectedApp() else { return }
        startedCaptions = false
        let windows = (attribute(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        guard captionsPanel(in: windows) != nil else { return }
        keepFocusWhereItIs()
        // Same order of preference as starting: the recorded shortcut, else the button.
        if let shortcut = recordedShortcut() {
            post(shortcut)
        } else if let button = liveCaptionsButton(in: windows) {
            AXUIElementPerformAction(button, kAXPressAction as CFString)
        } else {
            return
        }
        recovery.captionsStoppedOnPurpose()
        log("stopped Live Captions in MacWhisper")
    }

    /// The audio source captions last reported listening to, from MacWhisper's
    /// newest log file. Best effort: nil if the log is missing or worded differently.
    func captionSource() -> String? {
        let logs = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/MacWhisper/Logs")
        guard let files = try? FileManager.default.contentsOfDirectory(at: logs, includingPropertiesForKeys: [.contentModificationDateKey]),
              let newest = files.filter({ $0.pathExtension == "log" }).max(by: { modified($0) < modified($1) }),
              let handle = try? FileHandle(forReadingFrom: newest) else { return nil }
        defer { try? handle.close() }
        // The relevant line is written when captions start, so the tail is enough.
        let size = (try? handle.seekToEnd()) ?? 0
        try? handle.seek(toOffset: size > Config.logTailBytes ? size - Config.logTailBytes : 0)
        guard let data = try? handle.readToEnd() else { return nil }
        return MacWhisperSettings.captionSource(inLog: String(decoding: data, as: UTF8.self))
    }

    private func modified(_ url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    }

    // MARK: Finding things in MacWhisper

    /// MacWhisper's accessibility element, re-made if MacWhisper was restarted.
    private func connectedApp() -> AXUIElement? {
        guard let running = NSRunningApplication.runningApplications(withBundleIdentifier: Config.macWhisperBundleID).first else {
            app = nil
            return nil
        }
        if app == nil || pid != running.processIdentifier {
            pid = running.processIdentifier
            let element = AXUIElementCreateApplication(pid)
            // If MacWhisper is busy it must not be able to stall this helper
            // (and with it the status pill) for the system default of several seconds.
            AXUIElementSetMessagingTimeout(element, Config.accessibilityTimeout)
            app = element
            panelIsParked = false
        }
        return app
    }

    private func captionsPanel(in windows: [AXUIElement]) -> AXUIElement? {
        // The captions overlay is the app's only system-dialog style window.
        windows.first { stringAttribute($0, kAXSubroleAttribute) == (kAXSystemDialogSubrole as String) }
    }

    private func mainWindow(in windows: [AXUIElement]) -> AXUIElement? {
        windows.first { stringAttribute($0, kAXIdentifierAttribute) == Config.mainWindowIdentifier }
    }

    private func liveCaptionsButton(in windows: [AXUIElement]) -> AXUIElement? {
        for window in windows {
            let button = firstElement(in: window, maxDepth: 30) {
                stringAttribute($0, kAXRoleAttribute) == (kAXButtonRole as String)
                    && stringAttribute($0, kAXDescriptionAttribute) == Config.liveCaptionsButton
            }
            if let button { return button }
        }
        return nil
    }

    private func recordedShortcut() -> MacWhisperSettings.Shortcut? {
        let domain = Config.macWhisperBundleID as CFString
        guard let keys = CFPreferencesCopyKeyList(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) as? [String] else { return nil }
        var preferences: [String: Any] = [:]
        for key in keys where key.hasPrefix("KeyboardShortcuts_") {
            preferences[key] = CFPreferencesCopyAppValue(key as CFString, domain)
        }
        return MacWhisperSettings.liveCaptionsShortcut(in: preferences)
    }

    // MARK: Recovery steps

    /// Types the shortcut the user recorded in MacWhisper for Live Captions.
    private func post(_ shortcut: MacWhisperSettings.Shortcut) {
        var flags: CGEventFlags = []
        if shortcut.command { flags.insert(.maskCommand) }
        if shortcut.option { flags.insert(.maskAlternate) }
        if shortcut.control { flags.insert(.maskControl) }
        if shortcut.shift { flags.insert(.maskShift) }
        let source = CGEventSource(stateID: .hidSystemState)
        for keyDown in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: shortcut.keyCode, keyDown: keyDown)
            event?.flags = flags
            event?.post(tap: .cghidEventTap)
        }
    }

    /// MacWhisper is running with its window closed. Its Window menu keeps an
    /// entry for that window; choosing it brings the window back without
    /// bringing MacWhisper to the front.
    private func reopenMainWindow(of app: AXUIElement) -> Bool {
        guard let menuBar = attribute(app, kAXMenuBarAttribute) else { return false }
        for menu in children(menuBar as! AXUIElement) where stringAttribute(menu, kAXTitleAttribute) == "Window" {
            for submenu in children(menu) {
                for item in children(submenu) where stringAttribute(item, kAXTitleAttribute) == Config.macWhisperName {
                    return AXUIElementPerformAction(item, kAXPressAction as CFString) == .success
                }
            }
        }
        return false
    }

    /// MacWhisper's window is showing another screen (History, a transcript…).
    /// Selecting "Home" in its sidebar puts the Live Captions button back.
    private func selectHome(in window: AXUIElement) -> Bool {
        let home = firstElement(in: window, maxDepth: 30) {
            stringAttribute($0, kAXDescriptionAttribute) == Config.homeSidebarItem
                && stringAttribute($0, kAXRoleAttribute) != (kAXButtonRole as String)
        }
        guard let home else { return false }
        // The item sits inside a sidebar row; selecting the row is what navigates.
        var node: AXUIElement? = home
        for _ in 0..<6 {
            guard let current = node else { break }
            if stringAttribute(current, kAXRoleAttribute) == (kAXRowRole as String) {
                return AXUIElementSetAttributeValue(current, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success
            }
            node = attribute(current, kAXParentAttribute).map { $0 as! AXUIElement }
        }
        return AXUIElementPerformAction(home, kAXPressAction as CFString) == .success
    }

    /// Starts MacWhisper (in the background as far as it allows).
    private func launchMacWhisper() -> Bool {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: Config.macWhisperBundleID) else {
            log("MacWhisper is not installed")
            return false
        }
        keepFocusWhereItIs()
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
            if let error { log("could not start MacWhisper: \(error.localizedDescription)") }
        }
        log("started MacWhisper")
        return true
    }

    /// MacWhisper brings itself to the front when it launches and whenever
    /// Live Captions starts. The user is in a call window at that moment and
    /// must stay there, so note which app is in front now and, for the next
    /// few seconds, put it back whenever MacWhisper has taken its place.
    private func keepFocusWhereItIs() {
        guard let previous = NSWorkspace.shared.frontmostApplication,
              previous.bundleIdentifier != Config.macWhisperBundleID else { return }
        for delay in Config.refocusChecks {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                guard !previous.isTerminated,
                      NSWorkspace.shared.frontmostApplication?.bundleIdentifier == Config.macWhisperBundleID else { return }
                // Asking through accessibility works from a background helper,
                // where a plain activate request can be ignored by macOS.
                let element = AXUIElementCreateApplication(previous.processIdentifier)
                AXUIElementSetAttributeValue(element, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
                previous.activate()
            }
        }
    }

    // MARK: Permission, panel placement, text exposure

    /// Reading another app's window needs the user's Accessibility permission.
    /// Ask macOS to show its own dialog, once: it names this helper and adds it
    /// to the list in System Settings, so the user only has to switch it on.
    private func askForAccessibilityPermission() {
        guard !askedForPermission else { return }
        askedForPermission = true
        DispatchQueue.main.async {
            let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
        }
    }

    /// Moves the panel off to the screen edge, once per time it is opened. The
    /// text is read through accessibility, so nobody needs to see the overlay.
    /// Done only once so the user can drag it back into view if they want it.
    private func park(_ panel: AXUIElement) {
        guard !panelIsParked else { return }
        panelIsParked = true
        var origin = Config.parkedPanelOrigin
        if let position = AXValueCreate(.cgPoint, &origin) {
            AXUIElementSetAttributeValue(panel, kAXPositionAttribute as CFString, position)
        }
    }

    /// MacWhisper leaves the caption text out of its accessibility tree until
    /// an assistive client announces itself; each new panel needs asking again.
    /// The call reports "unsupported" but the text appears afterwards
    /// regardless. Asking is rate limited because an empty panel (nobody
    /// talking yet) looks the same as an unexposed one.
    private func requestFullAccessibility(of app: AXUIElement) {
        guard Date().timeIntervalSince(lastAccessibilityRequest) >= Config.retryInterval else { return }
        lastAccessibilityRequest = Date()
        AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    }
}
