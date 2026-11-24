# Ripple Mesh Protocol — v1

Ripple is an internet-free messenger. Every phone is simultaneously a BLE
**peripheral** (advertising + GATT server) and a BLE **central** (scanning +
GATT client), so any two phones in radio range form a *link*. Messages are
flooded hop-by-hop across links with a TTL and a seen-cache, and are held in a
store-and-forward queue so they can cross gaps in the mesh when a new peer
appears later (epidemic / delay-tolerant routing).

This document is the single source of truth for the byte-level format. The
Android (Kotlin) and iOS (Swift) implementations, plus the Node reference
implementation in `tools/protocol/`, all encode and decode exactly this.
Shared test vectors live in `protocol/test-vectors.json`.

All multi-byte integers are **big-endian**.

---

## 1. Identity

| Item              | Definition                                                                  |
|-------------------|-----------------------------------------------------------------------------|
| Identity key      | NIST P-256 (secp256r1) key pair, generated once per install, kept in the OS keystore/keychain. |
| Public key wire form | 65 bytes, uncompressed X9.63: `0x04 ‖ X(32) ‖ Y(32)`.                   |
| Node ID           | First **8 bytes** of `SHA-256(publicKeyWireForm)`.                          |
| Broadcast Node ID | `00 00 00 00 00 00 00 00`                                                   |
| Display form      | Node ID as 16 lowercase hex chars, grouped `xxxx-xxxx-xxxx-xxxx`.           |

The same P-256 key is used for ECDSA signing and ECDH key agreement (ECIES).
This is a deliberate simplicity trade-off; see `docs/ARCHITECTURE.md § Security`.

---

## 2. Packet

```
offset  size  field
     0     1  version        = 0x01
     1     1  type           1=ANNOUNCE  2=MESSAGE  3=ACK  4=SOS
     2     1  flags          bit0 ENCRYPTED (for MESSAGE packets; see §2.1)
     3     1  ttl            remaining hops, 0..MAX_TTL(7). Mutable in flight; values above MAX_TTL are invalid.
     4    16  messageId      128 random bits, globally unique
    20     8  source         node id of the originator
    28     8  destination    node id, or Broadcast Node ID
    36     8  timestamp      unsigned Unix time in milliseconds (big-endian)
    44     2  payloadLength  N, 0..4096
    46     N  payload
  46+N    64  signature      ECDSA P-256, raw r‖s (each 32 bytes, zero padded)
```

* `HEADER_SIZE = 46`, `SIGNATURE_SIZE = 64`, `MAX_PAYLOAD = 4096`,
  `MAX_PACKET = 46 + 4096 + 64 = 4206`.
* `timestamp` is an unsigned 64-bit big-endian Unix-millisecond value. Wire values
  with the high bit set are very distant future times, not negative timestamps;
  receivers reject them under `MAX_FUTURE_SKEW`.
* **Signature**: standard ECDSA-with-SHA-256 (Android `SHA256withECDSA`,
  CryptoKit `P256.Signing`, Node `crypto.sign('sha256', …)`) over bytes
  `[0, 46+N)` with the `ttl` byte **replaced by 0x00**. This lets relays
  decrement `ttl` without invalidating the signature. Everything else is
  immutable in flight. Signatures are randomized, so implementations are
  compared by *verifying* the vectors, not by byte equality.
* The signature is made with the **source's** identity key. Receivers verify with
  the public key from the peer table (learned via ANNOUNCE); ANNOUNCE packets
  carry their own key and are self-verifying.

### 2.1 Payloads

**ANNOUNCE (type 1)** — unencrypted, broadcast, `ttl` ≤ MAX_TTL.
```
0    65  publicKey (wire form; SHA-256 prefix must equal `source`)
65    1  nameLength L (0..64)
66    L  displayName, UTF-8
```

**MESSAGE (type 2)**
* Broadcast (destination = Broadcast ID, ENCRYPTED clear): payload is UTF-8 text.
* Direct (destination = a unicast node id, ENCRYPTED set): payload is an ECIES box, §3.

The destination and ENCRYPTED bit must agree. A broadcast MESSAGE with ENCRYPTED
set, or a unicast MESSAGE with ENCRYPTED clear, is invalid and is rejected by
packet decoders before relay or delivery. Every payload is at most `MAX_PAYLOAD`
bytes. Text limits are counted after UTF-8 encoding, not by character count. The
ECIES wire overhead is 93 bytes, so direct-message plaintext is limited to
`MAX_PAYLOAD − 93` bytes (4,003 with the current limit). Senders reject oversized
text before encryption/signing or queuing.

**ACK (type 3)** — sent by the final recipient of a *direct* MESSAGE back to its
source, flooded like any other packet.
```
0   16  acknowledgedMessageId
```
ACKs are unicast to the original source. The source accepts an ACK only while the
acknowledged message remains in its live relay store, when the ACK signature
verifies and its signer matches the destination of a locally originated direct
MESSAGE with this `messageId`; broadcasts and unknown or non-outgoing messages are
not acknowledged.

