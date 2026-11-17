import Foundation

/// Rebuilds a running transcript from snapshots of a captions panel.
///
/// The panel only shows the last two or three sentences. As someone talks,
/// the newest words are appended and revised, and the oldest sentences scroll
/// off the top. Each snapshot is therefore a moving window over the real
/// transcript. The stitcher works out how the window moved between two
/// snapshots and keeps everything that has scrolled away, so a long question
/// is not lost before it is sent.
///
/// What MacWhisper's panel was seen to do (recorded 2026-10-13, replayed in
/// the tests):
///   - grow at the end, and re-guess the sentence in progress about every 0.3 s
///   - correct the last words of a sentence late, when the next one begins
///   - when a new sentence begins: drop its newest sentence for one read, then
///     show it again with the oldest sentence scrolled away
///   - swap to a new sentence outright, whatever it was holding
///   - show the first words of a new sentence, take them back, then show the
///     sentence on its own
///   - flip back to a sentence it had already replaced, for one read
///   - a second or two after a sentence ends, transcribe it once more, which
///     can change most of its words
public struct CaptionStitcher {
    /// Captions change about every 0.3 s while someone talks (longest gap
    /// measured: 0.83 s). Words that stood on the panel longer are settled.
    static let pauseSeconds: TimeInterval = 1.0
    /// Share of the earlier window (from where the two line up) that must
    /// still be there for both to be the same stretch of speech. The sentence
    /// in progress is re-guessed freely, so half is enough; a new sentence that
    /// merely shares common words with the old one ("How would you ...") stays
    /// well below it.
    static let keptForSameSpeech = 0.5
    /// Only a window of about one sentence can be the same speech transcribed
    /// again from scratch ("Why would you have to do that?" becoming "Why would
    /// you choose Kafka over a simple message queue?"). A bigger one also holds
    /// earlier sentences, and those would still be there.
    static let reguessWindowWords = 12
    /// A sentence of only a few words can come back as entirely different
    /// words while it is being spoken ("Wanna" becoming "Why would you"). A
    /// longer one transcribed again still starts the same way or keeps some
    /// of its words.
    static let unsettledWindowWords = 6
    static let keptForReguess = 0.25
    /// The panel scrolls a sentence at a time, so a window that starts fewer
    /// words in than this was revised, not scrolled.
    static let minimumScrollWords = 3
    /// A read that only removes this many words or more from the end is the
    /// panel redrawing itself. Corrections replace words; they do not just
    /// drop several.
    static let transientShrinkWords = 3
    /// Transcript kept behind the current question. Bounds memory over a long call.
    static let retainedWords = 2000

    private var words: [String] = []
    /// Index in `words` where the visible window begins.
    private var windowStart = 0
    private var window: [String] = []
    /// Index in `words` where the current question begins.
    private var questionStart = 0
    /// When the words on the panel last changed (punctuation and capitals do not count).
    private var windowChangedAt: TimeInterval = 0
    /// For each word of the window, when it first showed up as it is now.
    private var windowSeenAt: [TimeInterval] = []
    /// A read that only dropped words from the end, set aside until the next
    /// read shows whether they come back.
    private var shrunkWindow: [String]?
    /// Whether that read came while someone was talking.
    private var shrunkMidSpeech = false

    public init() {}

    /// Text heard since the last `startQuestion()`.
    public var questionText: String {
        words[min(questionStart, words.count)...].joined(separator: " ")
    }

    /// Everything from now on belongs to a new question.
    public mutating func startQuestion() {
        // The window is left alone: words already on screen stay in `words`
        // before the mark, so when the next snapshot repeats them they are
        // recognised as old and only what follows counts as the question.
        questionStart = words.count
        trimHistory()
    }

