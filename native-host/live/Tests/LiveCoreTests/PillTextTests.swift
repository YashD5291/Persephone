import XCTest
@testable import LiveCore

final class PillTextTests: XCTestCase {
    func testNothingHeardYetShowsThePlaceholder() {
        XCTAssertEqual(PillText.question(""), "Listening…")
        XCTAssertEqual(PillText.question("   "), "Listening…")
    }

    func testShortQuestionIsShownWhole() {
        XCTAssertEqual(PillText.question("What does idempotent mean?"), "What does idempotent mean?")
    }

    func testLongQuestionKeepsItsEndAndStartsOnAWholeWord() {
        let question = "Can you walk me through how you would design a data pipeline that handles late arriving events and what trade offs you would consider?"
        let shown = PillText.question(question)

        XCTAssertTrue(shown.hasPrefix("…"))
        XCTAssertTrue(shown.hasSuffix("you would consider?"), "the latest words are the ones that matter")
        XCTAssertLessThanOrEqual(shown.count, PillText.maximumQuestionCharacters + 1)
        let firstWord = shown.dropFirst().split(separator: " ").first.map(String.init) ?? ""
        XCTAssertTrue(question.split(separator: " ").map(String.init).contains(firstWord), "starts on a whole word, got \(firstWord)")
    }

    func testOneVeryLongWordIsStillShown() {
        let word = String(repeating: "a", count: 200)
        XCTAssertEqual(PillText.question(word).count, PillText.maximumQuestionCharacters + 1)
    }

    func testProblemsAreExplainedInPlainWords() {
        XCTAssertEqual(PillText.problem("captions_off"), "Could not start Live Captions. Start it in MacWhisper")
        XCTAssertEqual(PillText.problem("macwhisper_not_running"), "Could not start MacWhisper")
        XCTAssertEqual(PillText.problem("no_accessibility"), "Allow Accessibility in System Settings, then try again")
    }
}