**SOS (type 4)** — an emergency beacon, broadcast mesh-wide (destination = Broadcast
ID, unencrypted, signed). Unlike ordinary traffic it is always relayed by every node
(including power-saver relays) and is retained in the relay store for up to 72 h,
subject to the bounded-store capacity. Location is **only** present when the operator
opted in to sharing GPS — nothing leaves the device otherwise.
```
0    1  flags         bit0 (0x01) HAS_LOCATION
1    1  textLength L  (0..128) UTF-8 message length
2    L  text          optional help/context text (may be empty)
2+L  4  latE7         signed int32, degrees × 10^7      (present iff HAS_LOCATION)
6+L  4  lngE7         signed int32, degrees × 10^7
10+L 2  accuracyMeters uint16 (best-effort, 0 = unknown)
```
Decoders must accept both forms and must not reject a beacon because it has no
location. `SOS_FLAG_HAS_LOCATION = 0x01`, `MAX_SOS_TEXT = 128`.

---

## 3. Direct-message encryption (ECIES)

Given recipient static public key `R`, sender generates an ephemeral P-256 key
pair `(e, E)` per message.

```
shared   = ECDH(e, R).x                      // 32-byte x-coordinate
key      = HKDF-SHA256(ikm = shared,
                       salt = messageId (16 bytes),
                       info = "ripple/v1/msg",
                       L = 32)
nonce    = 12 random bytes
aad      = messageId(16) ‖ source(8) ‖ destination(8)      // 32 bytes
ct‖tag   = AES-256-GCM(key, nonce, plaintext, aad)          // tag = 16 bytes
payload  = E (65, wire form) ‖ nonce (12) ‖ ct ‖ tag
```

The recipient recomputes `shared = ECDH(r, E).x` with its static private key.
Receivers **must** verify the outer ECDSA signature before trusting sender
identity; GCM alone authenticates only that the sender knew `R`.

---

## 4. Routing

Every node keeps:

* `selfId`, identity key.
* **Peer table**: `nodeId → (publicKey, name, lastSeen, lastHopCount)`.
* **Seen cache**: `messageId → firstSeenAt`, bounded by `MAX_SEEN` (5 000
  entries); entries expire after `SEEN_TTL` (24 h), with earlier eviction possible
  when the entry cap is reached.
* **Relay store**: recently forwarded/originated packets `messageId → (bytes,
  expiresAt, deliveredToPeers)`, bounded by `MAX_RELAY` (500 entries). An entry's
  expiry is at most `RELAY_TTL` (72 h) after first storage; capacity pressure may
  evict it earlier.
* **Links**: currently connected BLE links, each tagged with the peer's `nodeId`
  once it has been learned.

Algorithm on receiving `packet` from `link`:

1. Decode; drop if malformed, version ≠ 1, `ttl` outside `0..MAX_TTL`, a MESSAGE
   whose ENCRYPTED bit disagrees with its destination, payload > 4096, or timestamp
   more than `MAX_FUTURE_SKEW` (24 h) in the future.
2. Expire seen-cache entries older than `SEEN_TTL`. If `messageId` is still in the
   seen cache or a live relay-store entry → drop. Otherwise add it to the seen cache.
3. If type = ANNOUNCE → verify self-signature, update peer table with
   `hops = MAX_TTL − ttl + 1`, tag `link.peerNodeId` if this is the first
   packet on the link.
4. If `destination ∈ {selfId, Broadcast}` → verify signature against peer table
   (unknown source ⇒ mark *unverified*; direct messages from unknown sources are
   dropped), decrypt if needed, deliver to the app, and if it was a direct
   MESSAGE emit an ACK to the source.
5. If `destination ≠ selfId` **or** destination is Broadcast, and `ttl > 1`:
   decrement `ttl`, store in relay store, forward on **all links except `link`**.

On a **new link** becoming ready:

1. Send our ANNOUNCE (ttl = MAX_TTL).
2. Once the peer's ANNOUNCE arrives (so we know its `nodeId`), replay every
   relay-store packet not yet delivered to that peer whose destination is the
   peer, Broadcast, or unknown to us — this is the store-and-forward step.
3. If we already hold a live link to the same `nodeId`, the node with the
   **lexicographically larger** `nodeId` closes the *newer* duplicate.

Originating: build packet with `ttl = MAX_TTL`, sign, add to seen cache and
relay store, send on all links.

### 4.1 SOS beacons

SOS (type 4) packets are treated as broadcast traffic with two exceptions:

* they are **always relayed**, even by power-saver relays (see §7);
* any received beacon is surfaced to the app (and to the operator's responder
  notification) at every hop, exactly once per node via the seen cache.

### 4.2 Store-and-forward retention

Each relay-store entry has a fixed expiry of at most **72 h** (`RELAY_TTL`) after
that node first stores it, so a beacon or message can cross a gap in the mesh that
opens and closes later. Duplicate packets do not refresh the deadline; saves and
restarts preserve it. The store is capped at `MAX_RELAY` entries, so capacity
pressure can evict entries before their expiry. Relayed packets still retained are
replayed to a peer when it (re)connects (step 2 of the new-link procedure above).

