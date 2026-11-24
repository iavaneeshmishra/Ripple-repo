import XCTest
@testable import Ripple

/// Simulated mesh with in-memory links. Mirrors tools/protocol/test.js and the
/// Kotlin MeshRouterTest so all three routers are held to the same behaviour.
final class MeshRouterTests: XCTestCase {
    final class Net {
        var queue: [(FakeLink, Data)] = []
        func settle() {
            var guardCount = 100_000
            while !queue.isEmpty && guardCount > 0 {
                guardCount -= 1
                let (link, bytes) = queue.removeFirst()
                guard link.open, link.twin.open else { continue }
                link.remote.router.onReceive(link.twin, bytes)
            }
            XCTAssertGreaterThan(guardCount, 0, "network did not settle")
        }
    }

    final class FakeLink: Link {
        let id: String
        var peerHex: String?
        unowned let owner: Node, remote: Node
        unowned let net: Net
        var twin: FakeLink!
        var open = true
        init(owner: Node, remote: Node, net: Net) { self.owner = owner; self.remote = remote; self.net = net; id = "\(owner.name)->\(remote.name)" }
        func send(_ packetBytes: Data) { if open { net.queue.append((self, packetBytes)) } }
        func close() { MeshRouterTests.unlink(owner, remote) }
    }

    final class Node: RouterListener {
        let name: String
        var inbox: [InboundMessage] = []
        var acks: [Data] = []
        var links: [FakeLink] = []
        var router: MeshRouter!
        init(_ name: String, now: @escaping () -> Date = { Date() }) {
            self.name = name
            router = MeshRouter(identity: .generate(), displayName: name, listener: nil, now: now)
            router.listener = self
        }
        func router(_ router: MeshRouter, didReceive message: InboundMessage) { inbox.append(message) }
        func router(_ router: MeshRouter, didReceiveAck messageId: Data, from: NodeId) { acks.append(messageId) }
        func router(_ router: MeshRouter, peersDidChange peers: [Peer]) {}
    }

    static func link(_ a: Node, _ b: Node, net: Net) {
        let la = FakeLink(owner: a, remote: b, net: net), lb = FakeLink(owner: b, remote: a, net: net)
        la.twin = lb; lb.twin = la
        a.links.append(la); b.links.append(lb)
        a.router.onLinkReady(la); b.router.onLinkReady(lb)
    }

    static func unlink(_ a: Node, _ b: Node) {
        for (n, other) in [(a, b), (b, a)] {
            for l in n.links where l.remote === other { l.open = false; n.router.onLinkClosed(l) }
            n.links.removeAll { $0.remote === other }
        }
    }

    func testLineOfFour() throws {
        let net = Net()
        let a = Node("A"), b = Node("B"), c = Node("C"), d = Node("D")
        Self.link(a, b, net: net); Self.link(b, c, net: net); Self.link(c, d, net: net); net.settle()

        for n in [a, b, c, d] { XCTAssertEqual(n.router.allPeers().count, 3, "\(n.name) peers") }

        try a.router.sendBroadcast("hello all"); net.settle()
        for n in [b, c, d] { XCTAssertEqual(n.inbox.last?.text, "hello all") }

        let id = try a.router.sendDirect(to: d.router.selfId, text: "only for D"); net.settle()
        XCTAssertEqual(d.inbox.last?.text, "only for D")
        XCTAssertTrue(d.inbox.last!.verified)
        XCTAssertFalse(b.inbox.contains { $0.text == "only for D" })
        XCTAssertFalse(c.inbox.contains { $0.text == "only for D" })
        XCTAssertTrue(a.acks.contains(id))
        XCTAssertEqual(d.router.peer(a.router.selfId)?.hops, 3)
    }

    func testSignedUnencryptedUnicastMessageIsDroppedWithoutDeliveryOrAck() throws {
        let net = Net()
        let a = Node("A"), b = Node("B")
        Self.link(a, b, net: net); net.settle()

        let broadcast = try PacketFactory.broadcastText(a.router.identity, "must not be exposed")
        var unsigned = broadcast.encodeUnsigned()
        unsigned.replaceSubrange(28..<36, with: b.router.selfId.bytes) // valid signature, invalid mode
        let wire = unsigned + (try a.router.identity.sign(unsigned))
        b.router.onReceive(b.links.first { $0.remote === a }!, wire); net.settle()

        XCTAssertFalse(b.inbox.contains { $0.text == "must not be exposed" })
        XCTAssertFalse(b.router.relayStoreSnapshot().contains {
            $0.packet.type == .ack && $0.packet.payload == broadcast.messageId
        })
    }

