import XCTest
@testable import LiveCore

/// Replays recordings of MacWhisper's captions panel through the stitcher.
///
/// Each fixture holds every read of the panel with its time, and the moments a
/// fresh question was started (what the extension does when a question is
/// sent). The question text just before each of those moments is what would
/// have been in the chat box.
final class CaptionReplayTests: XCTestCase {
    private struct Recording: Decodable {
        let marks: [TimeInterval]
        let snapshots: [Snapshot]

        struct Snapshot: Decodable {
            let time: TimeInterval
            let text: String
            init(from decoder: Decoder) throws {
                var pair = try decoder.unkeyedContainer()
                time = try pair.decode(TimeInterval.self)
                text = try pair.decode(String.self)
            }
        }
    }

    /// The question as it stood at the end of each stretch between two marks.
    private func questions(in name: String) throws -> [String] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        let recording = try JSONDecoder().decode(Recording.self, from: Data(contentsOf: url))
        var stitcher = CaptionStitcher()
        var results: [String] = []
        var marks = recording.marks[...]
        var started = false
        for snapshot in recording.snapshots {
            while let mark = marks.first, mark <= snapshot.time {
                if started { results.append(stitcher.questionText) }
                stitcher.startQuestion()
                started = true
                marks = marks.dropFirst()
            }
            stitcher.ingest(snapshot.text, at: snapshot.time)
        }
        results.append(stitcher.questionText)
        return results
    }

    private func words(_ text: String) -> [String] {
        text.split(separator: " ").map { CaptionStitcher.normalized(String($0)) }.filter { !$0.isEmpty }
    }

    private func assertQuestions(_ actual: [String], _ expected: [String], file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.count, expected.count, file: file, line: line)
        for (index, pair) in zip(actual, expected).enumerated() {
            XCTAssertEqual(words(pair.0), words(pair.1), "question \(index + 1): \"\(pair.0)\"", file: file, line: line)
        }
    }

    // What is expected is what the panel itself showed for each question by the
    // time the next one was started, mistakes included ("last ro", "Kough Kid"):
    // the stitcher must add no errors of its own, and it cannot remove MacWhisper's.

    func testQuestionsSeparatedByPausesStayWholeAndSeparate() throws {
        // About 3 s of silence between questions. The panel keeps the previous
        // question on screen, drops and re-shows a sentence when the next begins,
        // and scrolls a sentence at a time. Before the fix, questions 3 and 10
        // came out with the previous question glued on in front.
        assertQuestions(try questions(in: "pauses"), [
            "Describe how you would partition a very large table in a data warehouse",
            "How would you detect data drift after a model has been deployed?",
            "How do you handle class imbalance when the positive class is very rare",
            "Why did you leave your last ro",
            "What is overfitting and how do you prevent it?",
            "What is the difference between a left join and an inner joint?",
            "What does ID potent mean and why does it matter for each try?",
            "How do window functions differ from group by?",
            "Explain the BIOS variance trade-off in your own words",
            "How would you roll back a bad deployment on Kubernetes?",
        ])
    }

    func testQuestionsInQuickSuccessionKeepTheirFirstWords() throws {
        // About 1 s between questions. Before the fix, question 3 lost
        // "How would you roll": the new sentence was taken for a correction of
        // the old one because both contain "would you".
        assertQuestions(try questions(in: "quick"), [
            "Why would you choose Kough Kid over a simple message key?",
            "Can you explain how HashMap handles collapse?",
            "How would you roll back a bad deployment on Kubernetes?",
            "What happens when you type a web address into the browser and press enter?",
            "Tell me about a time you had to debug the memory leak in production",
            "Why did you leave your last role?",
        ])
    }

    func testQuestionsWhileMacWhisperIsBusyComeOutAsThePanelShowedThem() throws {
        // Eighteen questions while MacWhisper was slow. Its panel took a first
        // guess back a second later ("... What does I"), flipped back to the
        // previous question for one read, swapped a two-word panel for a new
        // sentence, and showed the last word of the old question in front of
        // the new one. Before those cases were handled, question 2 came out as
        // "What does I What does id impotent ...", question 9 had the whole of
        // question 8 in front of it, and question 15 lost "How do".
        // Questions 13 and 14 are MacWhisper's own: it stalled, and what it
        // showed for them is all there was to copy.
        assertQuestions(try questions(in: "busy"), [
            "Can you walk me through how you would design a data pipeline that handles late arriving events?",
            "What does id impotent mean and why does it matter for retries?",
            "What is the difference between precision and recall and when would you optimize for each?",
            "How do you decide between a random forest N gradient boosting for a tabular problem?",
            "Why would you choose Kafka over a simple message queue?",
            "Describe how you would partition a very large table in a data warehouse.",
            "How would you detect data drift after a model has been deployed?",
            "How do you handle class imbalance when the positive class is very rare?",
            "Walk me through your approach to feature engineering for time series forecasting.",
            "What is the difference between a left join and an inner join?",
            "How would you roll back a bad deployment on Kubernetes?",
            "What trade-offs would you consider between consistency and availability?",
            "What happens when you type a web address into",
            "Hills collisions",
            "How do window functions differ from group by?",
            "Tell me about a time you had to debug a memory leak in production.",
            "Explain the bias variance trade-off in your own words.",
            "How would you explain a confidence interval to a non-technical stakeholder?",
        ])
    }

    func testQuestionsTheRulesWereNotTunedOn() throws {
        // Recorded after the rules above were written, on other questions. One
        // new pattern showed up (question 6: a 22-word first guess replaced
        // a quarter of a second later) and was then handled.
        // Question 1 came after minutes of silence: MacWhisper showed stray
        // single words for the whole question, and there was nothing to copy.
        assertQuestions(try questions(in: "unseen"), [
            "Atlan Poplum",
            "How do you handle class imbalance when the positive class is very rare?",
            "Walk me through your approach to feature engineering for time series forecasting.",
            "How would you detect data drift after a model has been deployed?",
            "What is the difference between precision and recall and when would you optimize for each?",
            "How would you explain a confidence interval to a non-technical stakeholder?",
            "What is the difference between a left join and an inner join?",
            "Why would you choose Kafka over a simple message queue?",
            "What is overfitting and how do you prevent it?",
            "Tell me about a time you had to debug a memory leak in production.",
            "What happens when you type a web address into the browser and press enter?",
            "How do window functions differ from group by?",
            "Can you walk me through how you would design a data pipeline that handles late arriving events?",
            "Explained the bias variance trade-off in your own words",
            "How would you roll back a bad deployment on Kubernetes?",
            "What does Edempotent mean and why does it matter for retries?",
            "Can you explain how a HashMap handles collisions?",
            "What trade-offs would you consider between consistency and availability?",
        ])
    }

    func testAMinuteOfContinuousSpeechLosesNothing() throws {
        // Fourteen sentences back to back, one question (no marks in between).
        // Before the fix, "how you would design a data pipeline that handles
        // late arriving events?" was deleted from the second sentence.
        assertQuestions(try questions(in: "continuous"), [
            "What is the difference between a left join and an inner join? "
            + "Can you walk me through how you would design a data pipeline that handles late arriving events? "
            + "How do you decide between a random forest and gradient boosting for a tabular problem? "
            + "Tell me about a time you had to debug a memory leak in production. "
            + "What does idempotent mean and why does it matter for retries? "
            + "How would you detect data drift after a model has been deployed? "
            + "Explain the bias variance trade-off in your own words. "
            + "Why would you choose Kafkin over a simple message queue? "
            + "What happens when you type a web address into the browser and press enter? "
            + "How do you handle class imbalance when the positive class is very rare? "
            + "Can you explain how a HashMap handles collisions? "
            + "What is the difference between precision and recall? And when would you optimize for each? "
            + "How would you roll back a bad deployment on Kubernetes? "
            + "Describe how you would partition a data where",
        ])
    }
}