---

## 5. BLE transport

### 5.1 GATT

| Item                | UUID                                     | Properties                 |
|---------------------|------------------------------------------|----------------------------|
| Mesh service        | `7E2C4B10-4B7D-4E3A-9C1F-8A2E5D6F1A01`   | primary, advertised        |
| RX characteristic   | `7E2C4B10-4B7D-4E3A-9C1F-8A2E5D6F1A02`   | write, write-no-response   |
| TX characteristic   | `7E2C4B10-4B7D-4E3A-9C1F-8A2E5D6F1A03`   | notify (+ CCCD `0x2902`)   |

Central → peripheral traffic is written to **RX**; peripheral → central traffic
is delivered as notifications on **TX**. The link is *ready* when the central
has subscribed to TX. The central requests the largest MTU it can (517 on
Android; iOS negotiates automatically) and both sides use
`min(mtu − 3, 512)` as the frame size.

### 5.2 Framing / fragmentation

A packet larger than one frame is split into fragments:

```
0   2  streamId    random per (packet, link)
2   1  index       0-based fragment index
3   1  total       number of fragments (1..255)
4   …  chunk
```

`chunkSize = frameSize − 4` and `total = max(1, ceil(packetSize / chunkSize))`.
`total` must be ≤ 255, so a link can carry at most
`min(MAX_PACKET, 255 × chunkSize)` bytes per packet; senders reject anything
larger before queuing. For a 20-byte frame the cap is 4,080 bytes; 23-byte frames
can carry the full 4,206-byte `MAX_PACKET`.

Reassembly is bounded per link: each packet is at most `MAX_PACKET`; at most
`MAX_REASSEMBLY_STREAMS` incomplete streams and
`MAX_REASSEMBLY_BYTES` aggregate fragment-payload bytes are retained. This
counts unique chunk payloads in incomplete streams, excluding frame headers and
per-stream bookkeeping. A new stream is ignored when the
active-stream cap is reached; an existing stream is discarded if adding a
fragment would exceed its packet limit or the aggregate byte budget. Streams
expire `REASSEMBLY_TTL` after their first fragment (duplicates do not extend the
deadline); expired state is purged when the next frame is processed. A
single-fragment packet still carries the 4-byte header with `index = 0, total = 1`.

---

## 6. Constants

| Name              | Value                |
|-------------------|----------------------|
| `VERSION`         | 1                    |
| `MAX_TTL`         | 7                    |
| `MAX_PAYLOAD`     | 4096                 |
| `MAX_PACKET`      | 4206 bytes            |   (header + max payload + signature)
| `MAX_NAME_BYTES`  | 64                   |
| `HKDF_INFO`       | `"ripple/v1/msg"`    |
| `MAX_SEEN`        | 5,000 entries        |   (per-node capacity)
| `SEEN_TTL`        | 24 h                 |   (duplicate suppression)
| `MAX_FUTURE_SKEW` | 24 h                 |   (accepted timestamp tolerance)
| `MAX_RELAY`       | 500 entries          |   (per-node capacity)
| `RELAY_TTL`       | 72 h                 |   (maximum retention age)
| `REASSEMBLY_TTL`  | 10 s                 |
| `MAX_REASSEMBLY_STREAMS` | 8 per link      |
| `MAX_REASSEMBLY_BYTES` | 32,768 per link    |   (fragment payload bytes)
| `MAX_SOS_TEXT`    | 128 bytes            |
| `SOS_FLAG_HAS_LOCATION` | 0x01         |

---

## 7. Rate limiting & battery profiles

### 7.1 Per-source flood cap

To stop a single node from flooding the mesh, a receiver may enforce a sliding-window
budget per source on **broadcast** MESSAGE and SOS traffic (direct, end-to-end
messages are never gated). When the budget is spent the receiver drops the packet —
it is neither delivered nor relayed. Configurable; disabled by default so the
behaviour in §4 is unchanged unless an operator opts in.

### 7.2 Battery profiles

Each node runs one of three battery profiles, which controls how aggressively it
forwards other nodes' traffic:

| Profile        | code | Relays ordinary chat | Relays SOS/ANNOUNCE |
|----------------|------|----------------------|---------------------|
| `PERFORMANCE`  | 0    | yes                  | yes                 |
| `BALANCED`     | 1    | yes                  | yes                 |
| `POWER_SAVER`  | 2    | no                   | yes                 |

A power-saver node is a *leaf* for chat (it still receives and delivers traffic
addressed to it) but continues to propagate liveness (ANNOUNCE) and safety (SOS)
traffic. This is a local policy; it changes no bytes on the wire. On the BLE
transport the profile can also widen the advertise/scan duty cycle to save battery.
The profile is orthogonal to the relay-store expiry: already-retained packets
remain eligible for replay until their fixed expiry (at most 72 h, subject to
capacity), while a power-saver node chooses not to receive-and-forward new ordinary
chat traffic.
