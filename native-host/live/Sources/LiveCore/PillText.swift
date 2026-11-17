import Foundation

/// What the on-screen status pill says. Kept apart from the window code so the
/// wording and truncation can be tested without a screen.
public enum PillText {
    /// Longest question excerpt shown. The pill is a glance, not a transcript.
    public static let maximumQuestionCharacters = 64
    public static let listening = "Listening…"
    public static let startingCaptions = "Starting Live Captions in MacWhisper…"

    /// The most recent words of the question, cut at a word boundary, or a
    /// placeholder while nothing has been heard yet. The end of the question is
    /// what tells the user "it has everything", so the start is what gets cut.
    public static func question(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return listening }
        guard trimmed.count > maximumQuestionCharacters else { return trimmed }

        var tail = String(trimmed.suffix(maximumQuestionCharacters))
        // Drop the partial first word so the excerpt does not start mid-word.
        if let firstSpace = tail.firstIndex(of: " "), firstSpace != tail.startIndex {
            let rest = tail[tail.index(after: firstSpace)...]
            if !rest.isEmpty { tail = String(rest) }
        }
        return "…" + tail
    }

    /// Plain-language reason live text is not flowing.
    public static func problem(_ state: String) -> String {
        switch state {
        // Both are shown only after the helper tried and failed to fix it itself.
        case "captions_off": return "Could not start Live Captions. Start it in MacWhisper"
        case "macwhisper_not_running": return "Could not start MacWhisper"
        case "no_accessibility": return "Allow Accessibility in System Settings, then try again"
        default: return "Live text problem: \(state)"
        }
    }
}
