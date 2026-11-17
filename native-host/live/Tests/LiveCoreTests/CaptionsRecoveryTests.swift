import XCTest
@testable import LiveCore

final class CaptionsRecoveryTests: XCTestCase {
    private typealias Step = CaptionsRecovery.Step

    private func situation(running: Bool = true, window: Bool = true, button: Bool = true, shortcut: Bool = false) -> CaptionsRecovery.Situation {
        .init(appRunning: running, hasMainWindow: window, buttonReachable: button, shortcutSet: shortcut)
    }

    func testButtonOnTheHomeScreenIsPressedStraightAway() {
        var recovery = CaptionsRecovery()
        XCTAssertEqual(recovery.next(situation(), now: 0), .pressButton)
    }

    func testAfterAPressItWaitsForThePanelInsteadOfPressingAgain() {
        // The control is a toggle: a second press would switch captions off again.
        var recovery = CaptionsRecovery()
        _ = recovery.next(situation(), now: 0)
        for second in 1...19 {
            XCTAssertEqual(recovery.next(situation(), now: Double(second)), .wait, "at \(second) s")
        }
        XCTAssertEqual(recovery.next(situation(), now: 20), .pressButton)
    }

    func testGivesUpAfterRepeatedPressesProduceNoCaptions() {
        // E.g. a MacWhisper update changed the panel so it is no longer recognised.
        // Flipping captions on and off for the rest of the call would be worse than stopping.
        var recovery = CaptionsRecovery()
        var presses = 0
        for second in stride(from: 0.0, through: 200, by: 1) {
            let step = recovery.next(situation(), now: second)
            if step == .pressButton { presses += 1 }
            if step == .giveUp { break }
        }
        XCTAssertEqual(presses, 3)
        XCTAssertEqual(recovery.next(situation(), now: 300), .giveUp)
    }

    func testSeeingThePanelClearsTheFailureCount() {
        var recovery = CaptionsRecovery()
        _ = recovery.next(situation(), now: 0)
        _ = recovery.next(situation(), now: 20)
        recovery.panelSeen()
        // Captions later stop (the user closed the panel): they may be started again, three more times.
        var presses = 0
        for second in stride(from: 100.0, through: 300, by: 1) {
            let step = recovery.next(situation(), now: second)
            if step == .pressButton { presses += 1 }
            if step == .giveUp { break }
        }
        XCTAssertEqual(presses, 3)
    }

    func testCaptionsClosedMidCallAreBackWithinSeconds() {
        // The helper started captions two seconds ago; the user closes the panel by accident.
        var recovery = CaptionsRecovery()
        XCTAssertEqual(recovery.next(situation(), now: 0), .pressButton)
        recovery.panelSeen()                                   // came up at 2 s
        XCTAssertEqual(recovery.next(situation(), now: 3), .wait, "first sighting of it missing")
        XCTAssertEqual(recovery.next(situation(), now: 4), .wait)
        XCTAssertEqual(recovery.next(situation(), now: 5), .pressButton, "confirmed gone for 2 s: start it again")
    }

    func testOneMissedReadingDoesNotToggleRunningCaptionsOff() {
        // MacWhisper was busy for one reading and the panel was not found. It is
        // still running: pressing the toggle now would switch it OFF.
        var recovery = CaptionsRecovery()
        _ = recovery.next(situation(), now: 0)
        recovery.panelSeen()
        XCTAssertEqual(recovery.next(situation(), now: 30.00), .wait)
        recovery.panelSeen()                                   // found again 40 ms later
        XCTAssertEqual(recovery.next(situation(), now: 60.00), .wait, "a later blip starts its own confirmation period")
        recovery.panelSeen()
    }

    func testAfterRestartingMidCallItStillWaitsForThePanel() {
        var recovery = CaptionsRecovery()
        _ = recovery.next(situation(), now: 0)
        recovery.panelSeen()
        _ = recovery.next(situation(), now: 10)
        XCTAssertEqual(recovery.next(situation(), now: 12), .pressButton)
        for second in 13...17 {
            XCTAssertEqual(recovery.next(situation(), now: Double(second)), .wait, "no second press while it starts, at \(second) s")
        }
    }

    func testSwitchingLiveTextOnAgainRetriesAfterGivingUp() {
        var recovery = CaptionsRecovery()
        for second in stride(from: 0.0, through: 100, by: 1) { _ = recovery.next(situation(), now: second) }
        XCTAssertEqual(recovery.next(situation(), now: 101), .giveUp)
        recovery.reset()
        XCTAssertEqual(recovery.next(situation(), now: 102), .pressButton)
    }

