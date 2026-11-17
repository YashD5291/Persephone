import Foundation

/// Chrome native messaging framing: each message is a 4-byte length in native
/// byte order followed by that many bytes of UTF-8 JSON.
public enum NativeMessaging {
    /// Chrome refuses host-to-extension messages larger than this.
    public static let maximumOutgoingBytes = 1_024 * 1_024

    public static func frame(_ payload: Data) -> Data {
        var length = UInt32(payload.count)
        var framed = Data(bytes: &length, count: MemoryLayout<UInt32>.size)
        framed.append(payload)
        return framed
    }

    public static func encode(_ message: [String: Any]) -> Data? {
        guard let payload = try? JSONSerialization.data(withJSONObject: message),
              payload.count <= maximumOutgoingBytes else { return nil }
        return frame(payload)
    }

    /// Splits complete messages off the front of `buffer`, leaving any partial one in place.
    public static func decodeAvailable(_ buffer: inout Data) -> [[String: Any]] {
        var messages: [[String: Any]] = []
        let header = MemoryLayout<UInt32>.size
        while buffer.count >= header {
            let length = buffer.prefix(header).withUnsafeBytes { Int($0.loadUnaligned(as: UInt32.self)) }
            guard buffer.count >= header + length else { break }
            let payload = buffer.subdata(in: buffer.startIndex + header ..< buffer.startIndex + header + length)
            buffer.removeFirst(header + length)
            if let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] {
                messages.append(object)
            }
        }
        return messages
    }
}
