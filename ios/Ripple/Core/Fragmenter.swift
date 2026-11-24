import Foundation

enum FragmenterError: Error, Equatable {
    case packetTooLarge
    case frameTooSmall
    case tooManyFragments
}

/// BLE frame fragmentation per PROTOCOL.md §5.2.
enum Fragmenter {
    static let header = 4
    static let maxFragments = 255

    /// Largest complete packet that fits this frame size and the 8-bit fragment count.
    static func maxPacketSize(frameSize: Int) -> Int {
        guard frameSize > header else { return 0 }
        let chunkSize = min(frameSize - header, MeshProtocol.maxPacket)
        return min(MeshProtocol.maxPacket, chunkSize * maxFragments)
    }

    static func canFragment(_ packetSize: Int, frameSize: Int) -> Bool {
        guard frameSize > header, packetSize >= 0 else { return false }
        return packetSize <= maxPacketSize(frameSize: frameSize)
    }

    static func fragment(_ packet: Data, frameSize: Int, streamId: UInt16) throws -> [Data] {
        guard packet.count <= MeshProtocol.maxPacket else { throw FragmenterError.packetTooLarge }
        guard frameSize > header else { throw FragmenterError.frameTooSmall }
        let chunkSize = frameSize - header
        let total = packet.isEmpty ? 1 : 1 + (packet.count - 1) / chunkSize
        guard total <= maxFragments else { throw FragmenterError.tooManyFragments }
        let p = Data(packet)
        return (0..<total).map { i in
            let start = i * chunkSize, end = min(p.count, start + chunkSize)
            var f = Data(capacity: header + end - start)
            f.append(UInt8(streamId >> 8)); f.append(UInt8(streamId & 0xff))
            f.append(UInt8(i)); f.append(UInt8(total))
            f.append(p.subdata(in: start..<end))
            return f
        }
    }
}

/// Reassembles frames from one link. Not thread-safe; owned by the link's queue.
final class Reassembler {
    private struct Stream {
        let total: Int
        let startedAt: TimeInterval
        var parts: [Data?]
        var have = 0
        var bufferedBytes = 0
    }

    private var streams: [UInt16: Stream] = [:]
    private var bufferedBytes = 0
    private let ttl: TimeInterval
    private let now: () -> TimeInterval

    init(ttl: TimeInterval = MeshProtocol.reassemblyTTL,
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        precondition(ttl.isFinite && ttl > 0, "reassembly ttl must be positive")
        self.ttl = ttl
        self.now = now
    }

    private func removeStream(_ streamId: UInt16) {
        if let stream = streams.removeValue(forKey: streamId) {
            bufferedBytes -= stream.bufferedBytes
        }
    }

    /// Purged on each push; the stream deadline is fixed by its first fragment.
    private func removeExpired(at timestamp: TimeInterval) {
        let expired = streams.compactMap { entry -> UInt16? in
            timestamp - entry.value.startedAt >= ttl ? entry.key : nil
        }
        for streamId in expired { removeStream(streamId) }
    }

    /// Returns the complete packet when the last fragment arrives.
    func push(_ frame: Data) -> Data? {
        let timestamp = now()
        removeExpired(at: timestamp)
        guard frame.count >= Fragmenter.header else { return nil }
        let start = frame.startIndex
        let streamId = UInt16(frame[start]) << 8 | UInt16(frame[start + 1])
        let partSize = frame.count - Fragmenter.header
        if partSize > MeshProtocol.maxPacket {
            removeStream(streamId)
            return nil
        }

        // Only copy after the input has passed the per-packet allocation bound.
        let f = Data(frame)
        let index = Int(f[2]), total = Int(f[3])
        guard total > 0, index < total else { return nil }

        var stream = streams[streamId]
        if let existing = stream, existing.total != total {
            removeStream(streamId)
            stream = nil
        }

        // Complete packets need no retained stream or active-stream slot.
        if total == 1 {
            removeStream(streamId)
            return f.subdata(in: Fragmenter.header..<f.count)
        }

        if stream == nil {
            guard streams.count < MeshProtocol.maxReassemblyStreams else { return nil }
            stream = Stream(total: total, startedAt: timestamp, parts: Array(repeating: nil, count: total))
        }

        var current = stream!
        if current.parts[index] == nil {
            if partSize > MeshProtocol.maxPacket - current.bufferedBytes ||
                partSize > MeshProtocol.maxReassemblyBytes - bufferedBytes {
                // Drop the whole stream rather than pinning a partial allocation at the cap.
                removeStream(streamId)
                return nil
            }
            let part = f.subdata(in: Fragmenter.header..<f.count)
            current.parts[index] = part
            current.have += 1
            current.bufferedBytes += part.count
            bufferedBytes += part.count
        }

        if current.have < total {
            streams[streamId] = current
            return nil
        }

        var packet = Data(capacity: current.bufferedBytes)
        for part in current.parts { packet.append(part!) }
        streams[streamId] = current
        removeStream(streamId)
        return packet
    }
}
