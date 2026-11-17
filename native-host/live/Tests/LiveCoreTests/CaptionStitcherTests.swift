import XCTest
@testable import LiveCore

/// Clock for tests that do not care about timing: every read comes 0.3 s after
/// the one before, which is how captions arrive while someone is talking.
private var talkingClock: TimeInterval = 0

private extension CaptionStitcher {
    @discardableResult
    mutating func ingest(_ snapshot: String) -> Bool {
        talkingClock += 0.3
        return ingest(snapshot, at: talkingClock)
    }

    /// Nobody says anything for a while (the panel keeps showing the same text).
    mutating func pause(_ seconds: TimeInterval = 3) {
        talkingClock += seconds
    }
}

final class CaptionStitcherTests: XCTestCase {
    private func feed(_ snapshots: [String], into stitcher: inout CaptionStitcher) {
        for snapshot in snapshots { stitcher.ingest(snapshot) }
    }

    func testWordsArrivingOneByOneBuildTheSentence() {
        var stitcher = CaptionStitcher()
        feed(["What", "What is", "What is the", "What is the difference"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "What is the difference")
    }

    func testRevisedGuessReplacesTheEarlierOne() {
        var stitcher = CaptionStitcher()
        feed(["How would you roll back a bad deploy",
              "How would you roll back a bad deployment on Cuba",
              "How would you roll back a bad deployment on Kubernetes?"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "How would you roll back a bad deployment on Kubernetes?")
    }

    func testFirstWordsBeingRevisedDoNotDuplicate() {
        var stitcher = CaptionStitcher()
        feed(["What", "What's the", "What's the difference between"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "What's the difference between")
    }

    func testRepunctuationIsNotNewText() {
        var stitcher = CaptionStitcher()
        feed(["what is the difference between a left join", "What is the difference between a left join?"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "What is the difference between a left join?")
    }

    func testTextThatScrolledOffThePanelIsKept() {
        var stitcher = CaptionStitcher()
        feed(["Can you walk me through how you would design a data pipeline",
              "Can you walk me through how you would design a data pipeline that handles late",
              // The first line scrolls away; the panel now starts mid-sentence.
              "how you would design a data pipeline that handles late arriving events and what",
              "a data pipeline that handles late arriving events and what trade offs you would consider?"],
             into: &stitcher)
        XCTAssertEqual(stitcher.questionText,
                       "Can you walk me through how you would design a data pipeline that handles late arriving events and what trade offs you would consider?")
    }

    func testPanelClearingDuringAPauseKeepsBothParts() {
        var stitcher = CaptionStitcher()
        feed(["So you mentioned Kafka earlier.", "", "Why would you choose it over a simple message queue?"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "So you mentioned Kafka earlier. Why would you choose it over a simple message queue?")
    }

    func testUnrelatedTextAfterAFullPanelIsAppended() {
        var stitcher = CaptionStitcher()
        feed(["Okay that makes sense thanks for explaining that part to me"], into: &stitcher)
        // Eleven words take a few seconds to say: by the time the panel swaps, they are not a fresh guess.
        stitcher.pause(1.5)
        feed(["Next question what is overfitting and how do you prevent it"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText,
                       "Okay that makes sense thanks for explaining that part to me Next question what is overfitting and how do you prevent it")
    }

    func testOnlyWordsAfterTheMarkBelongToTheQuestion() {
        var stitcher = CaptionStitcher()
        feed(["Great answer, thank you."], into: &stitcher)
        stitcher.startQuestion()
        XCTAssertEqual(stitcher.questionText, "")
        // The panel still shows the old sentence while the new one arrives.
        feed(["Great answer, thank you. What does", "Great answer, thank you. What does idempotent mean?"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "What does idempotent mean?")
    }

    func testMarkSurvivesTheOldSentenceScrollingAway() {
        var stitcher = CaptionStitcher()
        feed(["Great answer, thank you so much for that."], into: &stitcher)
        stitcher.startQuestion()
        feed(["Great answer, thank you so much for that. How do window functions",
              "thank you so much for that. How do window functions differ from",
              "How do window functions differ from group by?"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "How do window functions differ from group by?")
    }

    func testLateCorrectionOfThePreviousSentenceStaysOutOfTheQuestion() {
        // Seen with MacWhisper: the last words of a sentence are corrected only
        // once the next person starts talking, after the mark was placed.
        var stitcher = CaptionStitcher()
        feed(["What does idempotent mean and why does it matter for each rise"], into: &stitcher)
        stitcher.startQuestion()
        feed(["What does idempotent mean and why does it matter for retries? How would",
              "What does idempotent mean and why does it matter for retries? How would you roll back a bad deployment?"],
             into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "How would you roll back a bad deployment?")
    }

    func testLateCorrectionThatAddsWordsStaysOutOfTheQuestion() {
        var stitcher = CaptionStitcher()
        feed(["so tell me about the tradeoffs"], into: &stitcher)
        stitcher.startQuestion()
        feed(["so tell me about the trade offs here. Why Kafka"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "Why Kafka")
    }

    func testCorrectionBeforeTheMarkKeepsQuestionWordsAlreadyHeard() {
        var stitcher = CaptionStitcher()
        feed(["and why does it matter for each rise"], into: &stitcher)
        stitcher.startQuestion()
        feed(["and why does it matter for each rise How would you",
              "and why does it matter for retries? How would you roll back"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "How would you roll back")
    }

    func testWholeSentenceBeingReguessedDoesNotDuplicate() {
        // Captured from MacWhisper: it re-transcribes the sentence so far a few
        // times a second, and the early guesses differ from start to finish.
        var stitcher = CaptionStitcher()
        feed(["What decide m potent mean and what",
              "What does ID M potent mean and why does",
              "What does idempotent mean and why does it matter",
              "What does idempotent mean and why does it matter for retries?"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "What does idempotent mean and why does it matter for retries?")
    }

    func testReguessWithAFillerWordDroppedIsNotAScroll() {
        var stitcher = CaptionStitcher()
        feed(["um so what is the difference between a left",
              "So what is the difference between a left join and an inner join?"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "So what is the difference between a left join and an inner join?")
    }

    func testAFewNewWordsAfterAFullPanelStartNewSpeech() {
        // The panel swapped to a new sentence between two reads: the old one must not be thrown away.
        var stitcher = CaptionStitcher()
        feed(["Okay so you mentioned you used Kafka at your last company"], into: &stitcher)
        stitcher.pause(1.5)   // the sentence took its time; it is no longer a fresh guess
        feed(["Why", "Why would you", "Why would you choose it over a queue?"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "Okay so you mentioned you used Kafka at your last company Why would you choose it over a queue?")
    }

    // --- Patterns recorded from MacWhisper's panel on 2026-10-13 ---

    func testNewSentenceSharingCommonWordsIsNotACorrectionOfTheOldOne() {
        // Both sentences contain "how", "would", "you" and "data". The second was
        // taken for a re-guess of the first, and its first five words were lost.
        var stitcher = CaptionStitcher()
        feed(["Describe how you would partition a very large table in a data warehouse"], into: &stitcher)
        stitcher.pause()
        stitcher.startQuestion()
        feed(["How would you detect data", "How would you detect data drift after a model has been deployed?"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "How would you detect data drift after a model has been deployed?")
    }

    func testNewSentenceStartingWithTheSameWordsAsTheOldOneIsKeptWhole() {
        var stitcher = CaptionStitcher()
        feed(["How would you detect data drift after a model has been deployed?"], into: &stitcher)
        stitcher.pause()
        stitcher.startQuestion()
        feed(["How would you", "How would you roll back", "How would you roll back a bad deployment?"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "How would you roll back a bad deployment?")
    }

    func testNewSentenceAfterAShortOneIsAddedToIt() {
        // How the panel really shows a new sentence while it holds little: after the old one.
        var stitcher = CaptionStitcher()
        feed(["What is", "What is overfitting?"], into: &stitcher)
        stitcher.pause()
        feed(["What is overfitting? How do you", "What is overfitting? How do you prevent it?"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "What is overfitting? How do you prevent it?")
    }

    func testSentenceGuessedAgainAfterItEndedReplacesTheFirstGuess() {
        // Seen live: a second or two after a sentence ends MacWhisper transcribes
        // it once more, and the result can differ a lot. Both versions ended up
        // in the box ("Why would you have to do that? Why would you choose ...").
        var stitcher = CaptionStitcher()
        feed(["Why would you", "Why would you have to do that?"], into: &stitcher)
        stitcher.pause(2)
        feed(["Why would you choose Kafka over a simple message queue?"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "Why would you choose Kafka over a simple message queue?")

        var second = CaptionStitcher()
        feed(["Explain the buyers variance trade off"], into: &second)
        second.pause(2)
        feed(["Explain the bias variance trade-off in your own", "Explain the bias variance trade-off in your own words."], into: &second)
        XCTAssertEqual(second.questionText, "Explain the bias variance trade-off in your own words.")
    }

    func testShortSentenceStillBeingSpokenCanBeReguessedFromScratch() {
        var stitcher = CaptionStitcher()
        feed(["Wanna", "Why would", "Why would you choose Kafka?"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "Why would you choose Kafka?")
    }

    func testSentenceThatVanishesForOneReadIsNotLostOrRepeated() {
        // When the third sentence begins, the panel shows only the first one for
        // a single read, then the second one again with the first scrolled away.
        var stitcher = CaptionStitcher()
        let first = "Describe how you would partition a very large table in a data warehouse."
        let second = "How would you detect data drift after a model has been deployed?"
        feed([first, first + " " + second], into: &stitcher)
        stitcher.pause()
        stitcher.startQuestion()
        feed([first, second + " How do you", second + " How do you handle class imbalance?"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "How do you handle class imbalance?")
    }

    func testRepeatedCommonWordsDoNotHideAScroll() {
        // The old window holds "how you would ... How would you ...". Lining the
        // new window up with the first "how" instead of the right one made a
        // scroll of 13 words look like a revision.
        var stitcher = CaptionStitcher()
        let first = "Describe how you would partition a very large table in a data warehouse"
        let second = "How would you detect data drift after a model has been deployed?"
        feed([first + " " + second], into: &stitcher)
        stitcher.startQuestion()
        feed([second + " How do you", second + " How do you handle"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "How do you handle")
    }

    func testWordsTakenBackForGoodAreDropped() {
        // The read that drops words is set aside, not ignored for ever: when the
        // text then goes on differently from the cut, the dropped words go.
        var stitcher = CaptionStitcher()
        feed(["Why would you choose the early thing here today",
              "Why would you",
              "Why would you choose Kafka over a queue?"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "Why would you choose Kafka over a queue?")
    }

    func testFirstWordsOfANewSentenceTakenBackThenReplacedByItDoNotRepeat() {
        // "... press enter? Tell me" -> "... press enter?" -> "Tell me about it."
        var stitcher = CaptionStitcher()
        let old = "How would you roll back a bad deployment on Kubernetes? What happens when you press enter?"
        feed([old], into: &stitcher)
        stitcher.pause()
        stitcher.startQuestion()
        feed([old + " Tell me", old, "Tell me about it.", "Tell me about a time you had to debug"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "Tell me about a time you had to debug")
    }

    func testFirstGuessAtANewSentenceTakenBackBeforeThePanelSwapsDoesNotStay() {
        // Seen live: "... on Kubernetes Wat trade offs" -> "... on Kubernetes" ->
        // "What trade-offs would you". The three fresh words were kept next to
        // their correction ("Wat trade offs What trade-offs ...").
        var stitcher = CaptionStitcher()
        let old = "What is the difference between a left join and an inner join? How would you roll back a bad deployment on Kubernetes"
        feed([old], into: &stitcher)
        stitcher.pause()
        feed([old + " Wat trade offs", old, "What trade-offs would you", "What trade-offs would you consider?"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, old + " What trade-offs would you consider?")
    }

    func testLongFirstGuessReplacedAMomentLaterDoesNotStay() {
        // Recorded: MacWhisper's first read of a new question was a 22-word
        // loop, gone 0.24 s later. Too long to be "a few words re-guessed", but
        // nothing that young can have been followed by new speech.
        var stitcher = CaptionStitcher()
        feed(["What is the difference between precision and recall, and when would you optimize for each?"], into: &stitcher)
        stitcher.pause()
        stitcher.startQuestion()
        feed(["How would you have a little bit of a little bit of a little bit of a little bit of a little",
              "How would you expect",
              "How would you explain it?",
              "How would you explain a confidence interval to a non-technical stakeholder?"], into: &stitcher)
        XCTAssertEqual(stitcher.questionText, "How would you explain a confidence interval to a non-technical stakeholder?")
    }

    func testIngestReportsWhetherTheQuestionChanged() {
        var stitcher = CaptionStitcher()
        XCTAssertTrue(stitcher.ingest("Why did you"))
        XCTAssertFalse(stitcher.ingest("Why did you"))
        XCTAssertFalse(stitcher.ingest(""))
        XCTAssertTrue(stitcher.ingest("Why did you leave"))
    }

    func testLongQuestionThroughASmallScrollingPanel() {
        // A panel that holds about 14 words and drops 5 from the top whenever it
        // overflows, fed one word at a time: nothing may be lost or repeated.
        let original = ("Walk me through your approach to feature engineering for time series forecasting "
            + "and then explain how you would detect data drift after the model has been deployed "
            + "and what you would do about class imbalance when the positive class is very rare").split(separator: " ").map(String.init)
        var stitcher = CaptionStitcher()
        var top = 0
        for end in 1...original.count {
            if end - top > 14 { top += 5 }
            stitcher.ingest(original[top..<end].joined(separator: " "))
        }
        XCTAssertEqual(stitcher.questionText, original.joined(separator: " "))
    }

    func testHistoryIsBoundedOverALongCall() {
        var stitcher = CaptionStitcher()
        for i in 0..<400 {
            stitcher.ingest("this is sentence number \(i) with some more words in it")
            stitcher.ingest("")
            stitcher.startQuestion()
        }
        stitcher.ingest("the final question")
        XCTAssertEqual(stitcher.questionText, "the final question")
    }
}
