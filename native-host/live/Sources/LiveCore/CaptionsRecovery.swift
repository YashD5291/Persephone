import Foundation

/// Decides what to do next when Live Captions should be running but its panel
/// is not there. Pure logic, so every awkward state MacWhisper can be in is
/// covered by tests instead of by hope.
///
/// The control for Live Captions is a toggle (a button, or MacWhisper's own
/// keyboard shortcut). Pressing it twice in a row would switch captions on and
/// straight off again, so the planner never toggles again until the first
/// press has had time to work, and stops altogether after a few failures
/// rather than flip MacWhisper on and off for the whole call.
public struct CaptionsRecovery {
    public enum Step: Equatable {
        /// Something is already under way; look again shortly.
        case wait
        /// MacWhisper is not running: start it.
        case launchApp
        /// The Live Captions button on MacWhisper's home screen is reachable: press it.
        case pressButton
        /// Use the keyboard shortcut recorded in MacWhisper's Live Captions settings.
        case pressShortcut
        /// MacWhisper is running with no window: bring the window back.
        case reopenWindow
        /// MacWhisper's window shows another screen: go back to its home screen.
        case selectHome
        /// Several toggles produced no captions. Stop, and tell the user.
        case giveUp
    }

    public struct Situation: Equatable {
        public var appRunning: Bool
        public var hasMainWindow: Bool
        public var buttonReachable: Bool
        public var shortcutSet: Bool

        public init(appRunning: Bool, hasMainWindow: Bool, buttonReachable: Bool, shortcutSet: Bool) {
            self.appRunning = appRunning
            self.hasMainWindow = hasMainWindow
            self.buttonReachable = buttonReachable
            self.shortcutSet = shortcutSet
        }
    }

    public struct Timing {
        /// After a toggle, how long to wait for the panel. Loading the model takes a second or two.
        public var toggleGrace: TimeInterval = 6
        /// Shortest time between two toggles.
        public var toggleRetry: TimeInterval = 20
        /// After starting MacWhisper, how long to let it finish launching.
        public var launchGrace: TimeInterval = 5
        /// Shortest time between two launch attempts.
        public var launchRetry: TimeInterval = 30
        /// Shortest time between two "make the button reachable" steps.
        public var stepInterval: TimeInterval = 2
        /// Toggles in a row without a panel appearing before giving up.
        public var maximumToggles = 3
        /// Attempts to make the button reachable (reopen the window, go to the
        /// home screen) before concluding that it cannot be reached.
        public var maximumSteps = 5
        /// Captions that were running must be seen gone for this long before
        /// they are started again. One missed reading (MacWhisper busy for a
        /// moment) must not be answered with a toggle, because the toggle
        /// would switch off captions that are in fact still running.
        public var goneConfirmation: TimeInterval = 2

        public init() {}
    }

    private let timing: Timing
    private var lastToggleAt = -Double.infinity
    private var lastLaunchAt = -Double.infinity
    private var lastStepAt = -Double.infinity
    private var togglesWithoutPanel = 0
    private var stepsWithoutButton = 0
    /// The panel has been seen since the last toggle, so that toggle is finished.
    private var lastToggleSucceeded = false
    /// When the panel, having been seen, was first found missing.
    private var missingSince: TimeInterval?

    public init(timing: Timing = Timing()) {
        self.timing = timing
    }

    /// The captions panel is there: whatever was tried, it worked.
    public mutating func panelSeen() {
        togglesWithoutPanel = 0
        stepsWithoutButton = 0
        lastToggleSucceeded = true
        missingSince = nil
    }

    /// Live text was switched on again by the user: start with a clean slate.
    public mutating func reset() {
        self = CaptionsRecovery(timing: timing)
    }

    /// A toggle was sent to stop captions on purpose; it must not count as a failed start.
    public mutating func captionsStoppedOnPurpose() {
        lastToggleAt = -Double.infinity
        togglesWithoutPanel = 0
        lastToggleSucceeded = false
        missingSince = nil
    }

    public mutating func next(_ situation: Situation, now: TimeInterval) -> Step {
        guard situation.appRunning else {
            guard now - lastLaunchAt >= timing.launchRetry else { return .wait }
            lastLaunchAt = now
            return .launchApp
        }
        if now - lastLaunchAt < timing.launchGrace { return .wait }

        // Captions were up and are now missing (closed by hand, or MacWhisper
        // stopped them). Once that is confirmed there is no start in progress
        // to collide with, so they can be started again without the long
        // wait that protects a first start.
        if lastToggleSucceeded {
            let since = missingSince ?? now
            missingSince = since
            if now - since < timing.goneConfirmation { return .wait }
            lastToggleSucceeded = false
            lastToggleAt = -Double.infinity
        }

        if now - lastToggleAt < timing.toggleGrace { return .wait }
        if togglesWithoutPanel >= timing.maximumToggles { return .giveUp }

        // MacWhisper's own shortcut goes first when one is recorded: it works
        // whatever MacWhisper's window is showing, or with the window closed,
        // and it is the quickest (captions up in about 1.2 s, against 2 to 3 s
        // through the button). If a shortcut press produced nothing, the next
        // try uses the button, so one broken control cannot use up every attempt.
        let shortcutsTurn = situation.shortcutSet && togglesWithoutPanel % 2 == 0
        if situation.buttonReachable { stepsWithoutButton = 0 }
        let buttonGivenUp = !situation.buttonReachable && stepsWithoutButton >= timing.maximumSteps

        if shortcutsTurn || situation.buttonReachable || (situation.shortcutSet && buttonGivenUp) {
            guard now - lastToggleAt >= timing.toggleRetry else { return .wait }
            lastToggleAt = now
            togglesWithoutPanel += 1
            missingSince = nil
            return (shortcutsTurn || !situation.buttonReachable) ? .pressShortcut : .pressButton
        }

        // No usable control yet: make the button reachable, a step at a time,
        // but not forever. If MacWhisper's window has changed so that the
        // button is no longer where it was, say so instead of "starting…" all call.
        if buttonGivenUp { return .giveUp }
        guard now - lastStepAt >= timing.stepInterval else { return .wait }
        lastStepAt = now
        stepsWithoutButton += 1
        return situation.hasMainWindow ? .selectHome : .reopenWindow
    }
}
