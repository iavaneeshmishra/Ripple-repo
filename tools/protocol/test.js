'use strict';
// Self-test of the reference implementation + a simulated 4-node mesh.
// Usage: node tools/protocol/test.js
const assert = require('assert');
const R = require('./ripple');
const { MeshNode } = require('./mesh-sim');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ✓', name); }

console.log('protocol');
test('node id = sha256(pubkey)[0:8]', () => {
  const id = R.generateIdentity();
  assert.strictEqual(id.nodeId.length, 8);
  assert.deepStrictEqual(id.nodeId, R.nodeIdFromPublicKey(id.publicKeyWire));
});

test('encode/decode round trip + signature verifies', () => {
  const a = R.generateIdentity();
  const p = R.buildPacket(a, { type: R.PacketType.MESSAGE, payload: Buffer.from('hi') });
  const d = R.decode(R.encode(p));
  assert.strictEqual(d.ttl, 7);
  assert.deepStrictEqual(d.payload, Buffer.from('hi'));
  assert.ok(R.verify(a.publicKey, R.encodeUnsigned(d), d.signature));
});

test('payload and transport limits are enforced before packet transmission', () => {
  const identity = R.generateIdentity();
  assert.doesNotThrow(() => R.buildPacket(identity, {
    type: R.PacketType.MESSAGE, payload: Buffer.alloc(R.MAX_PAYLOAD),
  }));
  assert.throws(() => R.buildPacket(identity, {
    type: R.PacketType.MESSAGE, payload: Buffer.alloc(R.MAX_PAYLOAD + 1),
  }), /payload too large/);

  const legacyFrameLimit = 16 * 255;
  assert.throws(() => R.fragment(Buffer.alloc(legacyFrameLimit + 1), 20, 1), /too many fragments/);
  const legacyFrames = R.fragment(Buffer.alloc(legacyFrameLimit), 20, 1);
  assert.strictEqual(legacyFrames.length, 255);
  assert.ok(legacyFrames.every((frame) => frame.length <= 20));
  const fullPacket = Buffer.alloc(R.MAX_PACKET, 0xa5);
  const fullPacketFrames = R.fragment(fullPacket, 23, 2);
  assert.strictEqual(fullPacketFrames.length, 222);
  assert.ok(fullPacketFrames.every((frame) => frame.length <= 23));
  const fullReassembler = new R.Reassembler();
  let rebuiltFullPacket = null;
  for (const frame of fullPacketFrames) rebuiltFullPacket = fullReassembler.push(frame) || rebuiltFullPacket;
  assert.deepStrictEqual(rebuiltFullPacket, fullPacket);

  const A = new MeshNode('A'), B = new MeshNode('B');
  MeshNode.link(A, B); MeshNode.settle();
  assert.throws(() => A.sendBroadcast('x'.repeat(R.MAX_PAYLOAD + 1)), /payload too large/);
  const directTextLimit = R.MAX_PAYLOAD - (65 + 12 + 16);
  const directText = `${'x'.repeat(directTextLimit - 3)}€`;
  assert.strictEqual(Buffer.byteLength(directText, 'utf8'), directTextLimit);
  A.sendDirect(B.router.selfId, directText);
  MeshNode.settle();
  assert.strictEqual(B.inbox.at(-1).text, directText);
  assert.throws(() => A.sendDirect(B.router.selfId, `${directText}x`), /payload too large/);
});

test('MESSAGE encryption mode must match broadcast versus unicast destination', () => {
  const alice = R.generateIdentity(), bob = R.generateIdentity();
  const direct = R.buildPacket(alice, {
    type: R.PacketType.MESSAGE, flags: R.Flags.ENCRYPTED, destination: bob.nodeId,
    payload: Buffer.alloc(65 + 12 + 16),
  });
  const invalidDirect = R.encode(direct);
  invalidDirect[2] = 0;
  assert.throws(() => R.decode(invalidDirect), /encryption mode/);
  assert.throws(() => R.buildPacket(alice, {
    type: R.PacketType.MESSAGE, destination: bob.nodeId, payload: Buffer.from('plaintext'),
  }), /encryption mode/);

  const broadcast = R.buildPacket(alice, { type: R.PacketType.MESSAGE, payload: Buffer.from('public') });
  const invalidBroadcast = R.encode(broadcast);
  invalidBroadcast[2] = R.Flags.ENCRYPTED;
  assert.throws(() => R.decode(invalidBroadcast), /encryption mode/);
  assert.throws(() => R.buildPacket(alice, {
    type: R.PacketType.MESSAGE, flags: R.Flags.ENCRYPTED, payload: Buffer.from('ciphertext'),
  }), /encryption mode/);
});