    /// Takes the panel's current text and the time it was read (seconds, any
    /// steady clock). Returns true when the question text changed.
    @discardableResult
    public mutating func ingest(_ snapshot: String, at time: TimeInterval) -> Bool {
        let incoming = snapshot.split(whereSeparator: \.isWhitespace).map(String.init)
        guard incoming != window else { return false }
        let before = questionText

        if incoming.isEmpty {
            // Panel cleared (silence). Keep what was heard; the next text starts a new window.
            window = []
            windowSeenAt = []
            windowStart = words.count
            shrunkWindow = nil
            return false
        }

        let new = incoming.map(Self.normalized)

        // The panel sometimes shows again, in front of its text, words that had
        // already left it (an earlier sentence, or just its last word). Those
        // are known: the window is stretched back over them instead of taking
        // them for something new.
        let back = scrolledBack(by: new)
        if back > 0 {
            windowStart -= back
            window = Array(words[windowStart...])
            windowSeenAt = [TimeInterval](repeating: -.infinity, count: back) + windowSeenAt
        }
        let old = window.map(Self.normalized)
        let quiet = time - windowChangedAt

        // When a new sentence begins, the panel drops its newest sentence for a
        // single read and shows it again in the next one. Words that stood on
        // the panel for a while cannot be un-said, so a read that only removes
        // several words from the end, some of them settled, is set aside; the
        // next read decides. (If every removed word is fresh, it is the first
        // guess at a new sentence being taken back, and the read is applied.)
        let onlyDropsWords = new.count < old.count && Array(old.prefix(new.count)) == new
        if onlyDropsWords, new.count + Self.transientShrinkWords <= old.count,
           windowSeenAt[new.count...].contains(where: { time - $0 >= Self.pauseSeconds }) {
            shrunkWindow = new
            shrunkMidSpeech = quiet < Self.pauseSeconds
            return false
        }

        // Text the current question does not reach into was sent already.
        let oldWasSent = questionStart > 0 && questionStart >= windowStart + window.count
        // Everything on the panel appeared within the last second: it is all still a guess.
        let oldIsFresh = !oldWasSent && windowSeenAt.allSatisfy { time - $0 < Self.pauseSeconds }
        var relation = onlyDropsWords ? .sameWindow
            : Self.relation(of: new, to: old, oldWasSent: oldWasSent, oldIsFresh: oldIsFresh)
        if relation == .newSpeech, let shrunk = shrunkWindow {
            if shrunkMidSpeech, Array(new.prefix(shrunk.count)) == shrunk {
                // The dropped words stayed away and the text went on from where
                // it was cut: mid-speech, that is a re-guess after all.
                relation = .sameWindow
            } else if old[shrunk.count] == new[0] {
                // The dropped words were the first guess at the sentence that
                // is now shown on its own ("... What does I" taken back, then
                // "What does id impotent mean"). They go; the rest stays.
                words.removeSubrange((windowStart + shrunk.count)...)
            }
        }
        shrunkWindow = nil
        if new != old { windowChangedAt = time }

        // A word keeps its age while it stays the same word in the same place.
        let scrolledAway: Int
        if case .scrolled(let gone) = relation { scrolledAway = gone } else { scrolledAway = 0 }
        let earlier = relation == .newSpeech ? [] : Array(zip(old, windowSeenAt).dropFirst(scrolledAway))
        windowSeenAt = new.enumerated().map { index, word in
            index < earlier.count && earlier[index].0 == word ? earlier[index].1 : time
        }

        switch relation {
        case .newSpeech:
            windowStart = words.count
        case .sameWindow, .reguessed:
            let markInWindow = questionStart - windowStart
            if relation == .reguessed, markInWindow >= window.count {
                // All of the old text came before the question. So does this second go at it.
                questionStart = windowStart + incoming.count
            } else if markInWindow > 0 {
                // The tail grew or was revised. If the revision reached back before
                // the question mark, the mark has to move with the words around it.
                questionStart = windowStart + Self.relocatedMark(markInWindow, from: window, to: incoming)
            }
        case .scrolled(let wordsGone):
            windowStart += wordsGone
        }

        words.replaceSubrange(min(windowStart, words.count)..., with: incoming)
        window = incoming
        questionStart = min(questionStart, words.count)
        return questionText != before
    }

    /// How many of the words just in front of the window this read shows again
    /// at its start. A run of three or more is proof enough; a shorter one
    /// counts only when the window's own first word comes right after it.
    private func scrolledBack(by new: [String]) -> Int {
        let longest = min(windowStart, new.count, 40)
        guard longest > 0 else { return 0 }
        let firstOfWindow = window.first.map(Self.normalized)
        for count in stride(from: longest, through: 1, by: -1) {
            let earlier = words[(windowStart - count)..<windowStart].map(Self.normalized)
            guard Array(new.prefix(count)) == earlier else { continue }
            if count >= 3 || (count < new.count && new[count] == firstOfWindow) { return count }
        }
        return 0
    }

    /// Where the question mark belongs after the window was revised.
    ///
    /// Captions correct the last words of a sentence late, often only when the
    /// next person starts talking ("for each rise" becomes "for retries?"). If
    /// that sentence was before the mark, the corrected words must stay before
    /// it, even though their number changed.
    static func relocatedMark(_ mark: Int, from old: [String], to new: [String]) -> Int {
        let limit = min(old.count, new.count)
        var unchanged = 0
        while unchanged < limit, normalized(old[unchanged]) == normalized(new[unchanged]) { unchanged += 1 }
        // Nothing before the mark changed: it stays where it is.
        guard unchanged < mark else { return min(mark, new.count) }

        // Question words were already on screen: find them again.
        if mark < old.count {
            let anchor = old[mark..<min(mark + 3, old.count)].map(normalized)
            var start = unchanged
            while start + anchor.count <= new.count {
                if new[start..<start + anchor.count].map(normalized) == anchor { return start }
                start += 1
            }
        }

        // No question words yet. A corrected sentence ends with punctuation,
        // so the mark goes right after the first sentence end in the revision.
        let revisedBeforeMark = min(mark, old.count) - unchanged
        let searchEnd = min(new.count, unchanged + revisedBeforeMark + 2)
        if let sentenceEnd = (unchanged..<searchEnd).first(where: { endsSentence(new[$0]) }) {
            return sentenceEnd + 1
        }
        return min(new.count, unchanged + revisedBeforeMark)
    }