    func testHighBitUnsignedTimestampIsRejectedBeforeDeliveryOrRelay() throws {
        let net = Net()
        let a = Node("A"), b = Node("B")
        Self.link(a, b, net: net); net.settle()

        let packet = try PacketFactory.broadcastText(a.router.identity, "future timestamp")
        var unsigned = packet.encodeUnsigned()
        unsigned.replaceSubrange(36..<44, with: Data([0x80, 0, 0, 0, 0, 0, 0, 0]))
        let wire = unsigned + (try a.router.identity.sign(unsigned))
        let linkFromA = b.links.first { $0.remote === a }!
        b.router.onReceive(linkFromA, wire); net.settle()

        XCTAssertFalse(b.inbox.contains { $0.text == "future timestamp" })
        XCTAssertFalse(b.router.relayStoreSnapshot().contains { $0.packet.messageId == packet.messageId })
    }

    func testAckRequiresTheIntendedRecipientAndAnOwnedDirectMessage() throws {
        let net = Net()
        let a = Node("A"), b = Node("B"), c = Node("C")
        Self.link(a, b, net: net); Self.link(a, c, net: net); net.settle()

        let directId = try a.router.sendDirect(to: b.router.selfId, text: "ack only from B")
        let linkFromC = a.links.first { $0.remote === c }!
        let wrongRecipientAck = try PacketFactory.ack(c.router.identity, to: a.router.selfId, acknowledged: directId)
        a.router.onReceive(linkFromC, wrongRecipientAck.encode())
        XCTAssertFalse(a.acks.contains(directId))

        let orphanId = Data(repeating: 0x55, count: MeshProtocol.messageIdSize)
        let orphanAck = try PacketFactory.ack(b.router.identity, to: a.router.selfId, acknowledged: orphanId)
        a.router.onReceive(a.links.first { $0.remote === b }!, orphanAck.encode())
        XCTAssertFalse(a.acks.contains(orphanId))

        let broadcastId = try a.router.sendBroadcast("broadcasts are not acked")
        let broadcastAck = try PacketFactory.ack(b.router.identity, to: a.router.selfId, acknowledged: broadcastId)
        a.router.onReceive(a.links.first { $0.remote === b }!, broadcastAck.encode())
        XCTAssertFalse(a.acks.contains(broadcastId))

        let ackCountBeforeMalformed = a.acks.count
        let malformedAck = try PacketFactory.ack(b.router.identity, to: a.router.selfId,
                                                 acknowledged: Data(repeating: 0x22, count: MeshProtocol.messageIdSize - 1))
        a.router.onReceive(a.links.first { $0.remote === b }!, malformedAck.encode())
        XCTAssertEqual(a.acks.count, ackCountBeforeMalformed)

        let validAck = try PacketFactory.ack(b.router.identity, to: a.router.selfId, acknowledged: directId)
        a.router.onReceive(a.links.first { $0.remote === b }!, validAck.encode())
        XCTAssertTrue(a.acks.contains(directId))
    }