test('high-bit timestamp vector preserves the unsigned wire value', () => {
  const vector = require('../../protocol/test-vectors.json').highBitTimestamp;
  const packet = R.decode(Buffer.from(vector.fullPacket, 'hex'));
  const alice = R.identityFromPrivateScalar('11'.repeat(32));
  assert.strictEqual(packet.timestamp.toString(), vector.timestamp);
  assert.ok(R.verify(alice.publicKey, R.encodeUnsigned(packet), packet.signature));
});

test('ttl decrement keeps signature valid; payload tamper breaks it', () => {
  const a = R.generateIdentity();
  const p = R.buildPacket(a, { type: R.PacketType.MESSAGE, payload: Buffer.from('hi') });
  const relayed = { ...p, ttl: 3 };
  assert.ok(R.verify(a.publicKey, R.encodeUnsigned(relayed), p.signature));
  const bad = { ...p, payload: Buffer.from('ho') };
  assert.ok(!R.verify(a.publicKey, R.encodeUnsigned(bad), p.signature));
});

test('announce payload round trip (unicode name)', () => {
  const a = R.generateIdentity();
  const d = R.decodeAnnounce(R.encodeAnnounce(a, 'Zoë 🚀'));
  assert.strictEqual(d.name, 'Zoë 🚀');
  assert.deepStrictEqual(d.publicKeyWire, a.publicKeyWire);
});

test('ECIES round trip and AAD binding', () => {
  const a = R.generateIdentity(), b = R.generateIdentity();
  const messageId = Buffer.alloc(16, 7);
  const box = R.eciesEncrypt({ recipientWire: b.publicKeyWire, messageId, source: a.nodeId, destination: b.nodeId, plaintext: Buffer.from('x') });
  assert.strictEqual(R.eciesDecrypt({ recipientIdentity: b, messageId, source: a.nodeId, destination: b.nodeId, payload: box }).toString(), 'x');
  assert.throws(() => R.eciesDecrypt({ recipientIdentity: b, messageId, source: b.nodeId, destination: b.nodeId, payload: box }));
  assert.throws(() => R.eciesDecrypt({ recipientIdentity: a, messageId, source: a.nodeId, destination: b.nodeId, payload: box }));
});

test('fragment/reassemble in and out of order', () => {
  const data = Buffer.from(Array.from({ length: 777 }, (_, i) => i % 251));
  const frames = R.fragment(data, 100, 42);
  assert.strictEqual(frames.length, 9);
  const r = new R.Reassembler();
  const shuffled = [...frames].reverse();
  let out = null;
  for (const f of shuffled) { const res = r.push(f); if (res) out = res; }
  assert.deepStrictEqual(out, data);
});

test('fragmentation and reassembly reject packets above MAX_PACKET', () => {
  assert.throws(() => R.fragment(Buffer.alloc(R.MAX_PACKET + 1), 512, 1));
  const header = Buffer.alloc(4);
  header.writeUInt16BE(1, 0); header[2] = 0; header[3] = 1;
  const oversizedFrame = Buffer.concat([header, Buffer.alloc(R.MAX_PACKET + 1)]);
  assert.strictEqual(new R.Reassembler().push(oversizedFrame), null);

  const multipart = new R.Reassembler();
  header[2] = 0; header[3] = 2;
  assert.strictEqual(multipart.push(Buffer.concat([header, Buffer.alloc(R.MAX_PACKET)])), null);
  header[2] = 1;
  assert.strictEqual(multipart.push(Buffer.concat([header, Buffer.from([1])])), null);
});