    func testMacWhisperNotRunningIsStartedThenGivenTimeToLaunch() {
        var recovery = CaptionsRecovery()
        XCTAssertEqual(recovery.next(situation(running: false, window: false, button: false), now: 0), .launchApp)
        XCTAssertEqual(recovery.next(situation(running: false, window: false, button: false), now: 1), .wait, "launch already requested")
        // It is up, but still opening its window.
        XCTAssertEqual(recovery.next(situation(window: false, button: false), now: 3), .wait)
        XCTAssertEqual(recovery.next(situation(), now: 6), .pressButton)
    }

    func testLaunchIsNotRepeatedWhileMacWhisperStaysDown() {
        var recovery = CaptionsRecovery()
        var launches = 0
        for second in stride(from: 0.0, to: 60, by: 1) {
            if recovery.next(situation(running: false, window: false, button: false), now: second) == .launchApp { launches += 1 }
        }
        XCTAssertEqual(launches, 2, "once at the start and once after 30 s")
    }

    func testClosedWindowWithoutAShortcutIsReopenedThenTheButtonPressed() {
        var recovery = CaptionsRecovery()
        XCTAssertEqual(recovery.next(situation(window: false, button: false), now: 0), .reopenWindow)
        XCTAssertEqual(recovery.next(situation(window: false, button: false), now: 1), .wait)
        XCTAssertEqual(recovery.next(situation(), now: 2), .pressButton)
    }

    func testWindowOnAnotherScreenIsSentHomeThenTheButtonPressed() {
        var recovery = CaptionsRecovery()
        XCTAssertEqual(recovery.next(situation(button: false), now: 0), .selectHome)
        XCTAssertEqual(recovery.next(situation(), now: 1), .pressButton)
    }

    func testShortcutIsUsedWhenTheButtonCannotBeReached() {
        // With a shortcut recorded there is no need to move MacWhisper's window around.
        var recovery = CaptionsRecovery()
        XCTAssertEqual(recovery.next(situation(window: false, button: false, shortcut: true), now: 0), .pressShortcut)
    }

    func testRecordedShortcutIsTheFirstChoice() {
        // It does not depend on what MacWhisper's window is showing, and it is the quickest.
        var recovery = CaptionsRecovery()
        XCTAssertEqual(recovery.next(situation(shortcut: true), now: 0), .pressShortcut)
    }

    func testButtonIsTriedWhenTheShortcutDidNothing() {
        // The shortcut was removed or clashes with something: one broken control must not use up every attempt.
        var recovery = CaptionsRecovery()
        XCTAssertEqual(recovery.next(situation(shortcut: true), now: 0), .pressShortcut)
        XCTAssertEqual(recovery.next(situation(shortcut: true), now: 20), .pressButton)
        XCTAssertEqual(recovery.next(situation(shortcut: true), now: 40), .pressShortcut)
        XCTAssertEqual(recovery.next(situation(shortcut: true), now: 60), .giveUp)
    }

    func testGivesUpWhenTheButtonNeverBecomesReachable() {
        // E.g. a MacWhisper update moved or renamed the button and no shortcut is recorded.
        // "Starting…" for the whole call would hide that; say so instead.
        var recovery = CaptionsRecovery()
        var steps: [Step] = []
        for second in stride(from: 0.0, through: 60, by: 1) {
            let step = recovery.next(situation(button: false), now: second)
            if step != .wait { steps.append(step) }
            if step == .giveUp { break }
        }
        XCTAssertEqual(steps, [.selectHome, .selectHome, .selectHome, .selectHome, .selectHome, .giveUp])
    }

    func testUnreachableButtonFallsBackToTheShortcutAgain() {
        // Shortcut failed once, the button cannot be reached: the shortcut is still the only control there is.
        var recovery = CaptionsRecovery()
        XCTAssertEqual(recovery.next(situation(window: false, button: false, shortcut: true), now: 0), .pressShortcut)
        var steps: [Step] = []
        for second in stride(from: 6.0, through: 60, by: 1) {
            let step = recovery.next(situation(window: false, button: false, shortcut: true), now: second)
            if step != .wait { steps.append(step) }
            if step == .pressShortcut { break }
        }
        XCTAssertEqual(steps.last, .pressShortcut)
        XCTAssertTrue(steps.dropLast().allSatisfy { $0 == .reopenWindow })
    }

    func testStoppingCaptionsOnPurposeDoesNotDelayTheNextStart() {
        var recovery = CaptionsRecovery()
        _ = recovery.next(situation(), now: 0)
        recovery.panelSeen()
        recovery.captionsStoppedOnPurpose()   // live text switched off at 50 s
        XCTAssertEqual(recovery.next(situation(), now: 52), .pressButton, "switched on again two seconds later")
    }
}
