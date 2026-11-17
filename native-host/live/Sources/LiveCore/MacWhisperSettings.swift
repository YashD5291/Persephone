import Foundation

/// Reads the few MacWhisper facts this helper depends on from MacWhisper's own
/// records (its preferences and its log), so the helper follows what the user
/// set up in MacWhisper instead of keeping a second copy that can drift.
public enum MacWhisperSettings {
    /// A keyboard shortcut as MacWhisper stores it.
    public struct Shortcut: Equatable {
        public let keyCode: UInt16
        public let command: Bool
        public let option: Bool
        public let control: Bool
        public let shift: Bool
    }

    // Carbon modifier masks, the format MacWhisper's shortcut recorder saves.
    private static let carbonCommand = 0x0100
    private static let carbonShift = 0x0200
    private static let carbonOption = 0x0800
    private static let carbonControl = 0x1000

    /// The shortcut recorded under Settings > Live Captions > Keyboard Shortcut, if any.
    ///
    /// MacWhisper saves each shortcut as `KeyboardShortcuts_<name>` holding
    /// JSON like `{"carbonKeyCode":37,"carbonModifiers":6400}`. MacWhisper
    /// 15.5 names this one `streamingOverlayActivation` (the captions panel is
    /// its "streaming overlay"). The name is matched loosely, on any of the
    /// words below, so a rename in a MacWhisper update does not silently lose it.
    static let shortcutNameHints = ["streamingoverlay", "caption", "live"]

    public static func liveCaptionsShortcut(in preferences: [String: Any]) -> Shortcut? {
        let candidates = preferences.keys
            .filter { $0.hasPrefix("KeyboardShortcuts_") }
            .filter { key in
                let name = key.lowercased()
                // The dictation key must never be taken for it: pressing that starts a dictation.
                return shortcutNameHints.contains(where: name.contains) && !name.contains("dictation")
            }
            .sorted()
        for key in candidates {
            if let shortcut = shortcut(fromStored: preferences[key]) { return shortcut }
        }
        return nil
    }

    static func shortcut(fromStored value: Any?) -> Shortcut? {
        guard let text = value as? String, let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let keyCode = (object["carbonKeyCode"] as? NSNumber)?.intValue, keyCode >= 0, keyCode <= 0xFFFF else { return nil }
        let modifiers = (object["carbonModifiers"] as? NSNumber)?.intValue ?? 0
        return Shortcut(keyCode: UInt16(keyCode),
                        command: modifiers & carbonCommand != 0,
                        option: modifiers & carbonOption != 0,
                        control: modifiers & carbonControl != 0,
                        shift: modifiers & carbonShift != 0)
    }

    /// The audio source Live Captions last reported listening to, from
    /// MacWhisper's log. Shown to the user so that captions listening to the
    /// wrong device (and so hearing nothing) cannot go unnoticed.
    public static func captionSource(inLog log: String) -> String? {
        let markers = ["showOverlay called with source: ", "Switched to microphone: "]
        for line in log.split(separator: "\n", omittingEmptySubsequences: true).reversed() {
            for marker in markers {
                if let range = line.range(of: marker) {
                    let source = line[range.upperBound...].trimmingCharacters(in: .whitespaces)
                    if !source.isEmpty { return source }
                }
            }
        }
        return nil
    }
}