test('reassembly caps active streams and aggregate buffered bytes', () => {
  const makeFrame = (streamId, index, total, payload = Buffer.alloc(0)) => {
    const header = Buffer.alloc(4);
    header.writeUInt16BE(streamId, 0); header[2] = index; header[3] = total;
    return Buffer.concat([header, payload]);
  };

  const capped = new R.Reassembler();
  for (let id = 0; id < R.MAX_REASSEMBLY_STREAMS; id++) {
    assert.strictEqual(capped.push(makeFrame(id, 0, 2, Buffer.from([id])), 0), null);
  }
  assert.strictEqual(capped.push(makeFrame(99, 0, 2, Buffer.from([99])), 0), null);
  assert.strictEqual(capped.push(makeFrame(99, 1, 2, Buffer.from([100])), 1), null);
  assert.deepStrictEqual(capped.push(makeFrame(0, 1, 2, Buffer.from([1])), 2), Buffer.from([0, 1]));
  assert.strictEqual(capped.push(makeFrame(99, 0, 2, Buffer.from([99])), 3), null);
  assert.deepStrictEqual(capped.push(makeFrame(99, 1, 2, Buffer.from([100])), 4), Buffer.from([99, 100]));

  const worstCase = new R.Reassembler(1000);
  for (let id = 0; id < R.MAX_REASSEMBLY_STREAMS; id++) {
    assert.strictEqual(worstCase.push(makeFrame(id, 0, 255), 0), null);
  }
  assert.strictEqual(worstCase.push(makeFrame(99, 0, 2, Buffer.from([99])), 0), null);
  assert.strictEqual(worstCase.push(makeFrame(99, 1, 2, Buffer.from([100])), 1), null);
  assert.strictEqual(worstCase.push(makeFrame(100, 0, 2, Buffer.from([10])), 1000), null);
  assert.deepStrictEqual(worstCase.push(makeFrame(100, 1, 2, Buffer.from([11])), 1001), Buffer.from([10, 11]));

  const buffered = new R.Reassembler();
  const maxPart = Buffer.alloc(R.MAX_PACKET, 0x61);
  for (let id = 0; id < 7; id++) assert.strictEqual(buffered.push(makeFrame(id, 0, 2, maxPart), 0), null);
  const remaining = R.MAX_REASSEMBLY_BYTES - 7 * R.MAX_PACKET;
  const lastPart = Buffer.alloc(remaining, 0x62);
  assert.strictEqual(buffered.push(makeFrame(7, 0, 2, lastPart), 0), null);
  assert.deepStrictEqual(buffered.push(makeFrame(7, 1, 2), 0), lastPart);

  assert.strictEqual(buffered.push(makeFrame(7, 0, 2, lastPart), 0), null);
  assert.strictEqual(buffered.push(makeFrame(7, 1, 2, Buffer.from([0x63])), 0), null);
  assert.deepStrictEqual(buffered.push(makeFrame(0, 1, 2), 0), maxPart);
  assert.strictEqual(buffered.push(makeFrame(7, 1, 2, Buffer.from([0x63])), 0), null);
  assert.deepStrictEqual(
    buffered.push(makeFrame(7, 0, 2, lastPart), 0),
    Buffer.concat([lastPart, Buffer.from([0x63])]),
  );
});

test('reassembly expires incomplete streams at a fixed deadline', () => {
  const makeFrame = (streamId, index, payload) => {
    const header = Buffer.alloc(4);
    header.writeUInt16BE(streamId, 0); header[2] = index; header[3] = 2;
    return Buffer.concat([header, payload]);
  };
  const r = new R.Reassembler(1000);
  assert.strictEqual(r.push(makeFrame(1, 0, Buffer.from([1])), 0), null);
  assert.deepStrictEqual(r.push(makeFrame(1, 1, Buffer.from([2])), 999), Buffer.from([1, 2]));
  assert.strictEqual(r.push(makeFrame(2, 0, Buffer.from([3])), 2000), null);
  assert.strictEqual(r.push(makeFrame(2, 1, Buffer.from([4])), 3000), null);
  assert.deepStrictEqual(r.push(makeFrame(2, 0, Buffer.from([5])), 3001), Buffer.from([5, 4]));
});