    func testFutureTimestampUsesSeparateSkewLimitAndRejectsBeyondIt() throws {
        let net = Net()
        var now = Date()
        let a = Node("A"), b = Node("B", now: { now })
        Self.link(a, b, net: net); net.settle()
        now = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970))
        let nowMs = UInt64(now.timeIntervalSince1970 * 1000)
        let skewMs = UInt64(MeshProtocol.maxFutureSkew * 1000)

        let atLimit = try PacketFactory.build(a.router.identity, type: .message,
                                              payload: Data("within future skew".utf8),
                                              timestamp: nowMs + skewMs)
        let beyondLimit = try PacketFactory.build(a.router.identity, type: .message,
                                                  payload: Data("beyond future skew".utf8),
                                                  timestamp: nowMs + skewMs + 1)
        let linkFromA = b.links.first { $0.remote === a }!
        b.router.onReceive(linkFromA, atLimit.encode()); net.settle()
        b.router.onReceive(linkFromA, beyondLimit.encode()); net.settle()

        XCTAssertTrue(b.inbox.contains { $0.text == "within future skew" })
        XCTAssertFalse(b.inbox.contains { $0.text == "beyond future skew" })
    }

    func testSeenCacheSuppressesRetriesFor24HoursThenExpires() throws {
        let net = Net()
        var now = Date()
        let a = Node("A"), b = Node("B", now: { now })
        Self.link(a, b, net: net); net.settle()

        let packet = try PacketFactory.directText(a.router.identity, to: b.router.selfId,
                                                  recipientWire: b.router.identity.publicKeyWire, text: "replay window")
        let bytes = packet.encode()
        let linkFromA = b.links.first { $0.remote === a }!
        b.router.onReceive(linkFromA, bytes); net.settle()
        XCTAssertEqual(b.inbox.filter { $0.messageId == packet.messageId }.count, 1)

        now = now.addingTimeInterval(MeshProtocol.seenTTL - 1)
        b.router.onReceive(linkFromA, bytes); net.settle()
        XCTAssertEqual(b.inbox.filter { $0.messageId == packet.messageId }.count, 1)

        now = now.addingTimeInterval(2)
        b.router.onReceive(linkFromA, bytes); net.settle()
        XCTAssertEqual(b.inbox.filter { $0.messageId == packet.messageId }.count, 2)
    }

    func testRelayExpirySurvivesSnapshotAndRestoreWithoutExtension() throws {
        var now = Date(timeIntervalSince1970: 1_000)
        let source = MeshRouter(identity: .generate(), displayName: "A", listener: nil, now: { now })
        let messageId = try source.sendBroadcast("expires on schedule")
        let saved = try XCTUnwrap(source.relayStoreSnapshot().first { $0.packet.messageId == messageId })
        XCTAssertEqual(saved.expiresAt, now.addingTimeInterval(MeshProtocol.relayTTL))

        now = now.addingTimeInterval(30)
        let restored = MeshRouter(identity: source.identity, displayName: "A", listener: nil, now: { now })
        restored.importRelayStore([saved])
        let imported = try XCTUnwrap(restored.relayStoreSnapshot().first)
        XCTAssertEqual(imported.expiresAt, saved.expiresAt)
        XCTAssertEqual(imported.expiresAt.timeIntervalSince(now), MeshProtocol.relayTTL - 30, accuracy: 0.001)

        now = saved.expiresAt
        XCTAssertTrue(restored.relayStoreSnapshot().isEmpty)
        let afterExpiry = MeshRouter(identity: source.identity, displayName: "A", listener: nil, now: { now })
        afterExpiry.importRelayStore([saved])
        XCTAssertTrue(afterExpiry.relayStoreSnapshot().isEmpty)
    }

    func testLiveRelayEntrySuppressesDuplicatesAfterSeenCacheExpires() throws {
        let net = Net()
        var now = Date()
        let a = Node("A"), b = Node("B", now: { now }), c = Node("C")
        Self.link(a, b, net: net); Self.link(b, c, net: net); net.settle()

        let packet = try PacketFactory.broadcastText(a.router.identity, "still retained")
        let bytes = packet.encode()
        let linkFromA = b.links.first { $0.remote === a }!
        b.router.onReceive(linkFromA, bytes); net.settle()
        XCTAssertEqual(b.inbox.filter { $0.messageId == packet.messageId }.count, 1)
        XCTAssertTrue(b.router.relayStoreSnapshot().contains { $0.packet.messageId == packet.messageId })

        now = now.addingTimeInterval(MeshProtocol.seenTTL + 1)
        b.router.onReceive(linkFromA, bytes); net.settle()
        XCTAssertEqual(b.inbox.filter { $0.messageId == packet.messageId }.count, 1)
    }

    func testExpiredRelayEntryIsNotReplayedWhenPeerReconnects() throws {
        let net = Net()
        var now = Date()
        let a = Node("A"), b = Node("B", now: { now })
        Self.link(a, b, net: net); net.settle()
        let id = try a.router.sendBroadcast("expired relay"); net.settle()

        now = now.addingTimeInterval(MeshProtocol.relayTTL)
        let c = Node("C")
        Self.link(b, c, net: net); net.settle()
        XCTAssertFalse(c.inbox.contains { $0.messageId == id })
    }

    func testStoreAndForward() throws {
        let net = Net()
        let a = Node("A"), b = Node("B"), c = Node("C")
        Self.link(a, b, net: net); Self.link(b, c, net: net); net.settle()
        Self.unlink(b, c)
        try a.router.sendDirect(to: c.router.selfId, text: "catch up later"); net.settle()
        XCTAssertTrue(c.inbox.isEmpty)
        Self.link(b, c, net: net); net.settle()
        XCTAssertEqual(c.inbox.last?.text, "catch up later")
    }

    func testTriangleDeliversOnce() throws {
        let net = Net()
        let a = Node("A"), b = Node("B"), c = Node("C")
        Self.link(a, b, net: net); Self.link(b, c, net: net); Self.link(a, c, net: net); net.settle()
        try a.router.sendBroadcast("once"); net.settle()
        XCTAssertEqual(b.inbox.filter { $0.text == "once" }.count, 1)
        XCTAssertEqual(c.inbox.filter { $0.text == "once" }.count, 1)
    }

    func testTTLBound() throws {
        let net = Net()
        let nodes = (0..<9).map { Node("\($0)") }
        for i in 0..<8 { Self.link(nodes[i], nodes[i + 1], net: net) }
        net.settle()
        try nodes[0].router.sendBroadcast("far"); net.settle()
        XCTAssertEqual(nodes[7].inbox.last?.text, "far")
        XCTAssertNil(nodes[8].inbox.last)
    }

    func testForgedPacketDropped() throws {
        let net = Net()
        let a = Node("A"), b = Node("B")
        Self.link(a, b, net: net); net.settle()
        let mallory = Identity.generate()
        var forged = try PacketFactory.broadcastText(mallory, "pwned")
        forged.source = a.router.selfId
        forged.signature = try mallory.sign(forged.encodeUnsigned())
        b.router.onReceive(b.links[0], forged.encode()); net.settle()
        XCTAssertFalse(b.inbox.contains { $0.text == "pwned" })
    }
}
