import XCTest
@testable import LiveCore

final class MacWhisperSettingsTests: XCTestCase {
    func testReadsTheRecordedLiveCaptionsShortcut() {
        // Control+Option+Command+L as MacWhisper's recorder stores it.
        let preferences: [String: Any] = [
            "KeyboardShortcuts_customDictationActivationKey": "{\"carbonModifiers\":0,\"carbonKeyCode\":96}",
            "KeyboardShortcuts_toggleLiveCaptions": "{\"carbonKeyCode\":37,\"carbonModifiers\":6400}",
        ]
        let shortcut = MacWhisperSettings.liveCaptionsShortcut(in: preferences)

        XCTAssertEqual(shortcut?.keyCode, 37)
        XCTAssertEqual(shortcut?.command, true)
        XCTAssertEqual(shortcut?.option, true)
        XCTAssertEqual(shortcut?.control, true)
        XCTAssertEqual(shortcut?.shift, false)
    }

    func testReadsTheShortcutUnderTheNameMacWhisperActuallyUses() {
        // Exactly what MacWhisper 15.5 stored after recording Control+Option+Command+L.
        let preferences: [String: Any] = [
            "KeyboardShortcuts_customDictationActivationKey": "{\"carbonModifiers\":0,\"carbonKeyCode\":96}",
            "KeyboardShortcuts_streamingOverlayActivation": "{\"carbonKeyCode\":37,\"carbonModifiers\":6400}",
        ]
        let shortcut = MacWhisperSettings.liveCaptionsShortcut(in: preferences)

        XCTAssertEqual(shortcut, .init(keyCode: 37, command: true, option: true, control: true, shift: false))
    }

    func testTheDictationKeyIsNeverMistakenForTheCaptionsShortcut() {
        // Pressing it would start a dictation instead of captions.
        let preferences: [String: Any] = ["KeyboardShortcuts_customDictationActivationKey": "{\"carbonModifiers\":0,\"carbonKeyCode\":96}"]
        XCTAssertNil(MacWhisperSettings.liveCaptionsShortcut(in: preferences))
    }

    func testNoShortcutRecordedMeansNone() {
        XCTAssertNil(MacWhisperSettings.liveCaptionsShortcut(in: ["dictationEnabled": true]))
        XCTAssertNil(MacWhisperSettings.liveCaptionsShortcut(in: ["KeyboardShortcuts_liveCaptions": "not json"]))
    }

    func testCaptionSourceComesFromTheLatestLogLine() {
        let log = """
        [15:18:36.310] [INFO] [liveCaptionsCoordinator] showOverlay called with source: Loopback Audio
        [15:20:59.047] [INFO] [liveCaptionsCoordinator] Switched to microphone: BlackHole 2ch
        [15:21:10.000] [INFO] [argmaxInternal] Decoding 0.00s - 5.29s
        """
        XCTAssertEqual(MacWhisperSettings.captionSource(inLog: log), "BlackHole 2ch")
    }

    func testCaptionSourceIsUnknownWhenTheLogSaysNothing() {
        XCTAssertNil(MacWhisperSettings.captionSource(inLog: "[15:21:10.000] [INFO] [argmaxInternal] Decoding 0.00s - 5.29s"))
        XCTAssertNil(MacWhisperSettings.captionSource(inLog: ""))
    }
}