test('decode rejects bad version / truncated', () => {
  const a = R.generateIdentity();
  const bytes = R.encode(R.buildPacket(a, { type: R.PacketType.MESSAGE, payload: Buffer.from('hi') }));
  assert.throws(() => R.decode(Buffer.concat([Buffer.from([9]), bytes.subarray(1)])));
  assert.throws(() => R.decode(bytes.subarray(0, 50)));
});

test('ttl above MAX_TTL is rejected even though ttl is excluded from the signature', () => {
  const a = R.generateIdentity();
  const valid = R.encode(R.buildPacket(a, { type: R.PacketType.MESSAGE, payload: Buffer.from('hi') }));
  for (const ttl of [R.MAX_TTL + 1, 255]) {
    const mutated = Buffer.from(valid);
    mutated[3] = ttl;
    const unsigned = mutated.subarray(0, mutated.length - R.SIGNATURE_SIZE);
    const signature = mutated.subarray(mutated.length - R.SIGNATURE_SIZE);
    assert.ok(R.verify(a.publicKey, unsigned, signature), 'ttl remains outside the signature');
    assert.throws(() => R.decode(mutated));
  }
  assert.throws(() => R.buildPacket(a, { type: R.PacketType.MESSAGE, ttl: R.MAX_TTL + 1, payload: Buffer.from('hi') }));
  assert.throws(() => R.encodeUnsigned({ ...R.decode(valid), ttl: 255 }));
});

console.log('mesh simulation');
test('4-node line: broadcast reaches everyone, direct message is E2E + acked', () => {
  // A - B - C - D  (each only in range of its neighbours)
  const nodes = ['A', 'B', 'C', 'D'].map((n) => new MeshNode(n));
  const [A, B, C, D] = nodes;
  MeshNode.link(A, B); MeshNode.link(B, C); MeshNode.link(C, D);
  MeshNode.settle();

  // Everyone learned everyone via flooded announces.
  for (const n of nodes) assert.strictEqual(n.router.peers.size, 3, `${n.name} peers`);

  A.sendBroadcast('hello all');
  MeshNode.settle();
  for (const n of [B, C, D]) assert.strictEqual(n.inbox.at(-1).text, 'hello all');

  const id = A.sendDirect(D.router.selfId, 'only for D');
  MeshNode.settle();
  assert.strictEqual(D.inbox.at(-1).text, 'only for D');
  // Relays never saw plaintext (they only got the ECIES box).
  assert.ok(!B.inbox.some((m) => m.text === 'only for D'));
  assert.ok(!C.inbox.some((m) => m.text === 'only for D'));
  // A got the ACK from D.
  assert.ok(A.acks.some((a) => a.equals(id)));
  // Hop count: D sees A at 3 hops.
  assert.strictEqual(D.router.peers.get(A.router.selfId.toString('hex')).hops, 3);
});

test('a signed unencrypted unicast MESSAGE is dropped without delivery or ACK', () => {
  const A = new MeshNode('A'), B = new MeshNode('B');
  MeshNode.link(A, B); MeshNode.settle();
  const broadcast = R.buildPacket(A.router.identity, {
    type: R.PacketType.MESSAGE, payload: Buffer.from('must not be exposed'),
  });
  const unsigned = R.encodeUnsigned(broadcast);
  B.router.selfId.copy(unsigned, 28); // valid signature, but now unicast with ENCRYPTED clear
  const wire = Buffer.concat([unsigned, R.sign(A.router.identity, unsigned)]);
  B.router.onReceive(B._links[0], wire);
  MeshNode.settle();
  assert.ok(!B.inbox.some((message) => message.text === 'must not be exposed'));
  assert.ok(!Array.from(B.router.relayStore.values()).some((entry) =>
    entry.packet.type === R.PacketType.ACK && entry.packet.payload.equals(broadcast.messageId)));
});

