import XCTest
@testable import LiveCore

final class NativeMessagingTests: XCTestCase {
    func testEncodedMessageRoundTrips() throws {
        var buffer = try XCTUnwrap(NativeMessaging.encode(["type": "text", "text": "héllo"]))
        let messages = NativeMessaging.decodeAvailable(&buffer)
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages[0]["text"] as? String, "héllo")
        XCTAssertTrue(buffer.isEmpty)
    }

    func testPartialMessageWaitsForTheRest() throws {
        let whole = try XCTUnwrap(NativeMessaging.encode(["cmd": "mark"]))
        var buffer = whole.prefix(6)
        XCTAssertTrue(NativeMessaging.decodeAvailable(&buffer).isEmpty)
        buffer.append(whole.suffix(from: 6))
        XCTAssertEqual(NativeMessaging.decodeAvailable(&buffer).first?["cmd"] as? String, "mark")
    }

    func testTwoMessagesInOneReadAreBothDelivered() throws {
        var buffer = try XCTUnwrap(NativeMessaging.encode(["cmd": "mark"]))
        buffer.append(try XCTUnwrap(NativeMessaging.encode(["cmd": "pause"])))
        XCTAssertEqual(NativeMessaging.decodeAvailable(&buffer).compactMap { $0["cmd"] as? String }, ["mark", "pause"])
    }

    func testOversizedMessageIsRefused() {
        XCTAssertNil(NativeMessaging.encode(["text": String(repeating: "x", count: NativeMessaging.maximumOutgoingBytes)]))
    }
}