    static func endsSentence(_ word: String) -> Bool {
        guard let last = word.last else { return false }
        return last == "." || last == "?" || last == "!"
    }

    enum Relation: Equatable {
        /// Same lines as before, with the newest words added or corrected.
        case sameWindow
        /// The same speech transcribed again from scratch: little of the old wording is left.
        case reguessed
        /// Same speech, but this many words have scrolled off the top.
        case scrolled(Int)
        /// Nothing to do with the previous window.
        case newSpeech
    }

    /// How the new window relates to the old one. Both lists are normalized
    /// words. `oldWasSent`: all of the old window came before the current
    /// question. `oldIsFresh`: all of it appeared less than a second ago.
    static func relation(of new: [String], to old: [String], oldWasSent: Bool, oldIsFresh: Bool = false) -> Relation {
        if old.isEmpty { return .newSpeech }
        let shift = scrollOffset(from: old, to: new)
        let stillVisible = Array(old[shift...])
        let kept = Double(commonSubsequenceLength(stillVisible, new)) / Double(stillVisible.count)
        if kept >= keptForSameSpeech { return shift >= minimumScrollWords ? .scrolled(shift) : .sameWindow }

        // Too little in common to be the old text grown or scrolled: either the
        // same speech transcribed again, or the panel swapped to new speech.
        // Text that is under a second old cannot have been followed by new
        // speech already. However long it is, it was a first guess: seen live,
        // 22 words of "a little bit of a little bit of ..." replaced a quarter
        // of a second later by the real start of the sentence.
        if oldIsFresh { return .reguessed }
        guard old.count <= reguessWindowWords else { return .newSpeech }
        let alike = old.first == new.first || kept >= keptForReguess
        if oldWasSent {
            // The question that was sent, transcribed once more, comes back whole
            // and resembles the first version. A new question starts with a
            // word or two, and it must not be swallowed as a correction.
            return alike && new.count * 4 >= old.count * 3 ? .reguessed : .newSpeech
        }
        // The sentence in progress: a few words can come back as anything.
        let aboutAsLong = new.count * 2 >= old.count
        return aboutAsLong && (alike || old.count <= unsettledWindowWords) ? .reguessed : .newSpeech
    }

    /// How many words scrolled off the top: the shift at which the new window
    /// lines up, word for word, with the most words of the old one. Lining
    /// the windows up position by position (rather than taking the first word
    /// they share) is what keeps a repeated "how" or "you" from being taken
    /// for the place where the text continues.
    static func scrollOffset(from old: [String], to new: [String]) -> Int {
        var best = (shift: 0, matches: 0)
        for shift in 0..<old.count {
            let overlap = min(new.count, old.count - shift)
            if overlap <= best.matches { break }   // later shifts overlap even less
            var matches = 0
            for j in 0..<overlap where old[shift + j] == new[j] { matches += 1 }
            if matches > best.matches { best = (shift, matches) }
        }
        // A scroll has to be backed by a run of words, not by one word that happens to line up.
        let needed = max(2, min(3, old.count - best.shift))
        return best.shift > 0 && best.matches < needed ? 0 : best.shift
    }

    /// Length of the longest run of words that appear in both lists in the
    /// same order. Windows are a few dozen words, so the quadratic table is a
    /// few thousand cells.
    static func commonSubsequenceLength(_ old: [String], _ new: [String]) -> Int {
        guard !old.isEmpty, !new.isEmpty else { return 0 }
        var previous = [Int](repeating: 0, count: new.count + 1)
        for i in stride(from: old.count - 1, through: 0, by: -1) {
            var current = [Int](repeating: 0, count: new.count + 1)
            for j in stride(from: new.count - 1, through: 0, by: -1) {
                current[j] = old[i] == new[j] ? previous[j + 1] + 1 : max(previous[j], current[j + 1])
            }
            previous = current
        }
        return previous[0]
    }

    static func normalized(_ word: String) -> String {
        String(word.lowercased().unicodeScalars.filter(CharacterSet.alphanumerics.contains))
    }

    private mutating func trimHistory() {
        let excess = questionStart - Self.retainedWords
        guard excess > 0 else { return }
        words.removeFirst(excess)
        questionStart -= excess
        windowStart -= excess
    }
}