test('high-bit unsigned timestamps are rejected before delivery or relay', () => {
  const A = new MeshNode('A'), B = new MeshNode('B');
  MeshNode.link(A, B); MeshNode.settle();
  const packet = R.buildPacket(A.router.identity, {
    type: R.PacketType.MESSAGE, payload: Buffer.from('future timestamp'),
    timestamp: 0x8000000000000000n,
  });
  const bytes = R.encode(packet);
  const linkFromA = B._links.find((link) => link.remote === A);
  B.router.onReceive(linkFromA, bytes);
  MeshNode.settle();
  assert.ok(!B.inbox.some((message) => message.text === 'future timestamp'));
  assert.ok(!B.router.relayStore.has(packet.messageId.toString('hex')));
});

test('ACK is accepted only from the intended recipient for an owned direct message', () => {
  const A = new MeshNode('A'), B = new MeshNode('B'), C = new MeshNode('C');
  MeshNode.link(A, B); MeshNode.link(A, C); MeshNode.settle();

  const directId = A.sendDirect(B.router.selfId, 'ack only from B');
  const linkFromC = A._links.find((link) => link.remote === C);
  const buildAck = (sender, acknowledged, destination = A.router.selfId) => R.buildPacket(sender.router.identity, {
    type: R.PacketType.ACK, destination, payload: acknowledged,
  });

  A.router.onReceive(linkFromC, R.encode(buildAck(C, directId)));
  assert.ok(!A.acks.some((id) => id.equals(directId)), 'a different known peer cannot ACK this message');

  const orphanId = Buffer.alloc(16, 0x55);
  A.router.onReceive(A._links.find((link) => link.remote === B), R.encode(buildAck(B, orphanId)));
  assert.ok(!A.acks.some((id) => id.equals(orphanId)), 'unknown message IDs cannot be ACKed');

  const broadcastId = A.sendBroadcast('broadcasts are not acked');
  A.router.onReceive(A._links.find((link) => link.remote === B), R.encode(buildAck(B, broadcastId)));
  assert.ok(!A.acks.some((id) => id.equals(broadcastId)), 'broadcasts cannot be ACKed');

  A.router.onReceive(A._links.find((link) => link.remote === B), R.encode(buildAck(B, directId, R.BROADCAST_ID)));
  assert.ok(!A.acks.some((id) => id.equals(directId)), 'ACKs must be unicast');

  const acksBeforeMalformed = A.acks.length;
  A.router.onReceive(A._links.find((link) => link.remote === B), R.encode(buildAck(B, Buffer.alloc(15))));
  assert.strictEqual(A.acks.length, acksBeforeMalformed, 'ACK payloads must match the message ID size');

  A.router.onReceive(A._links.find((link) => link.remote === B), R.encode(buildAck(B, directId)));
  assert.ok(A.acks.some((id) => id.equals(directId)), 'the intended recipient can ACK the outgoing direct message');

  A.router.relayStore.get(directId.toString('hex')).expiresAt = Date.now() - 1;
  A.router.onReceive(A._links.find((link) => link.remote === B), R.encode(buildAck(B, directId)));
  assert.strictEqual(A.acks.filter((id) => id.equals(directId)).length, 1, 'expired outgoing messages are no longer ACKed');
  MeshNode.settle(); // Drain the simulated direct/broadcast sends before the next test.
});

test('future timestamps use the separate skew limit and reject values beyond it', () => {
  const A = new MeshNode('A'), B = new MeshNode('B');
  MeshNode.link(A, B); MeshNode.settle();
  const now = Date.now();
  const linkFromA = B._links.find((link) => link.remote === A);
  const atLimit = R.buildPacket(A.router.identity, {
    type: R.PacketType.MESSAGE, payload: Buffer.from('within future skew'),
    timestamp: BigInt(now + R.MAX_FUTURE_SKEW_MS),
  });
  const beyondLimit = R.buildPacket(A.router.identity, {
    type: R.PacketType.MESSAGE, payload: Buffer.from('beyond future skew'),
    timestamp: BigInt(now + R.MAX_FUTURE_SKEW_MS + 1),
  });
  B.router.onReceive(linkFromA, R.encode(atLimit), now);
  MeshNode.settle();
  B.router.onReceive(linkFromA, R.encode(beyondLimit), now);
  MeshNode.settle();
  assert.ok(B.inbox.some((message) => message.text === 'within future skew'));
  assert.ok(!B.inbox.some((message) => message.text === 'beyond future skew'));
});

test('seen cache suppresses duplicates for 24 h and then expires', () => {
  const A = new MeshNode('A'), B = new MeshNode('B');
  MeshNode.link(A, B); MeshNode.settle();
  const now = Date.now();
  const messageId = Buffer.alloc(16, 0x5b);
  const payload = R.eciesEncrypt({
    recipientWire: B.router.identity.publicKeyWire,
    messageId,
    source: A.router.selfId,
    destination: B.router.selfId,
    plaintext: Buffer.from('replay-window'),
  });
  const packet = R.buildPacket(A.router.identity, {
    type: R.PacketType.MESSAGE, flags: R.Flags.ENCRYPTED, destination: B.router.selfId,
    messageId, timestamp: BigInt(now), payload,
  });
  const bytes = R.encode(packet);
  const linkFromA = B._links.find((link) => link.remote === A);

  B.router.onReceive(linkFromA, bytes, now);
  MeshNode.settle();
  assert.strictEqual(B.inbox.filter((message) => message.messageId.equals(messageId)).length, 1);
  B.router.onReceive(linkFromA, bytes, now + R.SEEN_TTL_MS - 1);
  MeshNode.settle();
  assert.strictEqual(B.inbox.filter((message) => message.messageId.equals(messageId)).length, 1);
  B.router.onReceive(linkFromA, bytes, now + R.SEEN_TTL_MS + 1);
  MeshNode.settle();
  assert.strictEqual(B.inbox.filter((message) => message.messageId.equals(messageId)).length, 2);
});

test('live relay entry suppresses duplicates after the seen-cache lifetime expires', () => {
  const A = new MeshNode('A'), B = new MeshNode('B'), C = new MeshNode('C');
  MeshNode.link(A, B); MeshNode.link(B, C); MeshNode.settle();
  const now = Date.now();
  const packet = R.buildPacket(A.router.identity, {
    type: R.PacketType.MESSAGE, payload: Buffer.from('still retained'), timestamp: BigInt(now),
  });
  const bytes = R.encode(packet);
  const linkFromA = B._links.find((link) => link.remote === A);
  B.router.onReceive(linkFromA, bytes, now);
  MeshNode.settle();
  assert.strictEqual(B.inbox.filter((message) => message.messageId.equals(packet.messageId)).length, 1);
  assert.ok(B.router.relayStore.has(packet.messageId.toString('hex')));

  B.router.onReceive(linkFromA, bytes, now + R.SEEN_TTL_MS + 1);
  MeshNode.settle();
  assert.strictEqual(B.inbox.filter((message) => message.messageId.equals(packet.messageId)).length, 1);
});

test('expired relay-store entries are not replayed when a peer reconnects', () => {
  const A = new MeshNode('A'), B = new MeshNode('B'), C = new MeshNode('C');
  MeshNode.link(A, B); MeshNode.settle();
  const id = A.sendBroadcast('expired relay'); MeshNode.settle();
  const entry = B.router.relayStore.get(id.toString('hex'));
  assert.ok(entry);
  entry.expiresAt = Date.now() - 1;

  MeshNode.link(B, C); MeshNode.settle();
  assert.ok(!C.inbox.some((message) => message.messageId.equals(id)));
});

test('store-and-forward: message queued while offline is delivered when link appears', () => {
  const A = new MeshNode('A'), B = new MeshNode('B'), C = new MeshNode('C');
  MeshNode.link(A, B); MeshNode.link(B, C); MeshNode.settle();
  MeshNode.unlink(B, C);            // C walks out of range
  A.sendDirect(C.router.selfId, 'catch up later');
  MeshNode.settle();
  assert.strictEqual(C.inbox.length, 0);
  MeshNode.link(B, C);              // C comes back
  MeshNode.settle();
  assert.strictEqual(C.inbox.at(-1).text, 'catch up later');
});

test('loops do not amplify: triangle delivers exactly once', () => {
  const A = new MeshNode('A'), B = new MeshNode('B'), C = new MeshNode('C');
  MeshNode.link(A, B); MeshNode.link(B, C); MeshNode.link(A, C); MeshNode.settle();
  A.sendBroadcast('once');
  MeshNode.settle();
  assert.strictEqual(B.inbox.filter((m) => m.text === 'once').length, 1);
  assert.strictEqual(C.inbox.filter((m) => m.text === 'once').length, 1);
});

test('ttl bound: 9-node line, node 9 is out of reach with MAX_TTL=7', () => {
  const nodes = Array.from({ length: 9 }, (_, i) => new MeshNode(String(i)));
  for (let i = 0; i < 8; i++) MeshNode.link(nodes[i], nodes[i + 1]);
  MeshNode.settle();
  nodes[0].sendBroadcast('far');
  MeshNode.settle();
  assert.strictEqual(nodes[7].inbox.at(-1)?.text, 'far');   // 7 hops: ttl 7→1, delivered
  assert.strictEqual(nodes[8].inbox.length, 0);              // would need an 8th hop
});

console.log('sos & policy');
test('SOS payload round trips (opt-in GPS) and omits location when not shared', () => {
  const loc = { latE7: 285430001, lngE7: 7709002, accuracyMeters: 15 };
  const p1 = R.decodeSos(R.encodeSos({ text: 'need help 📍', location: loc }));
  assert.strictEqual(p1.text, 'need help 📍');
  assert.deepStrictEqual(p1.location, loc);
  const p2 = R.decodeSos(R.encodeSos({ text: 'can you hear me?' }));
  assert.strictEqual(p2.location, null);
  assert.strictEqual(p2.text, 'can you hear me?');
  assert.strictEqual(R.encodeSos({}).length, 2); // bare beacon = 2-byte header only
});

test('rate limiter caps bursts within a window and refills after it', () => {
  const lim = new R.RateLimiter(3, 1000);
  const t0 = 1_000_000;
  assert.ok([0, 1, 2].every(() => lim.allow(t0)));
  assert.ok(!lim.allow(t0));          // budget spent
  assert.ok(lim.allow(t0 + 1001));    // window slid forward, a slot freed
});

test('SOS beacon floods the whole mesh and carries the opted-in GPS fix', () => {
  const nodes = ['A', 'B', 'C', 'D'].map((n) => new MeshNode(n));
  const [A, B, C, D] = nodes;
  MeshNode.link(A, B); MeshNode.link(B, C); MeshNode.link(C, D);
  MeshNode.settle();
  const loc = { latE7: 1234567, lngE7: -7654321, accuracyMeters: 20 };
  A.sendSos('trapped in valley', loc);
  MeshNode.settle();
  for (const n of [B, C, D]) {
    assert.strictEqual(n.sosInbox.length, 1, `${n.name} sos count`);
    assert.strictEqual(n.sosInbox.at(-1).text, 'trapped in valley');
    assert.deepStrictEqual(n.sosInbox.at(-1).location, loc);
  }
  // Beacons are not plain chat messages.
  assert.ok(!B.inbox.some((m) => m.text === 'trapped in valley'));
});

test('power-saver relays SOS but stops relaying ordinary broadcasts', () => {
  const A = new MeshNode('A'), B = new MeshNode('B'), C = new MeshNode('C');
  MeshNode.link(A, B); MeshNode.link(B, C); MeshNode.settle();
  B.router.setBatteryProfile(R.BatteryProfile.POWER_SAVER);
  A.sendBroadcast('anyone around?');      // ordinary chat must NOT be forwarded
  MeshNode.settle();
  assert.strictEqual(C.inbox.length, 0);
  A.sendSos('in trouble');                // …but the SOS beacon still floods
  MeshNode.settle();
  assert.strictEqual(C.sosInbox.length, 1);
});

test('72 h store-and-forward retention and battery relay policy', () => {
  assert.strictEqual(R.RELAY_RETENTION_MS, 72 * 3600 * 1000);
  assert.ok(R.relaysOrdinary(R.BatteryProfile.BALANCED));
  assert.ok(R.relaysOrdinary(R.BatteryProfile.PERFORMANCE));
  assert.ok(!R.relaysOrdinary(R.BatteryProfile.POWER_SAVER));
  const n = new MeshNode('x');
  assert.strictEqual(n.router.relayRetentionMs, R.RELAY_RETENTION_MS);
});

console.log(`\n${passed} tests passed`);
